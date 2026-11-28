// What Compile keeps of a folder (0093), in a file in it, `.kuraa-compile.yml`,
// plain YAML that moves with the folder and is read by whoever reads it:
//
//   # Kuraa's Compile: …
//   title: The Coast        the book's title, when this folder is compiled
//   format: docx            how it was last compiled
//   heading: false          compiled inside another, its name is no heading
//   titles: false           its documents' titles are no headings (0106)
//   target-words: 80000     the book's target in words (0094)
//   exclude:                what in this folder is left out of any compile
//     - notes.md
//     - research
//
// and the book's own (0106), when this folder is compiled:
//
//   subtitle: A novel
//   author: Ada Byron
//   toc: true               a table of contents
//   numbering: chapters     Chapter 1: …; or sections: 1, 1.1, …
//   separator: "#"          between documents with no heading between them
//   reference-doc: templates/manuscript.docx    a Word book's styles (workspace path)
//   cover-image: art/cover.jpg                  an EPUB's cover (workspace path)
//
// What is left out is named as the folder's order names it: by name, in its
// own folder. A document left out is left out of every compile that would
// have it, as Scrivener's Include in Compile is the document's own.
import { parseDocument, stringify } from 'yaml';

export const COMPILE_FILE = '.kuraa-compile.yml';

export const FORMATS = ['docx', 'pdf', 'html', 'epub'] as const;
export type CompileFormat = (typeof FORMATS)[number];

const HEADER = '# Kuraa’s Compile for this folder: the book’s title, format and settings when it is compiled,\n# and what in it (by name) is left out of any compile.\n';

export const NUMBERINGS = ['chapters', 'sections'] as const;
export type Numbering = (typeof NUMBERINGS)[number];

/** A Word document a Word book may take its styles from; an image an EPUB may have on its cover (0106). */
export const isTemplate = (path: string): boolean => /\.docx$/i.test(path);
export const isCoverImage = (path: string): boolean => /\.(png|jpe?g|gif|svg|webp)$/i.test(path);

/** Whether a file is a document a book is made of (as the host's compile has them): its type's text is Markdown (0123). */
export const isBookDocument = (type: { markdown?: boolean } | undefined): boolean => !!type?.markdown;

export interface FolderCompile {
  /** The folder ('' the top level), without a trailing `/`. */
  folder: string;
  title: string | null;
  /** Whether its name is a heading where it is compiled inside another (false: no heading, nor a level, of its own). */
  heading: boolean;
  /** The book's target in words, when this folder is compiled (0094). */
  target: number | null;
  format: CompileFormat | null;
  /** Names in the folder left out of any compile. */
  exclude: string[];
  /** Whether its documents' titles are headings (false: they run on, a separator between: 0106). */
  titles: boolean;
  /** The book's own, when this folder is compiled (0106). */
  subtitle: string | null;
  author: string | null;
  toc: boolean;
  numbering: Numbering | null;
  separator: string | null;
  /** Workspace paths: a Word template, an EPUB's cover. */
  referenceDoc: string | null;
  cover: string | null;
}

/** A folder Compile says nothing of. */
export const emptyCompile = (folder: string): FolderCompile => ({
  folder, title: null, format: null, heading: true, target: null, exclude: [],
  titles: true, subtitle: null, author: null, toc: false, numbering: null, separator: null, referenceDoc: null, cover: null,
});

const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const inFolder = (folder: string, name: string) => (folder ? `${folder}/${name}` : name);

/** The folder a Compile file is about ('' the top), or null if the path is not one. */
export function compileFolder(path: string): string | null {
  if (path === COMPILE_FILE) return '';
  return path.endsWith(`/${COMPILE_FILE}`) ? path.slice(0, -COMPILE_FILE.length - 1) : null;
}

export const compileFileOf = (folder: string): string => inFolder(folder, COMPILE_FILE);

/** A folder's Compile settings as its file says; what it does not say well is passed over. */
export function readCompile(folder: string, text: string): FolderCompile {
  let v: unknown;
  try {
    v = parseDocument(text).toJS();
  } catch {
    v = null;
  }
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : null;
  const format = FORMATS.includes(o.format as CompileFormat) ? (o.format as CompileFormat) : null;
  const exclude = Array.isArray(o.exclude) ? o.exclude.filter((x): x is string => typeof x === 'string' && !!x.trim() && !x.includes('/')).map((x) => x.trim()) : [];
  const target = typeof o['target-words'] === 'number' && o['target-words'] >= 1 ? Math.round(o['target-words']) : null;
  const words = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);
  const path = (v: unknown, kind: (p: string) => boolean) => (typeof v === 'string' && kind(v.trim()) && !v.split('/').includes('..') ? v.trim().replace(/^\/+/, '') : null);
  return {
    folder, title, format, heading: o.heading !== false, target, exclude: [...new Set(exclude)],
    titles: o.titles !== false,
    subtitle: words(o.subtitle),
    author: words(o.author),
    toc: o.toc === true,
    numbering: NUMBERINGS.includes(o.numbering as Numbering) ? (o.numbering as Numbering) : null,
    separator: words(o.separator),
    referenceDoc: path(o['reference-doc'], isTemplate),
    cover: path(o['cover-image'], isCoverImage),
  };
}

