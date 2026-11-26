// Compile (docs/decisions/0091-order-and-compile-over-folders.md): any
// folder compiled into one book, its documents in the file tree's order, by
// the host's render; any document or folder left out. Its host half keeps what
// Compile knows of each folder (a `.kuraa-compile.yml` in it: the book's title
// and format, and what in it is left out), and follows renames and deletions.
// The compiling is the core's (a folder rendered: renders.ts); the panel that
// asks for it is the client half's.
//
//   its routes   GET folders; POST include, settings, heading
//   it writes    files named .kuraa-compile.yml (`names`), in their folders
import { defineFeature, type FeatureContext, type FeatureRequest, type FeatureResponse, type FeatureRoute, type Json, type Person } from '@kuraa/feature-kit/host';
import { afterDelete, afterRename, COMPILE_FILE, compileFileOf, compileFolder, FORMATS, isBookDocument, readCompile, withIncluded, writeCompile, type CompileFormat, type FolderCompile } from './settings.js';

export { COMPILE_FILE, readCompile, writeCompile, type FolderCompile } from './settings.js';

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
const empty = (folder: string): FolderCompile => ({ folder, title: null, format: null, heading: true, exclude: [] });

export const compileFeature = defineFeature({
  id: 'compile',
  label: 'Compile',
  description: 'Any folder compiled into one book (Word, PDF or HTML), its documents in the file tree’s order; any of them left out.',
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
    return `Compile settings for ${where}`;
  },
  open(ctx) {
    const save = async (c: FolderCompile, by?: Person | null) => {
      await ctx.write(compileFileOf(c.folder), writeCompile(c), { by });
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
        handle: (req: FeatureRequest) => answer(async () => {
          const body = (req.body ?? {}) as { path?: unknown; include?: unknown };
          if (typeof body.path !== 'string' || !body.path.replace(/\/+$/, '') || typeof body.include !== 'boolean') throw new Refused(400, 'path and include: what, and whether it is in');
          const path = body.path.replace(/\/+$/, '');
          const files = await ctx.list();
          const isFolder = files.some((p) => p.startsWith(`${path}/`));
          if (!isFolder && !files.includes(path)) throw new Refused(404, `No ${path}`);
          if (!isFolder && !isBookDocument(path)) throw new Refused(400, `${path} is not a document a book is made of`);
          const all = await folders(ctx);
          const folder = folderOf(path);
          await save(withIncluded(all.get(folder) ?? empty(folder), nameOf(path), body.include), req.person);
          ctx.tell({ changed: folder });
          return { path };
        }),
      },
      {
        // The book's title and format, as it was last compiled.
        method: 'POST',
        path: 'settings',
        handle: (req: FeatureRequest) => answer(async () => {
          const body = (req.body ?? {}) as { folder?: unknown; title?: unknown; format?: unknown };
          if (typeof body.folder !== 'string') throw new Refused(400, 'folder: the folder');
          const folder = body.folder.replace(/^\/+|\/+$/g, '');
          if (folder && !(await ctx.list()).some((p) => p.startsWith(`${folder}/`))) throw new Refused(404, `No folder ${folder}`);
          const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 300) : null;
          const format = FORMATS.includes(body.format as CompileFormat) ? (body.format as CompileFormat) : null;
          const was = (await folders(ctx)).get(folder) ?? empty(folder);
          if (was.title !== title || was.format !== format) {
            await save({ ...was, title, format }, req.person);
            ctx.tell({ changed: folder });
          }
          return { folder };
        }),
      },
      {
        // A folder's name a heading where it is compiled inside another, or not.
        method: 'POST',
        path: 'heading',
        handle: (req: FeatureRequest) => answer(async () => {
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
        }),
      },
    ];

    // What is left out stays left out when it is renamed or moved, and is forgotten when it is deleted.
    const follow = async (change: (all: Map<string, FolderCompile>) => FolderCompile[]) => {
      for (const c of change(await folders(ctx))) await save(c).catch((e) => ctx.log(`could not follow a change into Compile’s ${compileFileOf(c.folder)}: ${(e as Error).message}`));
      ctx.tell({ changed: '' });
    };
    const stops = [
      ctx.on('rename', ({ from, to }) => void follow((all) => afterRename(all, from, to))),
      ctx.on('delete', ({ path }) => void follow((all) => afterDelete(all, path))),
      ctx.on('merge', ({ paths }) => {
        if (paths.some((p) => compileFolder(p) !== null)) ctx.tell({ changed: '' });
      }),
    ];
    return { routes, close: () => stops.forEach((s) => s()) };
  },
});
