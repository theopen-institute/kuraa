// The manuscript (docs/decisions/0088-a-manuscript-is-a-quarto-book.md): documents
// in an order of the writer's choosing, kept as a Quarto book's chapters in its
// folder's `_quarto.yml`. Its host half: the manuscripts of the workspace, read
// from their files; their order changed, documents added and taken out, a
// folder made a manuscript (each written to its `_quarto.yml`, committed as
// whoever asked); and renames and deletions followed, so a chapter renamed is
// renamed in its book. Its client half (./client) is a navigation view.
//
//   its routes   GET manuscripts; POST order, add, remove, make
//   it writes    files named _quarto.yml, wherever they are (`names`), never while one is open
import { defineFeature, type FeatureContext, type FeatureRequest, type FeatureResponse, type FeatureRoute, type Json, type Person } from '@kuraa/feature-kit/host';
import { BOOK_FILE, deleted, folderOfBook, isBookDocument, mapPaths, newBook, pathsOf, readBook, renamed, writeBook, type Entry, type Manuscript } from './book.js';

export { BOOK_FILE, readBook, writeBook, newBook, type Entry, type Manuscript } from './book.js';

/** Every manuscript in the workspace: each `_quarto.yml` that makes a book, with its file. */
async function manuscripts(ctx: FeatureContext): Promise<(Manuscript & { file: string; text: string })[]> {
  const files = (await ctx.list()).filter((p) => p === BOOK_FILE || p.endsWith(`/${BOOK_FILE}`)).sort();
  const out: (Manuscript & { file: string; text: string })[] = [];
  for (const file of files) {
    const text = await ctx.read(file);
    const m = text === null ? null : readBook(file, text);
    if (m && text !== null) out.push({ ...m, file, text });
  }
  return out;
}

const bad = (message: string): FeatureResponse => ({ status: 400, body: { message } });
const isText = (v: unknown): v is string => typeof v === 'string';
const asEntries = (v: unknown): Entry[] | null => {
  if (!Array.isArray(v)) return null;
  const out: Entry[] = [];
  for (const e of v) {
    if (e && typeof e === 'object' && isText((e as { chapter?: unknown }).chapter)) out.push({ chapter: (e as { chapter: string }).chapter });
    else if (e && typeof e === 'object' && isText((e as { part?: unknown }).part) && Array.isArray((e as { chapters?: unknown }).chapters) && (e as { chapters: unknown[] }).chapters.every(isText)) out.push({ part: (e as { part: string }).part, chapters: (e as { chapters: string[] }).chapters });
    else return null;
  }
  return out;
};

/** What the client is given of a manuscript. */
const shown = (m: Manuscript & { file: string }): Json => ({ folder: m.folder, file: m.file, title: m.title, chapters: m.chapters as unknown as Json, appendices: m.appendices });