/** A folder's Compile file; null (none) where it says nothing. */
export function writeCompile(c: FolderCompile): string | null {
  const body: Record<string, unknown> = {};
  if (c.title) body.title = c.title;
  if (c.format) body.format = c.format;
  if (c.subtitle) body.subtitle = c.subtitle;
  if (c.author) body.author = c.author;
  if (c.toc) body.toc = true;
  if (c.numbering) body.numbering = c.numbering;
  if (c.separator) body.separator = c.separator;
  if (c.referenceDoc) body['reference-doc'] = c.referenceDoc;
  if (c.cover) body['cover-image'] = c.cover;
  if (!c.heading) body.heading = false;
  if (!c.titles) body.titles = false;
  if (c.target) body['target-words'] = c.target;
  if (c.exclude.length) body.exclude = [...c.exclude].sort();
  return Object.keys(body).length ? HEADER + stringify(body) : null;
}

/** The folders whose documents' titles are no headings (paths, '' the top level: 0106). */
export const noTitlesPaths = (all: readonly FolderCompile[]): string[] => all.filter((c) => !c.titles).map((c) => c.folder);

/** The folders whose names are no heading where they are compiled (paths). */
export const noHeadingPaths = (all: readonly FolderCompile[]): string[] => all.filter((c) => !c.heading && c.folder).map((c) => c.folder);

/** Every path left out, from every folder's settings (a folder's: all in it). */
export const excludedPaths = (all: readonly FolderCompile[]): string[] => all.flatMap((c) => c.exclude.map((n) => inFolder(c.folder, n)));

/** What leaves a path out: it, or a folder it is in; null where nothing does. */
export function excludedBy(all: readonly FolderCompile[], path: string): string | null {
  return excludedPaths(all).find((x) => path === x || path.startsWith(`${x}/`)) ?? null;
}

/** The settings with a path left out of compiles, or put back (in its folder's). */
export function withIncluded(c: FolderCompile, name: string, include: boolean): FolderCompile {
  return { ...c, exclude: include ? c.exclude.filter((n) => n !== name) : [...new Set([...c.exclude, name])] };
}

/** A path under a rename: where it is now, if `from` (it, or a folder it is in) moved to `to`. */
const moved = (path: string, from: string, to: string): string | null => (path === from ? to : path.startsWith(`${from}/`) ? to + path.slice(from.length) : null);

/** The folders whose settings change: those in `first`, then any `change` changes (given each folder's settings as `first` left them). */
function changed(byFolder: ReadonlyMap<string, FolderCompile>, first: FolderCompile[], change: (c: FolderCompile) => FolderCompile): FolderCompile[] {
  const out = new Map(first.map((c) => [c.folder, c]));
  for (const c of new Map([...byFolder, ...out]).values()) {
    const next = change(c);
    if (next !== c) out.set(c.folder, next);
  }
  return [...out.values()];
}

/**
 * The folders' settings that change when a file or folder is renamed or moved:
 * left out, it stays left out, under its new name in its new folder (the
 * document's own, as in Scrivener). A folder moving takes its own file along.
 * A book's Word template or cover renamed or moved (or a folder it is in) is
 * followed there (0106).
 */
export function afterRename(byFolder: ReadonlyMap<string, FolderCompile>, from: string, to: string): FolderCompile[] {
  const first: FolderCompile[] = [];
  const was = byFolder.get(folderOf(from));
  if (was?.exclude.includes(nameOf(from))) {
    const [fromDir, toDir] = [folderOf(from), folderOf(to)];
    if (fromDir === toDir) first.push({ ...was, exclude: was.exclude.map((n) => (n === nameOf(from) ? nameOf(to) : n)) });
    else first.push(withIncluded(was, nameOf(from), true), withIncluded(byFolder.get(toDir) ?? emptyCompile(toDir), nameOf(to), false));
  }
  return changed(byFolder, first, (c) => {
    const referenceDoc = c.referenceDoc && moved(c.referenceDoc, from, to);
    const cover = c.cover && moved(c.cover, from, to);
    return referenceDoc || cover ? { ...c, referenceDoc: referenceDoc || c.referenceDoc, cover: cover || c.cover } : c;
  });
}

/** The folders' settings that change when a file or folder is deleted: it is no longer named, nor a book's template or cover. */
export function afterDelete(byFolder: ReadonlyMap<string, FolderCompile>, path: string): FolderCompile[] {
  const was = byFolder.get(folderOf(path));
  const first = was?.exclude.includes(nameOf(path)) ? [withIncluded(was, nameOf(path), true)] : [];
  const gone = (p: string | null) => !!p && moved(p, path, path) !== null;
  return changed(byFolder, first, (c) => (gone(c.referenceDoc) || gone(c.cover) ? { ...c, referenceDoc: gone(c.referenceDoc) ? null : c.referenceDoc, cover: gone(c.cover) ? null : c.cover } : c));
}
