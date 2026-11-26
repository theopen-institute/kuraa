// A manuscript is a Quarto book (docs/decisions/0088-a-manuscript-is-a-quarto-book.md,
// 0090-manuscripts-apart-from-folders.md): its order the book's `chapters`
// (with parts) and `appendices`, in one of two kinds of file.
//
//   a project's book   a `_quarto.yml` saying `project: type: book` with a
//                      chapter list: its chapters are in its folder
//   a profile's book   a `_quarto-<name>.yml` beside a book's `_quarto.yml`
//                      (Quarto's project profiles): one book of several from
//                      one project, rendered with `--profile <name>`. Kuraa
//                      makes these at the top of the workspace, so their
//                      chapters may be any of its documents
//
// Read here, and written back with only the two lists changed: everything else
// in the file (its other settings, its comments, its layout) stays as the
// writer left it. Paths in the file are relative to its folder; here, outside
// the file, they are the workspace's (`book/chapters/arrival.md`).
import { isMap, isScalar, isSeq, parseDocument, type Document } from 'yaml';

/** The file that makes a folder a manuscript. */
export const BOOK_FILE = '_quarto.yml';

/** A chapter, or a part: a title, or a file with the part's title and an introduction, and its chapters. */
export type Entry = { chapter: string } | { part: string; chapters: string[] };

/** A manuscript: its file, its project's folder ('' at the top, else ending in `/`: its chapters are in it), its title, and its order. */
export interface Manuscript {
  file: string;
  folder: string;
  /** Its profile's name, for a profile's book. */
  profile: string | null;
  title: string | null;
  chapters: Entry[];
  appendices: string[];
}

/** A profile's file: `_quarto-<name>.yml`, its name. */
export const PROFILE = /^_quarto-([A-Za-z0-9][A-Za-z0-9_-]*)\.yml$/;
/** The names of the files a manuscript is kept in, as the host writes them (`names`). */
export const BOOK_NAMES = [BOOK_FILE, '_quarto-*.yml'];

/** What a document of a book may be (Quarto's). */
export const BOOK_EXTENSIONS = ['.md', '.qmd', '.Rmd', '.rmd', '.ipynb'];
export const isBookDocument = (path: string) => BOOK_EXTENSIONS.some((e) => path.endsWith(e));

/** The folder of a `_quarto.yml` ('' at the top, else ending in `/`). */
export const folderOfBook = (file: string) => file.slice(0, file.lastIndexOf('/') + 1);

/** A path in the file (relative to its folder, `./` or `../` allowed) as the workspace's. */
export function resolve(folder: string, rel: string): string {
  const parts = folder.split('/').filter(Boolean);
  for (const p of rel.split('/')) {
    if (p === '' || p === '.') continue;
    if (p === '..') parts.pop();
    else parts.push(p);
  }
  return parts.join('/');
}

/** A workspace path as the file has it, relative to its folder. */
export function relative(folder: string, path: string): string {
  const from = folder.split('/').filter(Boolean);
  const to = path.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++;
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
}

const text = (v: unknown): string | null => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : null);

type Config = { project?: { type?: unknown }; book?: { title?: unknown; chapters?: unknown; appendices?: unknown } } | null;
const parse = (yaml: string): Config => {
  try {
    return parseDocument(yaml).toJS() as Config;
  } catch {
    return null;
  }
};

/** Whether a `_quarto.yml`'s text makes a book project. */
export function isBook(yaml: string): boolean {
  return parse(yaml)?.project?.type === 'book';
}

/** Whether a book project's `_quarto.yml` has a chapter list of its own (it is then a book itself, not only profiles' base). */
export function hasChapters(yaml: string): boolean {
  const v = parse(yaml);
  return !!v?.book && Array.isArray(v.book.chapters);
}

/**
 * A book's title and order (null: not a book, or not YAML). Paths are the
 * workspace's. A `_quarto.yml` is read as a project's book; a profile's file
 * as a profile's book, its project the folder it is in (its `base`, the
 * project's `_quarto.yml`, gives the title it does not).
 */
