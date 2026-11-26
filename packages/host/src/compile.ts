// A folder compiled (0091): its documents, in the order the file tree shows
// them (its order and its folders', what they do not name after, by name),
// joined into one Markdown document to render as any other. Each document's
// title becomes its chapter's heading, its own headings one level below; its
// header is left out, the book's title given instead. What is asked to be left
// out (a document, or a folder with all in it) is.

/** The documents a book is made of: pandoc's Markdown and Quarto's (R Markdown's chunks are not run when compiled, and show as code). */
const BOOK_DOCUMENT = /\.(md|markdown|qmd|rmd)$/i;
export const isBookDocument = (path: string): boolean => BOOK_DOCUMENT.test(path);

/** A file in the workspace as the tree knows it. */
export interface CompileEntry {
  path: string;
  /** A document's title (null: none); absent for other files. */
  title?: string | null;
}

const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const shownName = (f: CompileEntry) => f.title || nameOf(f.path);
/** The app's own files (a folder's order, a component's), and git's placeholder: not in a book. */
const hidden = (name: string) => name.startsWith('.kuraa-') || name === '.gitkeep';

/**
 * A folder's documents in the order the file tree shows them ('' the top
 * level), all through its folders, leaving out what `exclude` names (paths;
 * a folder's, all in it) and what is not a document a book is made of.
 */
export function documentsInOrder(folder: string, entries: readonly CompileEntry[], orders: ReadonlyMap<string, readonly string[]>, exclude: readonly string[]): string[] {
  const base = folder ? `${folder}/` : '';
  const left = (p: string) => exclude.some((x) => p === x || p.startsWith(`${x}/`));
  const walk = (dir: string): string[] => {
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
    return shown.flatMap((c) => {
      const path = prefix + c.name;
      if (left(path) || (c.folder && (c.name === '.kuraa' || c.name === '.git'))) return [];
      return c.folder ? walk(path) : isBookDocument(path) ? [path] : [];
    });
  };
  return walk(base.replace(/\/$/, ''));
}

const HEADER = /^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** A document's text without its header. */
export const withoutHeader = (text: string): string => text.replace(HEADER, '');

/** ATX headings one level down (a document's own sections, under its chapter's heading), outside fenced code. */
export function headingsDown(text: string): string {
  let fence: string | null = null;
  return text.split('\n').map((line) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length))) {
      fence = fence ? null : f;
      return line;
    }
    return !fence && /^\s{0,3}#{1,5}(\s|$)/.test(line) ? line.replace('#', '##') : line;
  }).join('\n');
}

/**
 * The book: its title as its header, then each document, its title as its
 * chapter's heading (unless it begins with that heading already) and its
 * sections one level below; a document without a title, as it is.
 */
export function joinBook(title: string, documents: readonly { title: string | null; text: string }[]): string {
  const parts = documents.map(({ title: t, text }) => {
    const body = withoutHeader(text).trim();
    if (!t) return body;
    const first = body.split('\n', 1)[0]!.trim();
    if (first === `# ${t}`) return `# ${t}\n${headingsDown(body.slice(body.indexOf('\n') + 1 || body.length))}`.trim();
    return `# ${t}\n\n${headingsDown(body)}`.trim();
  });
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${parts.filter(Boolean).join('\n\n')}\n`;
}
