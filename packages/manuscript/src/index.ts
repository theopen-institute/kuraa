// The manuscript (docs/decisions/0088-a-manuscript-is-a-quarto-book.md, as revised
// by 0090-manuscripts-apart-from-folders.md): documents in an order of the
// writer's choosing, kept as a Quarto book. Its host half: the workspace's
// manuscripts, read from their files; their order changed, documents added and
// taken out (a document may be in several), new ones made, each with a home
// folder where its new chapters go; renames and deletions followed.
//
//   its routes   GET manuscripts; POST order, add, remove, make, home
//   it writes    files named _quarto.yml and _quarto-*.yml (`names`), never while
//                one is open; .kuraa/manuscripts.json (the home folders)
import { defineFeature, type FeatureContext, type FeatureRequest, type FeatureResponse, type FeatureRoute, type Json, type Person } from '@kuraa/feature-kit/host';
import {
  BOOK_FILE, BOOK_NAMES, PROFILE, deleted, folderOfBook, hasChapters, isBook, isBookDocument, mapPaths, newBook, newProfileBook,
  pathsOf, profileName, profilesOf, readBook, renamed, withProfiles, writeBook, type Entry, type Manuscript,
} from './book.js';

export { BOOK_FILE, readBook, writeBook, newBook, type Entry, type Manuscript } from './book.js';

/** Where each manuscript's new chapters go, by its file: Kuraa's, not Quarto's. */
export const HOMES_FILE = '.kuraa/manuscripts.json';

type Known = Manuscript & { text: string; home: string | null };

const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