export function readBook(file: string, yaml: string, base?: string): Manuscript | null {
  const v = parse(yaml);
  const name = file.slice(file.lastIndexOf('/') + 1);
  const profile = PROFILE.exec(name)?.[1] ?? null;
  if (profile === null && v?.project?.type !== 'book') return null;
  if (profile !== null && !v?.book) return null;
  const folder = folderOfBook(file);
  const list = (x: unknown) => (Array.isArray(x) ? x : []);
  const chapters: Entry[] = [];
  for (const item of list(v?.book?.chapters)) {
    const one = text(item);
    if (one !== null) chapters.push({ chapter: resolve(folder, one) });
    else if (item && typeof item === 'object' && 'part' in item) {
      const part = text((item as { part: unknown }).part) ?? '';
      chapters.push({
        part: isBookDocument(part) ? resolve(folder, part) : part,
        chapters: list((item as { chapters?: unknown }).chapters).map(text).filter((c): c is string => c !== null).map((c) => resolve(folder, c)),
      });
    }
  }
  const appendices = list(v?.book?.appendices).map(text).filter((c): c is string => c !== null).map((c) => resolve(folder, c));
  const title = text(v?.book?.title) ?? (base !== undefined ? text(parse(base)?.book?.title) : null);
  return { file, folder, profile, title: title ?? profile, chapters, appendices };
}

/** The lists as the file writes them: paths relative to its folder. */
function lists(m: Pick<Manuscript, 'folder' | 'chapters' | 'appendices'>) {
  const rel = (p: string) => relative(m.folder, p);
  return {
    chapters: m.chapters.map((e) => ('chapter' in e ? rel(e.chapter) : { part: isBookDocument(e.part) ? rel(e.part) : e.part, chapters: e.chapters.map(rel) })),
    appendices: m.appendices.map(rel),
  };
}

/**
 * A `_quarto.yml`'s text with its book's chapters and appendices set, and
 * nothing else changed. Appendices left empty are taken out of the file.
 */
export function writeBook(yaml: string, m: Pick<Manuscript, 'folder' | 'chapters' | 'appendices'>): string {
  const doc: Document = parseDocument(yaml);
  if (doc.errors.length) throw new Error(`${BOOK_FILE} is not valid YAML: ${doc.errors[0]!.message}`);
  const { chapters, appendices } = lists(m);
  if (!isMap(doc.get('book'))) doc.set('book', doc.createNode({}));
  doc.setIn(['book', 'chapters'], doc.createNode(chapters));
  if (appendices.length) doc.setIn(['book', 'appendices'], doc.createNode(appendices));
  else if (doc.hasIn(['book', 'appendices'])) doc.deleteIn(['book', 'appendices']);
  // Lists written in block style, a line an entry, as Quarto's own examples are.
  for (const key of ['chapters', 'appendices']) {
    const seq = doc.getIn(['book', key]);
    if (isSeq(seq)) seq.flow = false;
  }
  return doc.toString({ lineWidth: 0 });
}

/** A new book's `_quarto.yml`: its title, and its chapters. */
export function newBook(folder: string, title: string, chapters: string[]): string {
  const doc = parseDocument('project:\n  type: book\n\nbook:\n  title: ""\n  chapters: []\n');
  const node = doc.getIn(['book', 'title'], true);
  if (isScalar(node)) node.value = title;
  return writeBook(doc.toString(), { folder, chapters: chapters.map((chapter) => ({ chapter })), appendices: [] });
}

/** A new profile's book (`_quarto-<name>.yml`): its title, and its chapters (the workspace's paths, its project's folder `folder`). */
export function newProfileBook(folder: string, title: string, chapters: string[]): string {
  const doc = parseDocument('book:\n  title: ""\n  chapters: []\n');
  const node = doc.getIn(['book', 'title'], true);
  if (isScalar(node)) node.value = title;
  return writeBook(doc.toString(), { folder, chapters: chapters.map((chapter) => ({ chapter })), appendices: [] });
}

