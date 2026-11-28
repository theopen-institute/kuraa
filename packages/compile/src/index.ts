// Compile (docs/decisions/0093-order-and-compile-over-folders.md, 0106): any
// folder compiled into one book, its documents in the file tree's order, by
// the host's render; any document or folder left out. Its host half keeps what
// Compile knows of each folder (a `.kuraa-compile.yml` in it: the book's title,
// format and settings, and what in it is left out), and follows renames and
// deletions. It joins a folder's documents into one (./compiling.ts, 0126),
// which the core renders as it renders a document (a folder's path ending in
// `/`: renders.ts), keeping its outputs; the panel that asks for it is the
// client half's.
//
//   its routes   GET folders, files, contents; POST include, settings, heading, titles, target
//   it writes    files named .kuraa-compile.yml (`names`), in their folders
import { defineFeature, type FeatureContext, type FeatureRequest, type FeatureResponse, type FeatureRoute, type Json, type Person } from '@kuraa/feature-kit/host';
import { bookContents, compileFolder as compileFolderBook } from './compiling.js';
import { afterDelete, afterRename, COMPILE_FILE, compileFileOf, compileFolder, emptyCompile as empty, FORMATS, isBookDocument, isCoverImage, isTemplate, NUMBERINGS, readCompile, withIncluded, writeCompile, type CompileFormat, type FolderCompile, type Numbering } from './settings.js';

export { COMPILE_FILE, emptyCompile, readCompile, writeCompile, type FolderCompile } from './settings.js';
export type { BookContent, CompileRequest } from './compiling.js';

/** What Compile knows of each folder that says anything, by folder. */
async function folders(ctx: FeatureContext): Promise<Map<string, FolderCompile>> {
  const out = new Map<string, FolderCompile>();
  for (const p of (await ctx.list()).sort()) {
    const folder = compileFolder(p);
    if (folder === null) continue;
    const text = await ctx.read(p);
    if (text !== null) out.set(folder, readCompile(folder, text));
  }
  return out;
}

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

const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

