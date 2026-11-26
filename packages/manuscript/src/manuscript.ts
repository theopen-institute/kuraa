// A manuscript (0091): a folder whose documents, in the folder's order (its
// folders' too, as parts), make one book; any of them may be left out. Said by
// a file in the folder, `.kuraa-manuscript.yml`, plain YAML that moves with the
// folder and is read by whoever reads it:
//
//   # This folder is a manuscript in Kuraa: …
//   title: The Coast
//   exclude:
//     - notes.md
//     - research
//
// What is left out is named from the folder (a folder left out, all in it).
import { parseDocument, stringify } from 'yaml';

export const MANUSCRIPT_FILE = '.kuraa-manuscript.yml';

const HEADER = '# This folder is a manuscript in Kuraa: its documents, in the folder’s order, make one book.\n# Those under exclude (named from this folder) are left out of it.\n';

/** The kinds of document a book's chapters may be (pandoc's and Quarto's Markdown, R Markdown). */
const BOOK_DOCUMENT = /\.(md|markdown|qmd|rmd)$/i;
export const isBookDocument = (path: string): boolean => BOOK_DOCUMENT.test(path);

export interface Manuscript {
  /** Its folder, ending in `/` ('' for the top level). */
  folder: string;
  /** Its title; null: it is called by its folder's name. */
  title: string | null;
  /** What is left out, as workspace paths (a folder's without a trailing `/`). */
  exclude: string[];
}

/** The folder a manuscript's file makes a manuscript, ending in `/` ('' the top), or null if the path is not one. */
export function manuscriptFolder(path: string): string | null {
  if (path === MANUSCRIPT_FILE) return '';
  return path.endsWith(`/${MANUSCRIPT_FILE}`) ? path.slice(0, -MANUSCRIPT_FILE.length) : null;
}

export const manuscriptFileOf = (folder: string): string => folder + MANUSCRIPT_FILE;

/** A manuscript as its file says; what it does not say well is passed over. */
export function readManuscript(folder: string, text: string): Manuscript {
  let v: unknown;
  try {
    v = parseDocument(text).toJS();
  } catch {
    v = null;
  }
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim() : null;
  const exclude = Array.isArray(o.exclude) ? o.exclude.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => folder + x.trim().replace(/^\.?\/+|\/+$/g, '')) : [];
  return { folder, title, exclude: [...new Set(exclude)] };
}

/** A manuscript's file. */
export function writeManuscript(m: Manuscript): string {
  const body: Record<string, unknown> = {};
  if (m.title) body.title = m.title;
  const exclude = m.exclude.filter((p) => p.startsWith(m.folder)).map((p) => p.slice(m.folder.length)).sort();
  if (exclude.length) body.exclude = exclude;
  return HEADER + (Object.keys(body).length ? stringify(body) : '');
}

/** What a manuscript is called: its title, or its folder's name. */
export const titleOf = (m: Pick<Manuscript, 'folder' | 'title'>, top = 'Manuscript'): string =>
  m.title || m.folder.replace(/\/$/, '').split('/').pop() || top;

/** Whether a path (a file, or a folder without its `/`) is in a manuscript's folder. */
export const within = (m: Pick<Manuscript, 'folder'>, path: string): boolean => path.startsWith(m.folder) && path !== m.folder.replace(/\/$/, '');

/** What leaves a path out: it, or a folder it is in, named under exclude; null where nothing does. */
export function excludedBy(m: Manuscript, path: string): string | null {
  return m.exclude.find((x) => path === x || path.startsWith(`${x}/`)) ?? null;
}

/** A manuscript with a path left out, or put back in. */
export function withIncluded(m: Manuscript, path: string, include: boolean): Manuscript {
  const exclude = include ? m.exclude.filter((x) => x !== path) : [...new Set([...m.exclude, path])];
  return { ...m, exclude };
}

/**
 * A manuscript after a file or folder was renamed or moved: what it left out
 * stays left out at its new name, or is forgotten if it went out of the
 * folder. Null where nothing changed. (The manuscript's own folder moving
 * takes its file with it: names in it are from the folder, and stay.)
 */
export function afterRename(m: Manuscript, from: string, to: string): Manuscript | null {
  let changed = false;
  const exclude = m.exclude.flatMap((x) => {
    if (x !== from && !x.startsWith(`${from}/`)) return [x];
    changed = true;
    const next = to + x.slice(from.length);
    return within(m, next) ? [next] : [];
  });
  return changed ? { ...m, exclude } : null;
}

/** A manuscript after a file or folder was deleted: what it named under it forgotten. Null where nothing changed. */
export function afterDelete(m: Manuscript, path: string): Manuscript | null {
  const exclude = m.exclude.filter((x) => x !== path && !x.startsWith(`${path}/`));
  return exclude.length === m.exclude.length ? null : { ...m, exclude };
}
