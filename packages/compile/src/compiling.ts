// A folder compiled (0093, 0106), in Compile's host half (0122): what a folder's
// book could have, for the panel's outline, and the folder's documents joined
// into one, for the core to render. Through the feature contract alone: the
// files this device holds, their types (which are documents a book is made of,
// their titles, their words: 0119), the folders' orders, and each document as
// it is now (its open room's text, else its file).
import { orderedFolder, parseOrder, type CompiledFolder, type FeatureContext, type Json } from '@kuraa/feature-kit/host';
import { proseWords } from '@kuraa/kernel';
import { bookItems, joinBook, type BookPart, type CompileEntry } from './book.js';
import { isCoverImage, isTemplate } from './settings.js';

/** How a folder is compiled (0093, 0106), as the panel asks the core's render for it: its `compile`. */
export interface CompileRequest {
  /** What is left out (workspace paths; a folder's, all in it). */
  exclude?: string[];
  /** Folders (paths) whose names are no heading, nor a level. */
  noHeading?: string[];
  /** Folders (paths; '' the top level) whose documents' titles are no headings: what is in them runs on, a separator between (0106). */
  noTitles?: string[];
  title?: string;
  subtitle?: string;
  author?: string;
  /** A table of contents. */
  toc?: boolean;
  /** Its top-level headings as chapters (Chapter 1: …), or every heading numbered (1, 1.1, …). */
  numbering?: 'chapters' | 'sections';
  /** Between two documents with no heading between them: a rule (`* * *`, `---`), or this text, centred. */
  separator?: string;
  /** A Word document in the workspace whose styles a Word book takes (path). */
  referenceDoc?: string;
  /** An image in the workspace on an EPUB's cover (path). */
  cover?: string;
}

/** What a folder's book could have (the `contents` route): its folders and documents, in the file tree's order. */
export interface BookContent {
  kind: 'folder' | 'document';
  path: string;
  /** A folder's name, or a document's title (its name where it has none). */
  title: string;
  /** How deep it is in the folder compiled: 1 in the folder itself. */
  depth: number;
  /** A document's words, as it is now (0094). */
  words?: number;
}

/** A compile asked for, checked: paths without slashes at their ends, text cut to length. */
interface Options {
  exclude: string[];
  noHeading: string[];
  noTitles: string[];
  title: string;
  subtitle: string | null;
  author: string | null;
  toc: boolean;
  numbering: 'chapters' | 'sections' | null;
  separator: string | null;
  referenceDoc: string | null;
  cover: string | null;
}

const bare = (p: string) => p.replace(/^\/+|\/+$/g, '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** What a compiled folder's book is called by default: the folder's name ('Book' for the top level). */
export const defaultTitle = (folder: string): string => (folder ? nameOf(folder) : 'Book');

/** A request as the core passes it (JSON, as the panel sent it), checked. */
export function optionsOf(folder: string, request: Json): Options {
  const r = (request && typeof request === 'object' && !Array.isArray(request) ? request : {}) as Record<string, unknown>;
  const paths = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!bare(x)).map(bare) : []);
  const text = (v: unknown, most = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, most) : null);
  return {
    exclude: paths(r.exclude),
    noHeading: paths(r.noHeading),
    // The top level ('') is a folder too: its documents may have no titles.
    noTitles: Array.isArray(r.noTitles) ? r.noTitles.filter((x): x is string => typeof x === 'string').map(bare) : [],
    title: text(r.title) ?? defaultTitle(folder),
    subtitle: text(r.subtitle),
    author: text(r.author),
    toc: r.toc === true,
    numbering: r.numbering === 'chapters' || r.numbering === 'sections' ? r.numbering : null,
    separator: text(r.separator, 100),
    referenceDoc: text(r.referenceDoc, 1000) && bare(text(r.referenceDoc, 1000)!),
    cover: text(r.cover, 1000) && bare(text(r.cover, 1000)!),
  };
}

/** A file's text as it is now: its open room's, else its file's. */
const textOf = async (ctx: FeatureContext, path: string): Promise<string | null> => (await ctx.live(path)) ?? (await ctx.read(path));