export const compileFeature = defineFeature({
  id: 'compile',
  label: 'Compile',
  description: 'Any folder compiled into one book (Word, PDF, HTML or EPUB), its documents in the file tree’s order; any of them left out.',
  onByDefault: true,
  names: [COMPILE_FILE],
  describe: ({ path, before, after }) => {
    const folder = compileFolder(path);
    if (folder === null) return null;
    const where = folder ? `${folder}/` : 'the top level';
    const was = before === null ? empty(folder) : readCompile(folder, before);
    const now = after === null ? empty(folder) : readCompile(folder, after);
    const out = now.exclude.filter((n) => !was.exclude.includes(n));
    const back = was.exclude.filter((n) => !now.exclude.includes(n));
    if (out.length && !back.length) return `Leave ${out.join(', ')} in ${where} out of Compile`;
    if (back.length && !out.length) return `Put ${back.join(', ')} in ${where} back in Compile`;
    if (was.heading !== now.heading && !out.length && !back.length) return now.heading ? `A heading for ${where} in Compile` : `No heading for ${where} in Compile`;
    if (was.target !== now.target && !out.length && !back.length) return now.target ? `A target of ${now.target.toLocaleString('en')} words for ${where}` : `No target for ${where}`;
    if (was.titles !== now.titles && !out.length && !back.length) return now.titles ? `Titles for the documents in ${where} in Compile` : `No titles for the documents in ${where} in Compile`;
    return `Compile settings for ${where}`;
  },
  open(ctx) {
    const save = async (c: FolderCompile, by?: Person | null) => {
      await ctx.write(compileFileOf(c.folder), writeCompile(c), { by });
    };
    // One change at a time: each reads a folder's settings, changes them and writes them, and two at once would lose one.
    let last: Promise<unknown> = Promise.resolve();
    const one = <T>(fn: () => Promise<T>): Promise<T> => {
      const next = last.then(fn, fn);
      last = next.catch(() => undefined);
      return next;
    };
    const routes: FeatureRoute[] = [
      {
        method: 'GET',
        path: 'folders',
        handle: () => answer(async () => ({ folders: [...(await folders(ctx)).values()] as unknown as Json })),
      },
      {
        // A document or folder left out of compiles, or put back in.
        method: 'POST',
        path: 'include',
        handle: (req: FeatureRequest) => one(() => answer(async () => {
          const body = (req.body ?? {}) as { path?: unknown; include?: unknown };
          if (typeof body.path !== 'string' || !body.path.replace(/\/+$/, '') || typeof body.include !== 'boolean') throw new Refused(400, 'path and include: what, and whether it is in');
          const path = body.path.replace(/\/+$/, '');
          const files = await ctx.list();
          const isFolder = files.some((p) => p.startsWith(`${path}/`));
          if (!isFolder && !files.includes(path)) throw new Refused(404, `No ${path}`);
          if (!isFolder && !isBookDocument(ctx.typeOf(path))) throw new Refused(400, `${path} is not a document a book is made of`);
          const all = await folders(ctx);
          const folder = folderOf(path);
          await save(withIncluded(all.get(folder) ?? empty(folder), nameOf(path), body.include), req.person);
          ctx.tell({ changed: folder });
          return { path };
        })),
      },
      {
        // The book's title and format, as it was last compiled, and its settings (0106): what the body names changes.
        method: 'POST',
        path: 'settings',
        handle: (req: FeatureRequest) => one(() => answer(async () => {
          const body = (req.body ?? {}) as Record<string, unknown>;
          if (typeof body.folder !== 'string') throw new Refused(400, 'folder: the folder');
          const folder = body.folder.replace(/^\/+|\/+$/g, '');
          const files = await ctx.list();
          if (folder && !files.some((p) => p.startsWith(`${folder}/`))) throw new Refused(404, `No folder ${folder}`);
          const text = (v: unknown, most = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, most) : null);
          const file = (v: unknown, kind: (p: string) => boolean, what: string) => {
            const p = text(v, 1000)?.replace(/^\/+/, '') ?? null;
            if (p && (!kind(p) || !files.includes(p))) throw new Refused(400, `${p} is not ${what} in the workspace`);
            return p;
          };
          const was = (await folders(ctx)).get(folder) ?? empty(folder);
          const now: FolderCompile = { ...was };
          if ('title' in body) now.title = text(body.title);
          if ('format' in body) now.format = FORMATS.includes(body.format as CompileFormat) ? (body.format as CompileFormat) : null;
          if ('subtitle' in body) now.subtitle = text(body.subtitle);
          if ('author' in body) now.author = text(body.author);
          if ('toc' in body) now.toc = body.toc === true;
          if ('numbering' in body) now.numbering = NUMBERINGS.includes(body.numbering as Numbering) ? (body.numbering as Numbering) : null;
          if ('separator' in body) now.separator = text(body.separator, 100);
          if ('referenceDoc' in body) now.referenceDoc = file(body.referenceDoc, isTemplate, 'a Word document');
          if ('cover' in body) now.cover = file(body.cover, isCoverImage, 'an image');
          if (writeCompile(now) !== writeCompile(was)) {
            await save(now, req.person);
            ctx.tell({ changed: folder });
          }
          return { folder };
        })),
      },
      {
        // What a folder's book could have (0093): its folders and documents in the file tree's order, each at its depth, with its words.
        method: 'GET',
        path: 'contents',
        handle: (req: FeatureRequest) => answer(async () => {
          const folder = (req.query.get('folder') ?? '').replace(/^\/+|\/+$/g, '');
          if (folder.split('/').some((s) => s === '..')) throw new Refused(400, 'folder: a folder of the workspace');
          if (folder && !(await ctx.list()).some((p) => p.startsWith(`${folder}/`))) throw new Refused(404, `No folder ${folder}`);
          return { items: (await bookContents(ctx, folder)) as unknown as Json };
        }),
      },
      {
        // What a book may take as its Word template or its cover (0106): the workspace's Word documents and images.
        method: 'GET',
        path: 'files',
        handle: () => answer(async () => {
          const files = (await ctx.list()).sort();
          return { templates: files.filter(isTemplate), images: files.filter(isCoverImage) };
        }),
      },
      {
        // The book's target in words (0094); none: null.
        method: 'POST',
        path: 'target',
        handle: (req: FeatureRequest) => one(() => answer(async () => {
          const body = (req.body ?? {}) as { folder?: unknown; target?: unknown };
          if (typeof body.folder !== 'string' || !(body.target === null || (typeof body.target === 'number' && body.target >= 1))) throw new Refused(400, 'folder and target: which folder, and its words (or null)');
          const folder = body.folder.replace(/^\/+|\/+$/g, '');
          if (folder && !(await ctx.list()).some((p) => p.startsWith(`${folder}/`))) throw new Refused(404, `No folder ${folder}`);
          const target = body.target === null ? null : Math.round(body.target);
          const was = (await folders(ctx)).get(folder) ?? empty(folder);
          if (was.target !== target) {
            await save({ ...was, target }, req.person);
            ctx.tell({ changed: folder });
          }
          return { folder };
        })),
      },
      {
        // A folder's name a heading where it is compiled inside another, or not.
        method: 'POST',
        path: 'heading',
        handle: (req: FeatureRequest) => one(() => answer(async () => {
          const body = (req.body ?? {}) as { folder?: unknown; heading?: unknown };
          if (typeof body.folder !== 'string' || !body.folder.replace(/^\/+|\/+$/g, '') || typeof body.heading !== 'boolean') throw new Refused(400, 'folder and heading: which folder, and whether its name is a heading');
          const folder = body.folder.replace(/^\/+|\/+$/g, '');
          if (!(await ctx.list()).some((p) => p.startsWith(`${folder}/`))) throw new Refused(404, `No folder ${folder}`);
          const was = (await folders(ctx)).get(folder) ?? empty(folder);
          if (was.heading !== body.heading) {
            await save({ ...was, heading: body.heading }, req.person);
            ctx.tell({ changed: folder });
          }
          return { folder };
        })),
      },
      {
        // A folder's documents' titles headings in Compile, or not (0106); the top level ('') a folder too.
        method: 'POST',
        path: 'titles',
        handle: (req: FeatureRequest) => one(() => answer(async () => {
          const body = (req.body ?? {}) as { folder?: unknown; titles?: unknown };
          if (typeof body.folder !== 'string' || typeof body.titles !== 'boolean') throw new Refused(400, 'folder and titles: which folder, and whether its documents’ titles are headings');
          const folder = body.folder.replace(/^\/+|\/+$/g, '');
          if (folder && !(await ctx.list()).some((p) => p.startsWith(`${folder}/`))) throw new Refused(404, `No folder ${folder}`);
          const was = (await folders(ctx)).get(folder) ?? empty(folder);
          if (was.titles !== body.titles) {
            await save({ ...was, titles: body.titles }, req.person);
            ctx.tell({ changed: folder });
          }
          return { folder };
        })),
      },
    ];

    // What is left out stays left out when it is renamed or moved, and is forgotten when it is deleted; so is a book's template or cover (0106).
    const follow = (change: (all: Map<string, FolderCompile>) => FolderCompile[]) => one(async () => {
      for (const c of change(await folders(ctx))) await save(c).catch((e) => ctx.log(`could not follow a change into Compile’s ${compileFileOf(c.folder)}: ${(e as Error).message}`));
      ctx.tell({ changed: '' });
    });
    const stops = [
      ctx.on('rename', ({ from, to }) => void follow((all) => afterRename(all, from, to))),
      ctx.on('delete', ({ path }) => void follow((all) => afterDelete(all, path))),
      ctx.on('merge', ({ paths }) => {
        if (paths.some((p) => compileFolder(p) !== null)) ctx.tell({ changed: '' });
      }),
    ];
    return {
      routes,
      // A folder's documents joined, for the core to render (0126).
      compileFolder: (folder: string, request: Json, format: string) => compileFolderBook(ctx, folder, request, format),
      close: () => stops.forEach((s) => s()),
    };
  },
});