export const manuscriptFeature = defineFeature({
  id: 'manuscript',
  label: 'Manuscript',
  description: 'Documents in an order of your choosing, kept as a Quarto book’s chapters in its folder’s _quarto.yml.',
  names: [BOOK_FILE],
  open(ctx) {
    /** Write a manuscript's new order to its file, as whoever asked; and tell the clients. */
    const save = async (m: Manuscript & { file: string; text: string }, next: Pick<Manuscript, 'chapters' | 'appendices'>, by: Person | null) => {
      const text = writeBook(m.text, { folder: m.folder, ...next });
      if (text === m.text) return;
      await ctx.write(m.file, text, { by });
      ctx.tell({ changed: m.file });
    };
    /** The manuscript a document is in: the nearest folder up that has one. */
    const bookOf = (all: Manuscript[], path: string) => all.filter((m) => path.startsWith(m.folder)).sort((a, b) => b.folder.length - a.folder.length)[0];
    const fail = (e: unknown): FeatureResponse => ({ status: (e as { status?: number }).status ?? 500, body: { message: (e as Error).message } });

    const routes: FeatureRoute[] = [
      {
        method: 'GET',
        path: 'manuscripts',
        handle: async (): Promise<FeatureResponse> => ({ body: { manuscripts: (await manuscripts(ctx)).map(shown) } }),
      },
      {
        // The whole order, as the view has it after a drag.
        method: 'POST',
        path: 'order',
        handle: async (req: FeatureRequest): Promise<FeatureResponse> => {
          const b = (req.body ?? {}) as { file?: unknown; chapters?: unknown; appendices?: unknown };
          const chapters = asEntries(b.chapters);
          if (!isText(b.file) || !chapters || !Array.isArray(b.appendices) || !b.appendices.every(isText)) return bad('An order is a manuscript’s file, its chapters and its appendices');
          const m = (await manuscripts(ctx)).find((x) => x.file === b.file);
          if (!m) return { status: 404, body: { message: `No manuscript in ${b.file}` } };
          // Only its own folder's documents.
          const outside = pathsOf({ chapters, appendices: b.appendices }).find((p) => !p.startsWith(m.folder) || !isBookDocument(p));
          if (outside) return bad(`${outside} is not a document in ${m.folder || 'the workspace'}`);
          try {
            await save(m, { chapters, appendices: b.appendices }, req.person);
          } catch (e) {
            return fail(e);
          }
          return { body: { ok: true } };
        },
      },
      {
        // A document added at the end of the manuscript it is in (or a given one).
        method: 'POST',
        path: 'add',
        handle: async (req: FeatureRequest): Promise<FeatureResponse> => {
          const b = (req.body ?? {}) as { path?: unknown };
          if (!isText(b.path) || !isBookDocument(b.path)) return bad('A document is added to a manuscript');
          const m = bookOf(await manuscripts(ctx), b.path) as (Manuscript & { file: string; text: string }) | undefined;
          if (!m) return { status: 404, body: { message: `${b.path} is not in a manuscript’s folder` } };
          if (pathsOf(m).includes(b.path)) return { body: { ok: true } };
          try {
            await save(m, { chapters: [...m.chapters, { chapter: b.path }], appendices: m.appendices }, req.person);
          } catch (e) {
            return fail(e);
          }
          return { body: { ok: true } };
        },
      },
      {
        // A document taken out of its manuscript (the file stays).
        method: 'POST',
        path: 'remove',
        handle: async (req: FeatureRequest): Promise<FeatureResponse> => {
          const b = (req.body ?? {}) as { path?: unknown };
          if (!isText(b.path)) return bad('A document is taken out of a manuscript');
          const m = bookOf(await manuscripts(ctx), b.path) as (Manuscript & { file: string; text: string }) | undefined;
          if (!m || !pathsOf(m).includes(b.path)) return { body: { ok: true } };
          try {
            await save(m, mapPaths(m, deleted(b.path, false)), req.person);
          } catch (e) {
            return fail(e);
          }
          return { body: { ok: true } };
        },
      },
      {
        // A folder made a manuscript: its documents its chapters, in the order of their paths.
        method: 'POST',
        path: 'make',
        handle: async (req: FeatureRequest): Promise<FeatureResponse> => {
          const b = (req.body ?? {}) as { folder?: unknown; title?: unknown };
          if (!isText(b.folder)) return bad('A folder is made a manuscript');
          const folder = b.folder.replace(/\/*$/, '/').replace(/^\/$/, '');
          const file = `${folder}${BOOK_FILE}`;
          if ((await ctx.read(file)) !== null) return { status: 409, body: { message: `${file} is there already` } };
          const docs = (await ctx.list()).filter((p) => p.startsWith(folder) && isBookDocument(p) && !p.split('/').some((s) => s.startsWith('.') || s.startsWith('_'))).sort();
          const title = isText(b.title) && b.title.trim() ? b.title.trim() : folder.replace(/\/$/, '').split('/').pop() || 'Manuscript';
          try {
            await ctx.write(file, newBook(folder, title, docs), { by: req.person });
          } catch (e) {
            return fail(e);
          }
          ctx.tell({ changed: file });
          return { body: { file } };
        },
      },
    ];

    // A chapter renamed or moved here is renamed in its book; one deleted is taken out (0088).
    const follow = async (to: (p: string) => string | null) => {
      for (const m of await manuscripts(ctx)) {
        const next = mapPaths(m, to);
        if (JSON.stringify(next) === JSON.stringify(m)) continue;
        try {
          await save(m, next, null);
        } catch (e) {
          ctx.log(`could not follow a change in ${m.file}: ${(e as Error).message}`);
        }
      }
    };
    const stops = [
      ctx.on('rename', ({ from, to, folder }) => follow(renamed(from, to, folder))),
      ctx.on('delete', ({ path, folder }) => follow(deleted(path, folder))),
      // A book changed elsewhere (another device, the online copy): the views ask again.
      ctx.on('merge', ({ paths }) => {
        const books = paths.filter((p) => p === BOOK_FILE || p.endsWith(`/${BOOK_FILE}`));
        if (books.length) ctx.tell({ changed: books[0]! });
      }),
    ];
    return { routes, close: () => stops.forEach((s) => s()) };
  },
});

export { folderOfBook };