/** The workspace as a book sees it: its files but those kept beside documents, each saying whether it is a document a book is made of, with its title; and the folders' orders. */
async function workspace(ctx: FeatureContext): Promise<{ paths: string[]; entries: CompileEntry[]; orders: Map<string, string[]> }> {
  const paths = await ctx.list();
  const entries: CompileEntry[] = [];
  const orders = new Map<string, string[]>();
  for (const path of paths) {
    const ordered = orderedFolder(path);
    if (ordered !== null) {
      const text = await ctx.read(path);
      if (text !== null) orders.set(ordered, parseOrder(text));
    }
    if (ctx.belongsTo(path) !== null) continue;
    const type = ctx.typeOf(path);
    if (!type?.title) {
      entries.push({ path });
      continue;
    }
    const text = await textOf(ctx, path);
    entries.push({ path, title: text === null ? null : type.title.read(text), book: !!type.markdown });
  }
  return { paths, entries, orders };
}

/** What a folder's book could have ('' the top level): all its folders and documents, nothing left out, in the file tree's order, each with its words. */
export async function bookContents(ctx: FeatureContext, folder: string): Promise<BookContent[]> {
  const { entries, orders } = await workspace(ctx);
  const titles = new Map(entries.map((e) => [e.path, e.title ?? null]));
  const out: BookContent[] = [];
  for (const i of bookItems(folder, entries, orders, [])) {
    // A document's words (0094), as it is now.
    const words = i.kind === 'document' ? proseWords(ctx.typeOf(i.path), (await textOf(ctx, i.path)) ?? '') ?? undefined : undefined;
    out.push({ kind: i.kind, path: i.path, title: i.kind === 'folder' ? i.name : titles.get(i.path) || nameOf(i.path), depth: i.level, ...(words !== undefined ? { words } : {}) });
  }
  return out;
}

/**
 * A folder compiled ('' the top level), to render in a format: its documents
 * in the file tree's order, but those left out, each as it is now, joined into
 * one Markdown document; with the folders they are in, where what they refer
 * to is found, and its Word template or cover beside it. A string says why
 * there is nothing.
 */
export async function compileFolder(ctx: FeatureContext, folder: string, request: Json, format: string): Promise<CompiledFolder | string> {
  const o = optionsOf(folder, request);
  const { paths, entries, orders } = await workspace(ctx);
  const items = bookItems(folder, entries, orders, o.exclude, o.noHeading);
  const docs = items.flatMap((i) => (i.kind === 'document' ? [i.path] : []));
  if (!docs.length) return `${folder ? `${folder}/` : 'The workspace'} has no documents to compile${o.exclude.length ? ' that are not left out' : ''}.`;
  const titles = new Map(entries.map((e) => [e.path, e.title ?? null]));
  // A Word template for a Word book, a cover for an EPUB (0106): files in the workspace, put beside the book.
  const files: { name: string; path: string }[] = [];
  const beside = (path: string | null, kind: (p: string) => boolean, what: string, name: (ext: string) => string): string | null => {
    if (!path) return null;
    if (!kind(path) || !paths.includes(path)) return `${what} ${path} is not there${kind(path) ? '' : ', or is not one'}.`;
    files.push({ name: name(path.slice(path.lastIndexOf('.') + 1).toLowerCase()), path });
    return null;
  };
  const missing = (format === 'docx' ? beside(o.referenceDoc, isTemplate, 'The Word template', () => 'reference.docx') : null)
    ?? (format === 'epub' ? beside(o.cover, isCoverImage, 'The cover image', (ext) => `cover.${ext}`) : null);
  if (missing) return missing;
  const noTitles = new Set(o.noTitles);
  const parts: BookPart[] = [];
  for (const i of items) {
    if (i.kind === 'folder') {
      parts.push(i);
      continue;
    }
    const text = await textOf(ctx, i.path);
    if (text === null) return `${i.path} could not be read.`;
    parts.push({ kind: 'document', level: i.level, title: noTitles.has(folderOf(i.path)) ? null : titles.get(i.path) ?? null, text });
  }
  const named = (n: string) => files.find((f) => f.name.startsWith(n))?.name ?? null;
  const text = joinBook({ title: o.title, subtitle: o.subtitle, author: o.author, toc: o.toc, numbering: o.numbering, separator: o.separator, referenceDoc: named('reference.'), cover: named('cover.') }, parts);
  return { text, folders: [...new Set(docs.map(folderOf))], files };
}
