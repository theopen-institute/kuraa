// Import (docs/decisions/0114-importing.md): a Word document (or OpenDocument,
// RTF, EPUB, HTML) or a Scrivener project made into a folder of the
// workspace. Its host half takes the files the page sends (staged here, in
// memory, for one import: at most 1 GiB, forgotten after half an hour unused),
// converts their texts into Markdown (the host's convert: pandoc, in the host,
// no Podman), plans the folder (word.ts, scrivener.ts, plan.ts) and adds it,
// all at once (the host's create: new files only, nothing overwritten).
//
//   its routes   POST upload, run, cancel
import { defineFeature, type FeatureContext, type FeatureRequest, type FeatureResponse, type FeatureRoute, type Json } from '@kuraa/feature-kit/host';
import { writePlan, type PlannedFolder } from './plan.js';
import { planScrivener, projectFile, readProject } from './scrivener.js';
import { planWord, type Split } from './word.js';

export { planWord, splitHeader, headingsUp, plainTitle } from './word.js';
export { readProject, projectFile, itemFiles, planScrivener, withoutComments } from './scrivener.js';
export { writePlan, documentText } from './plan.js';

/** The most one import may send, and how long it is kept unused. */
const MAX_BYTES = 1024 * 1024 * 1024;
const IDLE_MS = 30 * 60_000;
/** What can be imported as one file. */
export const WORD_KINDS = ['.docx', '.odt', '.rtf', '.epub', '.html', '.htm'];

class Refused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
const answer = async (fn: () => Promise<Json>): Promise<FeatureResponse> => {
  try {
    return { body: await fn() };
  } catch (e) {
    if (e instanceof Refused) return { status: e.status, body: { message: e.message } };
    throw e;
  }
};

interface Staged {
  files: Map<string, Uint8Array>;
  bytes: number;
  touched: number;
}

const SESSION = /^[A-Za-z0-9-]{8,64}$/;
/** A path within what was sent: relative, '/'-separated, no way up. */
const cleanPath = (v: unknown): string => {
  if (typeof v !== 'string' || !v || v.length > 600) throw new Refused(400, 'path: the file’s place among what is sent');
  const p = v.replace(/\\/g, '/').replace(/^\/+/, '');
  if (p.split('/').some((part) => !part || part === '.' || part === '..')) throw new Refused(400, `Not a place a file can be: ${v}`);
  return p;
};

/** The names directly in a folder ('' the top), as the workspace's files say. */
function namesIn(all: string[], folder: string): string[] {
  const prefix = folder ? `${folder}/` : '';
  return [...new Set(all.filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length).split('/')[0]!))];
}

export const importFeature = defineFeature({
  id: 'import',
  label: 'Import',
  description: 'A Word document or a Scrivener project made into a folder of documents: Import… on a folder’s menu.',
  onByDefault: true,
  open(ctx: FeatureContext) {
    const staged = new Map<string, Staged>();
    const sweep = () => {
      const now = Date.now();
      for (const [id, s] of staged) if (now - s.touched > IDLE_MS) staged.delete(id);
    };
    const sessionOf = (v: unknown, make: boolean): Staged => {
      if (typeof v !== 'string' || !SESSION.test(v)) throw new Refused(400, 'session: which import');
      sweep();
      let s = staged.get(v);
      if (!s && make) staged.set(v, (s = { files: new Map(), bytes: 0, touched: Date.now() }));
      if (!s) throw new Refused(404, 'Nothing has been sent for this import (or it was too long ago): send it again.');
      s.touched = Date.now();
      return s;
    };

    const routes: FeatureRoute[] = [
      {
        // A file, or the next part of one (`start`: where it goes on), sent as base64.
        method: 'POST',
        path: 'upload',
        handle: (req: FeatureRequest) => answer(async () => {
          const body = (req.body ?? {}) as { session?: unknown; path?: unknown; data?: unknown; start?: unknown };
          const s = sessionOf(body.session, true);
          const path = cleanPath(body.path);
          if (typeof body.data !== 'string') throw new Refused(400, 'data: the file’s bytes, as base64');
          const part = Buffer.from(body.data, 'base64');
          const start = typeof body.start === 'number' ? body.start : 0;
          const had = s.files.get(path) ?? new Uint8Array(0);
          if (start !== had.length) throw new Refused(409, `${path}: expected the part from ${had.length}`);
          if (s.bytes + part.length > MAX_BYTES) throw new Refused(413, 'That is more than 1 GB, the most one import may send.');
          const joined = new Uint8Array(had.length + part.length);
          joined.set(had);
          joined.set(part, had.length);
          s.files.set(path, joined);
          s.bytes += part.length;
          return { path, size: joined.length };
        }),
      },
      {
        method: 'POST',
        path: 'cancel',
        handle: (req: FeatureRequest) => answer(async () => {
          const id = (req.body as { session?: unknown } | undefined)?.session;
          if (typeof id === 'string') staged.delete(id);
          return {};
        }),
      },
      {
        // What was sent, made into a folder in `into` ('' the top).
        method: 'POST',
        path: 'run',
        handle: (req: FeatureRequest) => answer(async () => {
          const body = (req.body ?? {}) as { session?: unknown; kind?: unknown; into?: unknown; name?: unknown; split?: unknown; snapshots?: unknown };
          const s = sessionOf(body.session, false);
          const into = typeof body.into === 'string' ? body.into.replace(/^\/+|\/+$/g, '') : '';
          const all = await ctx.list();
          if (into && !all.some((p) => p.startsWith(`${into}/`))) throw new Refused(404, `No folder ${into}`);
          const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim().slice(0, 200) : 'Imported';
          let folder: PlannedFolder;
          let left: string[] = [];
          if (body.kind === 'word') {
            const [file, bytes] = [...s.files][0] ?? [];
            if (!file || !bytes) throw new Refused(400, 'Nothing was sent to import.');
            const ext = file.slice(file.lastIndexOf('.')).toLowerCase();
            if (!WORD_KINDS.includes(ext)) throw new Refused(400, `${file} is not a kind of file that can be imported (Word, OpenDocument, RTF, EPUB or HTML).`);
            const r = await ctx.convert(file, bytes);
            if (!r.ok) throw new Refused(422, r.message);
            const split: Split = body.split === 'sections' || body.split === 'none' ? body.split : 'chapters';
            folder = planWord(r.markdown, name, split, r.media);
          } else if (body.kind === 'scrivener') {
            const file = projectFile([...s.files.keys()], name);
            if (!file) throw new Refused(400, 'This is not a Scrivener project: it has no .scrivx file.');
            let project;
            try {
              project = readProject(new TextDecoder().decode(s.files.get(file)));
            } catch (e) {
              throw new Refused(422, `${file} could not be read: ${(e as Error).message}`);
            }
            const plan = await planScrivener(project, name, s.files, (n, b) => ctx.convert(n, b), { snapshots: body.snapshots === true });
            folder = plan.folder;
            left = plan.left;
          } else throw new Refused(400, 'kind: word or scrivener');
          const written = writePlan(folder, into, namesIn(all, into));
          const { skipped } = await ctx.create(written.files, { message: `Import ${name} into ${into ? `${into}/` : 'the top level'}`, by: req.person });
          staged.delete(body.session as string);
          for (const k of skipped) left.push(`${k.path}: ${k.why}`);
          return {
            folder: written.root,
            first: written.first,
            documents: written.documents,
            folders: written.folders,
            images: written.images - skipped.length,
            others: written.others,
            left,
          };
        }),
      },
    ];
    return { routes, close: () => staged.clear() };
  },
});