async function readHomes(ctx: FeatureContext): Promise<Record<string, string>> {
  try {
    const v = JSON.parse((await ctx.read(HOMES_FILE)) ?? '{}') as { homes?: Record<string, unknown> };
    return Object.fromEntries(Object.entries(v.homes ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string'));
  } catch {
    return {};
  }
}

const stable = (homes: Record<string, string>) => `${JSON.stringify({ homes: Object.fromEntries(Object.entries(homes).sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`;

/**
 * Every manuscript in the workspace: each book project's `_quarto.yml` with a
 * chapter list of its own, and each profile's book beside one.
 */
async function manuscripts(ctx: FeatureContext): Promise<Known[]> {
  const all = await ctx.list();
  const homes = await readHomes(ctx);
  const out: Known[] = [];
  for (const base of all.filter((p) => nameOf(p) === BOOK_FILE).sort()) {
    const text = await ctx.read(base);
    if (text === null || !isBook(text)) continue;
    const folder = folderOfBook(base);
    if (hasChapters(text)) {
      const m = readBook(base, text);
      if (m) out.push({ ...m, text, home: homes[base] ?? folder });
    }
    for (const p of all.filter((x) => folderOfBook(x) === folder && PROFILE.test(nameOf(x))).sort()) {
      const t = await ctx.read(p);
      const m = t === null ? null : readBook(p, t, text);
      if (m && t !== null) out.push({ ...m, text: t, home: homes[p] ?? null });
    }
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
/** A folder as the routes take it: '' for the top, else ending in `/`. */
const asFolder = (f: string) => f.replace(/^\/+|\/+$/g, '').replace(/(.)$/, '$1/');

/** What the client is given of a manuscript. */
const shown = (m: Known): Json => ({ file: m.file, folder: m.folder, profile: m.profile, title: m.title, home: m.home, chapters: m.chapters as unknown as Json, appendices: m.appendices });

export const manuscriptFeature = defineFeature({
  id: 'manuscript',
  label: 'Manuscript',
  description: 'Documents in an order of your choosing, kept as a Quarto book: any of the workspace’s, in as many manuscripts as you like.',
  names: BOOK_NAMES,
  files: () => [HOMES_FILE],
  open(ctx) {
    const fail = (e: unknown): FeatureResponse => ({ status: (e as { status?: number }).status ?? 500, body: { message: (e as Error).message } });
    /** Write a manuscript's new order to its file, as whoever asked; and tell the clients. */
    const save = async (m: Known, next: Pick<Manuscript, 'chapters' | 'appendices'>, by: Person | null) => {
      const text = writeBook(m.text, { folder: m.folder, ...next });
      if (text === m.text) return;
      await ctx.write(m.file, text, { by });
      ctx.tell({ changed: m.file });
    };
    const setHomes = async (change: (homes: Record<string, string>) => void, by: Person | null) => {
      const homes = await readHomes(ctx);
      const before = stable(homes);
      change(homes);
      if (stable(homes) !== before) await ctx.write(HOMES_FILE, stable(homes), { by });
    };
    /** A request's manuscript, by its file. */
    const find = async (file: unknown) => (isText(file) ? (await manuscripts(ctx)).find((m) => m.file === file) : undefined);
    /** Why a path cannot be one of a manuscript's chapters, if it cannot. */
    const refuse = (m: Known, path: string) => (!isBookDocument(path) ? `${path} is not a document a book can have` : !path.startsWith(m.folder) ? `${path} is outside ${m.folder}, where this book’s chapters are` : null);

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
          if (!chapters || !Array.isArray(b.appendices) || !b.appendices.every(isText)) return bad('An order is a manuscript’s file, its chapters and its appendices');
          const m = await find(b.file);
          if (!m) return { status: 404, body: { message: `No manuscript in ${String(b.file)}` } };
          const paths = pathsOf({ chapters, appendices: b.appendices });
          const why = paths.map((p) => refuse(m, p)).find(Boolean);
          if (why) return bad(why);
          // Once in a manuscript at most (in several manuscripts, as many times as there are).
          if (new Set(paths).size !== paths.length) return bad('A document is in a manuscript once');
          try {
            await save(m, { chapters, appendices: b.appendices }, req.person);
          } catch (e) {
            return fail(e);
          }
          return { body: { ok: true } };
        },
      },
      {
        // A document added to a manuscript: after a chapter (where that is), else at its end.
        method: 'POST',
        path: 'add',
        handle: async (req: FeatureRequest): Promise<FeatureResponse> => {
          const b = (req.body ?? {}) as { path?: unknown; file?: unknown; after?: unknown };
          if (!isText(b.path)) return bad('A document is added to a manuscript');
          const m = await find(b.file);
          if (!m) return { status: 404, body: { message: `No manuscript in ${String(b.file)}` } };
          const why = refuse(m, b.path);
          if (why) return bad(why);
          if (pathsOf(m).includes(b.path)) return { body: { ok: true } };
          const path = b.path;
          let placed = false;
          const after = isText(b.after) ? b.after : null;
          const chapters: Entry[] = m.chapters.flatMap((e): Entry[] => {
            if ('chapter' in e) {
              if (after && e.chapter === after && !placed) {
                placed = true;
                return [e, { chapter: path }];
              }
              return [e];
            }
            const i = after ? e.chapters.indexOf(after) : -1;
            if (i >= 0 && !placed) {
              placed = true;
              return [{ part: e.part, chapters: [...e.chapters.slice(0, i + 1), path, ...e.chapters.slice(i + 1)] }];
            }
            // After a part's file (its heading): first in the part.
            if (after && e.part === after && !placed) {
              placed = true;
              return [{ part: e.part, chapters: [path, ...e.chapters] }];
            }
            return [e];
          });
          let appendices = m.appendices;
          const k = after ? appendices.indexOf(after) : -1;
          if (!placed && k >= 0) {
            placed = true;
            appendices = [...appendices.slice(0, k + 1), path, ...appendices.slice(k + 1)];
          }
          if (!placed) chapters.push({ chapter: path });
          try {
            await save(m, { chapters, appendices }, req.person);
          } catch (e) {
            return fail(e);
          }
          return { body: { ok: true } };
        },
      },
      {
        // A document taken out of a manuscript (the file stays, and in any other manuscript).
        method: 'POST',
        path: 'remove',
        handle: async (req: FeatureRequest): Promise<FeatureResponse> => {
          const b = (req.body ?? {}) as { path?: unknown; file?: unknown };
          if (!isText(b.path)) return bad('A document is taken out of a manuscript');
          const m = await find(b.file);
          if (!m) return { status: 404, body: { message: `No manuscript in ${String(b.file)}` } };
          if (!pathsOf(m).includes(b.path)) return { body: { ok: true } };
          try {
            await save(m, mapPaths(m, deleted(b.path, false)), req.person);
          } catch (e) {
            return fail(e);
          }
          return { body: { ok: true } };
        },
      },
      {
        // A new manuscript: a profile's book at the top of the workspace, so its chapters may be any
        // document. Of a folder (its documents its chapters, its home that folder), or empty, by a title.
        method: 'POST',
        path: 'make',
        handle: async (req: FeatureRequest): Promise<FeatureResponse> => {
          const b = (req.body ?? {}) as { folder?: unknown; title?: unknown; home?: unknown };
          const folder = isText(b.folder) ? asFolder(b.folder) : null;
          const title = (isText(b.title) && b.title.trim()) || (folder ? folder.replace(/\/$/, '').split('/').pop() : '') || '';
          if (!title) return bad('A new manuscript needs a title');
          const base = await ctx.read(BOOK_FILE);
          if (base !== null && !isBook(base)) return { status: 409, body: { message: `This workspace’s ${BOOK_FILE} is not a book’s: a manuscript cannot be added to it` } };
          if (base !== null && hasChapters(base)) return { status: 409, body: { message: `This workspace’s ${BOOK_FILE} is a book of its own: add to it in the Manuscript, or take its chapter list out to keep books beside it` } };
          const profiles = base ? profilesOf(base) : [];
          const all = await ctx.list();
          const name = profileName(title, [...profiles, ...all.filter((p) => !p.includes('/')).map((p) => PROFILE.exec(p)?.[1]).filter((n): n is string => !!n)]);
          const file = `_quarto-${name}.yml`;
          const home = isText(b.home) ? asFolder(b.home) : folder ?? `${name}/`;
          const chapters = folder ? all.filter((p) => p.startsWith(folder) && isBookDocument(p) && !p.slice(folder.length).split('/').some((s) => s.startsWith('.') || s.startsWith('_'))).sort() : [];
          try {
            await ctx.write(file, newProfileBook('', title, chapters), { by: req.person });
            await ctx.write(BOOK_FILE, withProfiles(base, [...profiles, name], profiles), { by: req.person });
            await setHomes((h) => void (h[file] = home), req.person);
          } catch (e) {
            return fail(e);
          }
          ctx.tell({ changed: file });
          return { body: { file } };
        },
      },
      {
        // Where a manuscript's new chapters go.
        method: 'POST',
        path: 'home',
        handle: async (req: FeatureRequest): Promise<FeatureResponse> => {
          const b = (req.body ?? {}) as { file?: unknown; home?: unknown };
          const m = await find(b.file);
          if (!m || !isText(b.home)) return bad('A manuscript’s home is a folder');
          const home = asFolder(b.home);
          if (!home.startsWith(m.folder)) return bad(`${home} is outside ${m.folder}, where this book’s chapters are`);
          try {
            await setHomes((h) => void (h[m.file] = home), req.person);
          } catch (e) {
            return fail(e);
          }
          ctx.tell({ changed: m.file });
          return { body: { ok: true } };
        },
      },
    ];

    // A chapter renamed or moved here is renamed in every book it is in, and a home folder with it;
    // one deleted is taken out of all of them; a profile's book deleted, out of its project's group.
    const follow = async (to: (p: string) => string | null, folderTo: (p: string) => string | null, gone: string | null) => {
      for (const m of await manuscripts(ctx)) {
        // A chapter moved out of its book's project is taken out: Quarto renders only what is in it.
        const next = mapPaths(m, (p) => {
          const q = to(p);
          return q !== null && q.startsWith(m.folder) ? q : null;
        });
        if (JSON.stringify(next) === JSON.stringify(m)) continue;
        try {
          await save(m, next, null);
        } catch (e) {
          ctx.log(`could not follow a change in ${m.file}: ${(e as Error).message}`);
        }
      }
      try {
        await setHomes((h) => {
          for (const [file, home] of Object.entries(h)) {
            const next = folderTo(home);
            if (gone && (file === gone || file.startsWith(`${gone}/`))) delete h[file];
            else if (next !== home && next !== null) h[file] = next;
          }
        }, null);
        if (gone && PROFILE.test(nameOf(gone))) {
          const baseFile = `${folderOfBook(gone)}${BOOK_FILE}`;
          const base = await ctx.read(baseFile);
          const name = PROFILE.exec(nameOf(gone))![1]!;
          if (base !== null && profilesOf(base).includes(name)) await ctx.write(baseFile, withProfiles(base, profilesOf(base).filter((n) => n !== name), profilesOf(base)), { by: null });
        }
      } catch (e) {
        ctx.log(`could not follow a change in ${HOMES_FILE}: ${(e as Error).message}`);
      }
      ctx.tell({ changed: '' });
    };
    const stops = [
      ctx.on('rename', ({ from, to, folder }) => {
        const r = renamed(from, to, folder);
        return follow(r, (home) => {
          const h = home.replace(/\/$/, '');
          const n = r(h);
          return n === h ? home : `${n}/`;
        }, null);
      }),
      ctx.on('delete', ({ path, folder }) => follow(deleted(path, folder), (home) => home, path)),
      // A book changed elsewhere (another device, the online copy): the views ask again.
      ctx.on('merge', ({ paths }) => {
        if (paths.some((p) => BOOK_NAMES.some((n) => (n.includes('*') ? PROFILE.test(nameOf(p)) : nameOf(p) === n)) || p === HOMES_FILE)) ctx.tell({ changed: '' });
      }),
    ];
    return { routes, close: () => stops.forEach((s) => s()) };
  },
});

export { folderOfBook, newBook as newProjectBook };
