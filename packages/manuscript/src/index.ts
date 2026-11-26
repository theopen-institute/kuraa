// The manuscript (docs/decisions/0091-order-and-manuscripts-over-folders.md):
// a folder marked as one, whose documents, in the folder's order, make a book;
// any of them left out. Its host half: the workspace's manuscripts, read from
// their files; folders made manuscripts and unmade; documents and folders left
// out and put back; renames and deletions followed.
//
//   its routes   GET manuscripts; POST make, unmake, include
//   it writes    files named .kuraa-manuscript.yml (`names`), in their folders
import { defineFeature, type FeatureContext, type FeatureRequest, type FeatureResponse, type FeatureRoute, type Json, type Person } from '@kuraa/feature-kit/host';
import { afterDelete, afterRename, isBookDocument, MANUSCRIPT_FILE, manuscriptFileOf, manuscriptFolder, readManuscript, titleOf, within, withIncluded, writeManuscript, type Manuscript } from './manuscript.js';

export { MANUSCRIPT_FILE, readManuscript, writeManuscript, type Manuscript } from './manuscript.js';

/** Every manuscript in the workspace, by folder. */
async function manuscripts(ctx: FeatureContext): Promise<Manuscript[]> {
  const out: Manuscript[] = [];
  for (const p of (await ctx.list()).sort()) {
    const folder = manuscriptFolder(p);
    if (folder === null) continue;
    const text = await ctx.read(p);
    if (text !== null) out.push(readManuscript(folder, text));
  }
  return out;
}

class Refused extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

/** A folder as the routes take it: '' for the top, else ending in `/`. */
function folderArg(v: unknown): string {
  if (typeof v !== 'string') throw new Refused(400, 'folder: the folder');
  const f = v.trim().replace(/^\/+|\/+$/g, '');
  if (f.split('/').some((s) => s === '..' || s === '.')) throw new Refused(400, 'folder: a folder of the workspace');
  return f ? `${f}/` : '';
}

const by = (req: FeatureRequest): { by?: Person | null } => ({ by: req.person });
const answer = async (fn: () => Promise<Json>): Promise<FeatureResponse> => {
  try {
    return { body: await fn() };
  } catch (e) {
    if (e instanceof Refused) return { status: e.status, body: { message: e.message } };
    throw e;
  }
};

export const manuscriptFeature = defineFeature({
  id: 'manuscript',
  label: 'Manuscript',
  description: 'Make a folder a manuscript: its documents, in the folder’s order, make one book; leave any of them out.',
  names: [MANUSCRIPT_FILE],
  describe: ({ path, before, after }) => {
    const folder = manuscriptFolder(path);
    if (folder === null) return null;
    const where = folder || 'the top level';
    if (before === null) return `Make ${where} a manuscript`;
    if (after === null) return `${where} is no longer a manuscript`;
    return `Change what the manuscript ${where} leaves out`;
  },
  open(ctx) {
    const save = async (m: Manuscript, o: { by?: Person | null } = {}) => {
      await ctx.write(manuscriptFileOf(m.folder), writeManuscript(m), o);
      ctx.tell({ changed: m.folder });
    };
    const routes: FeatureRoute[] = [
      {
        method: 'GET',
        path: 'manuscripts',
        handle: () => answer(async () => ({ manuscripts: (await manuscripts(ctx)).map((m) => ({ ...m, name: titleOf(m) })) })),
      },
      {
        // A folder made a manuscript: not one in another, nor one around another.
        method: 'POST',
        path: 'make',
        handle: (req) => answer(async () => {
          const body = (req.body ?? {}) as { folder?: unknown; title?: unknown };
          const folder = folderArg(body.folder);
          const all = await manuscripts(ctx);
          const clash = all.find((m) => folder.startsWith(m.folder) || m.folder.startsWith(folder));
          if (clash) throw new Refused(409, clash.folder === folder ? `${folder || 'The top level'} is a manuscript already` : `${clash.folder || 'The top level'} is a manuscript: one manuscript cannot be inside another`);
          if (folder && !(await ctx.list()).some((p) => p.startsWith(folder))) throw new Refused(404, `No folder ${folder}`);
          const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim() : null;
          await save({ folder, title, exclude: [] }, by(req));
          return { folder };
        }),
      },
      {
        method: 'POST',
        path: 'unmake',
        handle: (req) => answer(async () => {
          const folder = folderArg((req.body as { folder?: unknown } | undefined)?.folder);
          if (!(await manuscripts(ctx)).some((m) => m.folder === folder)) throw new Refused(404, `${folder || 'The top level'} is not a manuscript`);
          await ctx.write(manuscriptFileOf(folder), null, by(req));
          ctx.tell({ changed: folder });
          return { folder };
        }),
      },
      {
        // A document or folder of a manuscript left out of it, or put back in.
        method: 'POST',
        path: 'include',
        handle: (req) => answer(async () => {
          const body = (req.body ?? {}) as { path?: unknown; include?: unknown };
          if (typeof body.path !== 'string' || typeof body.include !== 'boolean') throw new Refused(400, 'path and include: what, and whether it is in');
          const path = body.path.replace(/\/+$/, '');
          const m = (await manuscripts(ctx)).find((x) => within(x, path));
          if (!m) throw new Refused(404, `${path} is in no manuscript`);
          const files = await ctx.list();
          const isFolder = files.some((p) => p.startsWith(`${path}/`));
          if (!isFolder && !isBookDocument(path)) throw new Refused(400, `${path} is not a document a book is made of`);
          await save(withIncluded(m, path, body.include), by(req));
          return { folder: m.folder };
        }),
      },
    ];

    // What it left out follows renames and deletions.
    const follow = async (change: (m: Manuscript) => Manuscript | null) => {
      for (const m of await manuscripts(ctx)) {
        const next = change(m);
        if (next) await save(next).catch((e) => ctx.log(`could not follow a change into the manuscript ${m.folder}: ${(e as Error).message}`));
      }
    };
    const stops = [
      ctx.on('rename', ({ from, to }) => {
        void follow((m) => afterRename(m, from, to)).then(() => ctx.tell({ changed: '' }));
      }),
      ctx.on('delete', ({ path }) => {
        void follow((m) => afterDelete(m, path)).then(() => ctx.tell({ changed: '' }));
      }),
      ctx.on('merge', ({ paths }) => {
        if (paths.some((p) => manuscriptFolder(p) !== null)) ctx.tell({ changed: '' });
      }),
    ];
    return { routes, close: () => stops.forEach((s) => s()) };
  },
});