/**
 * A book project's `_quarto.yml` (made, where `yaml` is null) with its profiles
 * as one group of which one is rendered at a time, the first by default
 * (Quarto's `profile: group:`). The group that has any of `names`, or of the
 * names it `was`, is replaced (removed, where `names` is empty); else one is
 * added. Everything else stays as it was.
 */
export function withProfiles(yaml: string | null, names: string[], was: string[] = names): string {
  const doc = parseDocument(yaml ?? 'project:\n  type: book\n');
  if (doc.errors.length) throw new Error(`${BOOK_FILE} is not valid YAML: ${doc.errors[0]!.message}`);
  const groups = (doc.getIn(['profile', 'group']) as { toJSON(): unknown } | undefined)?.toJSON();
  const list: string[][] = Array.isArray(groups) ? (groups as unknown[]).map((g) => (Array.isArray(g) ? g.map(String) : [String(g)])) : [];
  const at = list.findIndex((g) => g.some((n) => names.includes(n) || was.includes(n)));
  if (!names.length) {
    if (at >= 0) list.splice(at, 1);
  } else if (at >= 0) list[at] = names;
  else list.push(names);
  if (list.length) {
    if (!isMap(doc.get('profile'))) doc.set('profile', doc.createNode({}));
    const node = doc.createNode(list);
    // Each group on a line, as Quarto's examples write it: `- [basic, advanced]`.
    for (const g of (node as { items: { flow?: boolean }[] }).items) g.flow = true;
    doc.setIn(['profile', 'group'], node);
  } else if (doc.hasIn(['profile', 'group'])) doc.deleteIn(['profile', 'group']);
  return doc.toString({ lineWidth: 0 });
}

/** The profiles of a book project's `_quarto.yml`, as its first group names them. */
export function profilesOf(yaml: string): string[] {
  const groups = (parse(yaml) as { profile?: { group?: unknown } } | null)?.profile?.group;
  return Array.isArray(groups) ? (groups as unknown[]).flatMap((g) => (Array.isArray(g) ? g.map(String) : [String(g)])) : [];
}

/** A profile's name for a title: lower-case letters, digits and dashes, not one of `taken`. */
export function profileName(title: string, taken: readonly string[]): string {
  const base = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'manuscript';
  let name = base;
  for (let n = 2; taken.includes(name); n++) name = `${base}-${n}`;
  return name;
}

/** Every path a manuscript names, in its order: chapters, parts' files and chapters, appendices. */
export function pathsOf(m: Pick<Manuscript, 'chapters' | 'appendices'>): string[] {
  return [
    ...m.chapters.flatMap((e) => ('chapter' in e ? [e.chapter] : [...(isBookDocument(e.part) ? [e.part] : []), ...e.chapters])),
    ...m.appendices,
  ];
}

/** Whether a manuscript lists a path: as a chapter, a part's file, or an appendix. */
export const placeIn = (m: Pick<Manuscript, 'chapters' | 'appendices'>, path: string): boolean => pathsOf(m).includes(path);

/**
 * The order with each path changed by `to` (null: taken out). A part whose
 * file is taken out keeps its chapters, as a part with its file's name as its
 * title is not known here: it becomes a part titled by the file's name.
 */
export function mapPaths(m: Manuscript, to: (path: string) => string | null): Manuscript {
  const chapters: Entry[] = [];
  for (const e of m.chapters) {
    if ('chapter' in e) {
      const next = to(e.chapter);
      if (next !== null) chapters.push({ chapter: next });
    } else {
      const part = isBookDocument(e.part) ? to(e.part) ?? e.part.slice(e.part.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '') : e.part;
      chapters.push({ part, chapters: e.chapters.map(to).filter((p): p is string => p !== null) });
    }
  }
  return { ...m, chapters, appendices: m.appendices.map(to).filter((p): p is string => p !== null) };
}

/** A path renamed (or a folder: everything in it), else as it was. */
export const renamed = (from: string, to: string, folder: boolean) => (p: string) => (p === from ? to : folder && p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);

/** A path deleted (or a folder: everything in it) is taken out. */
export const deleted = (gone: string, folder: boolean) => (p: string) => (p === gone || (folder && p.startsWith(`${gone}/`)) ? null : p);
