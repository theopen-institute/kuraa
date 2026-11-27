// A folder compiled (0093): its folders and documents, in the order the file
// tree shows them (its order and its folders', what they do not name after, by
// name), joined into one Markdown document to render as any other. How deep
// something is in the tree is its heading's level: in the folder compiled, a
// folder's name and a document's title are `#` headings, one folder down `##`,
// and so on; a document's own headings go below its title; past `######`, at
// `######`. A folder said to have no heading adds none, and no level. Each
// document's header is left out, the book's title given instead. What is asked
// to be left out (a document, or a folder with all in it) is.

/** The documents a book is made of: pandoc's Markdown and Quarto's (R Markdown's chunks are not run when compiled, and show as code). */
const BOOK_DOCUMENT = /\.(md|markdown|qmd|rmd)$/i;
export const isBookDocument = (path: string): boolean => BOOK_DOCUMENT.test(path);

/** A file in the workspace as the tree knows it. */
export interface CompileEntry {
  path: string;
  /** A document's title (null: none); absent for other files. */
  title?: string | null;
}

/** What a book is made of, in order: folders' headings, and documents, each at its level (1: `#`). */
export type BookItem =
  | { kind: 'folder'; path: string; name: string; level: number }
  | { kind: 'document'; path: string; level: number };

const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const shownName = (f: CompileEntry) => f.title || nameOf(f.path);
/** The app's own files (a folder's order, a component's), and git's placeholder: not in a book. */
const hidden = (name: string) => name.startsWith('.kuraa-') || name === '.gitkeep';

/**
 * A folder's book ('' the top level): its folders and documents in the order
 * the file tree shows them, all through its folders, each at its level;
 * leaving out what `exclude` names (paths; a folder's, all in it), what is not
 * a document a book is made of, and folders with nothing in the book. The
 * folders `noHeading` names (paths) are passed through without a heading or a
 * level of their own.
 */
export function bookItems(folder: string, entries: readonly CompileEntry[], orders: ReadonlyMap<string, readonly string[]>, exclude: readonly string[], noHeading: readonly string[] = []): BookItem[] {
  const left = (p: string) => exclude.some((x) => p === x || p.startsWith(`${x}/`));
  const walk = (dir: string, level: number): BookItem[] => {
    const prefix = dir ? `${dir}/` : '';
    const folders = new Set<string>();
    const files: CompileEntry[] = [];
    for (const e of entries) {
      if (!e.path.startsWith(prefix)) continue;
      const rest = e.path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash >= 0) folders.add(rest.slice(0, slash));
      else if (!hidden(rest)) files.push(e);
    }
    // As the tree sorts them (packages/files/src/tree.ts): folders by name, then files by title, numbers in order.
    files.sort((a, b) => shownName(a).localeCompare(shownName(b), undefined, { numeric: true, sensitivity: 'base' }) || a.path.localeCompare(b.path));
    const byName = [...[...folders].sort((a, b) => a.localeCompare(b)).map((name) => ({ name, folder: true })), ...files.map((f) => ({ name: nameOf(f.path), folder: false }))];
    const order = orders.get(dir);
    const shown = order ? [...order.flatMap((n) => byName.filter((c) => c.name === n)), ...byName.filter((c) => !order.includes(c.name))] : byName;
    return shown.flatMap((c): BookItem[] => {
      const path = prefix + c.name;
      if (left(path) || (c.folder && (c.name === '.kuraa' || c.name === '.git'))) return [];
      if (!c.folder) return isBookDocument(path) ? [{ kind: 'document', path, level }] : [];
      const headed = !noHeading.includes(path);
      const inside = walk(path, headed ? level + 1 : level);
      if (!inside.some((i) => i.kind === 'document')) return [];
      return headed ? [{ kind: 'folder', path, name: c.name, level }, ...inside] : inside;
    });
  };
  return walk(folder.replace(/\/+$/, ''), 1);
}

/** The documents of a folder's book, in order. */
export const documentsInOrder = (folder: string, entries: readonly CompileEntry[], orders: ReadonlyMap<string, readonly string[]>, exclude: readonly string[]): string[] =>
  bookItems(folder, entries, orders, exclude).flatMap((i) => (i.kind === 'document' ? [i.path] : []));

const HEADER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** A document's text without its header. */
export const withoutHeader = (text: string): string => text.replace(HEADER, '');

/** A heading at a level, at `######` at most. */
const heading = (level: number, text: string) => `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${text}`;

/** ATX headings `by` levels down (a document's own sections, under its title), outside fenced code; past `######`, at `######`. */
export function headingsDown(text: string, by = 1): string {
  if (by <= 0) return text;
  let fence: string | null = null;
  return text.split('\n').map((line) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length))) {
      fence = fence ? null : f;
      return line;
    }
    const m = fence ? null : /^\s{0,3}(#{1,6})(\s.*|)$/.exec(line);
    return m ? `${'#'.repeat(Math.min(6, m[1]!.length + by))}${m[2]}` : line;
  }).join('\n');
}

/** A part of a book: a folder's heading, or a document (its title, null for none, and its text). */
export type BookPart = { kind: 'folder'; name: string; level: number } | { kind: 'document'; title: string | null; text: string; level: number };

/**
 * The book: its title as its header, then each folder's heading and each
 * document at its level: its title as its heading (unless it begins with that
 * heading already) and its own headings below it; a document without a title,
 * its own headings below its folder's.
 */
export function joinBook(title: string, parts: readonly BookPart[]): string {
  const out = parts.map((p) => {
    if (p.kind === 'folder') return heading(p.level, p.name);
    const body = withoutHeader(p.text).trim();
    if (!p.title) return headingsDown(body, p.level - 1);
    const first = body.split('\n', 1)[0]!.trim();
    const rest = first === `# ${p.title}` ? body.slice(body.indexOf('\n') + 1 || body.length) : body;
    return `${heading(p.level, p.title)}\n\n${headingsDown(rest.trim(), p.level)}`.trim();
  });
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${out.filter(Boolean).join('\n\n')}\n`;
}
