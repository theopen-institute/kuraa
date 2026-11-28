// Searching the workspace's text files for a phrase (0042, 0120), through the
// feature contract alone: the files this device holds (as .gitignore leaves
// them, and the spaces it holds), read as text (UTF-8, never through a link,
// large files left out); documents someone has open as their rooms have them
// now, so what was typed a moment ago is found before it reaches the file.
// What is kept beside a document (a feature's companions, its own files) and
// the app's own files in folders are not searched.
import type { FeatureContext } from '@kuraa/feature-kit/host';

/** Files larger than this are not searched. */
export const MAX_FILE = 2 * 1024 * 1024;
/** The most matches returned, and per file. */
export const MAX_MATCHES = 1000;
export const MAX_PER_FILE = 100;
/** A matching line is cut to this many characters around the match. */
const MAX_LINE = 240;
/** Files read at once. */
const READ_AT_ONCE = 32;

export interface SearchMatch {
  /** 1-based. */
  line: number;
  /** Where the match starts in `text` (0-based, in characters). */
  column: number;
  /** The line, cut around the match if it is long. */
  text: string;
  /** Where the match starts in the whole line, for finding it again. */
  at: number;
}

export interface SearchFile {
  path: string;
  /** Its document type, or null. */
  type: string | null;
  /** A document's title (null if it has none); absent for other files. */
  title?: string | null;
  /** Found in the document's open room (what is being edited now), not the file. */
  live: boolean;
  matches: SearchMatch[];
}

export interface SearchResult {
  files: SearchFile[];
  /** More matched than are listed. */
  truncated: boolean;
}

/** The matches of `query` in a line, as columns: at most `max`. */
function columnsIn(line: string, query: string, caseSensitive: boolean, max: number): number[] {
  const hay = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0 && out.length < max; i = hay.indexOf(needle, i + Math.max(needle.length, 1))) out.push(i);
  return out;
}

/** A line as shown, cut around a match. */
function shown(line: string, at: number, length: number): { text: string; column: number } {
  if (line.length <= MAX_LINE) return { text: line, column: at };
  const start = Math.max(0, Math.min(at - Math.floor((MAX_LINE - length) / 2), line.length - MAX_LINE));
  const prefix = start > 0 ? '…' : '';
  const text = prefix + line.slice(start, start + MAX_LINE) + (start + MAX_LINE < line.length ? '…' : '');
  return { text, column: at - start + prefix.length };
}

/** Matches in a whole text, line by line: at most MAX_PER_FILE, and whether there were more. */
export function searchText(text: string, query: string, caseSensitive: boolean): { matches: SearchMatch[]; more: boolean } {
  const matches: SearchMatch[] = [];
  // Most files hold no match: said at once, without going through their lines.
  if (!(caseSensitive ? text.includes(query) : text.toLowerCase().includes(query.toLowerCase()))) return { matches, more: false };
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    for (const at of columnsIn(line, query, caseSensitive, MAX_PER_FILE + 1 - matches.length)) {
      if (matches.length >= MAX_PER_FILE) return { matches, more: true };
      matches.push({ line: i + 1, at, ...shown(line, at, query.length) });
    }
  }
  return { matches, more: false };
}

/** Whether a phrase can be searched for: what is wrong with it, or null. */
export function badQuery(query: string): string | null {
  return !query.trim() || query.length > 500 || query.includes('\n') ? 'Search for a phrase of up to 500 characters, on one line' : null;
}

/** The app's own files in folders (0093: a folder's order, a manuscript's): about the folder, not in it. */
const appFile = (path: string) => path.slice(path.lastIndexOf('/') + 1).startsWith('.kuraa-');

/** The workspace searched for a phrase, as this device holds it and its open documents are now. */
export async function searchWorkspace(ctx: FeatureContext, query: string, caseSensitive: boolean): Promise<SearchResult> {
  const paths = (await ctx.list()).filter((p) => !appFile(p) && ctx.belongsTo(p) === null).sort();
  const found: { path: string; text: string; matches: SearchMatch[]; live: boolean }[] = [];
  let truncated = false;
  for (let i = 0; i < paths.length; i += READ_AT_ONCE) {
    const batch = paths.slice(i, i + READ_AT_ONCE);
    const read = await Promise.all(batch.map(async (path) => {
      const live = await ctx.live(path);
      return { path, text: live ?? (await ctx.read(path, { maxBytes: MAX_FILE })), live: live !== null };
    }));
    for (const r of read) {
      // Not text: binary files git would not search either.
      if (r.text === null || r.text.includes('\0')) continue;
      const { matches, more } = searchText(r.text, query, caseSensitive);
      if (more) truncated = true;
      if (matches.length) found.push({ path: r.path, text: r.text, matches, live: r.live });
    }
  }
  const files: SearchFile[] = [];
  let total = 0;
  for (const f of found) {
    if (total >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    const kept = f.matches.slice(0, MAX_MATCHES - total);
    if (kept.length < f.matches.length) truncated = true;
    total += kept.length;
    const type = ctx.typeOf(f.path);
    files.push({ path: f.path, type: type?.id ?? null, ...(type?.title ? { title: type.title.read(f.text) } : {}), live: f.live, matches: kept });
  }
  return { files, truncated };
}
