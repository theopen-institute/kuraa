// Searching the workspace's text files for a phrase.
//
// Files come from git grep: tracked and untracked, as .gitignore leaves them,
// text only (-I), never through links, with large files left out. Documents
// someone has open are searched as their rooms have them now instead, so what
// was typed a moment ago is found before it reaches the file. It reads only,
// so it runs beside the host's serial work, not in its queue.
import { isUtf8 } from 'node:buffer';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Host } from './host.js';

/** Files larger than this are not searched. */
const MAX_FILE = 2 * 1024 * 1024;
/** The most matches returned, and per file. */
const MAX_MATCHES = 1000;
const MAX_PER_FILE = 100;
/** A matching line is cut to this many characters around the match. */
const MAX_LINE = 240;

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

/** The matches of `query` in a line, as columns. */
function columnsIn(line: string, query: string, caseSensitive: boolean): number[] {
  const hay = caseSensitive ? line : line.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: number[] = [];
  for (let i = hay.indexOf(needle); i >= 0 && out.length < MAX_PER_FILE; i = hay.indexOf(needle, i + Math.max(needle.length, 1))) out.push(i);
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

/** Matches in a whole text (a room's), line by line. */
export function searchText(text: string, query: string, caseSensitive: boolean): SearchMatch[] {
  const out: SearchMatch[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length && out.length < MAX_PER_FILE; i++) {
    const line = lines[i]!.replace(/\r$/, '');
    for (const at of columnsIn(line, query, caseSensitive)) {
      out.push({ line: i + 1, at, ...shown(line, at, query.length) });
      if (out.length >= MAX_PER_FILE) break;
    }
  }
  return out;
}

export async function searchWorkspace(host: Host, query: string, caseSensitive: boolean): Promise<SearchResult> {
  const branch = await host.git.branch();
  // Files too large to search, left out by name.
  const listed = await host.git.run(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { allowFail: true });
  const large: string[] = [];
  for (const p of new Set(listed.stdout.split('\0').filter(Boolean))) {
    const st = await lstat(join(host.dir, p)).catch(() => null);
    if (st && st.isFile() && st.size > MAX_FILE) large.push(p);
  }
  const companions = host.features.suffixes();
  const args = (scope: string[], more: string[] = []) => [
    '-c', 'grep.lineNumber=false', 'grep', '--untracked', ...more, '-I', '-n', '-z', '--no-color', '--fixed-strings',
    ...(caseSensitive ? [] : ['-i']), '-e', query, '--', ...scope, ...large.map((p) => `:(exclude,literal)${p}`),
    // What features keep beside documents (0082) is theirs to search, not the workspace's.
    ...companions.map((s) => `:(exclude,glob)**/*${s}/**`),
    // A document's own files (0107: `report.md.files/`) are shown with it, not found on their own.
    ':(exclude,glob)**/*.*.files/**',
    // The app's own files in folders (0093: a folder's order, a manuscript's), about the folder, not in it.
    ':(exclude,glob)**/.kuraa-*',
  ];
  const grep = await host.git.run(args(['.']), { allowFail: true, timeoutMs: 30_000 });
  // The files of the spaces this device holds, which plain git is kept off (spaces.ts): searched by name.
  const spaced = host.spaces.entries().map(([p]) => p).filter((p) => !host.features.documentOf(p));
  if (spaced.length) {
    const more = await host.git.run(args(spaced.map((p) => `:(literal)${p}`), ['--no-exclude-standard']), { allowFail: true, timeoutMs: 30_000 });
    grep.stdout = `${grep.stdout}${grep.stdout && !grep.stdout.endsWith('\n') ? '\n' : ''}${more.stdout}`;
  }
  const byPath = new Map<string, SearchMatch[]>();
  let truncated = false;
  let total = 0;
  for (const record of grep.stdout.split('\n')) {
    const first = record.indexOf('\0');
    const second = record.indexOf('\0', first + 1);
    if (first < 0 || second < 0) continue;
    const path = record.slice(0, first);
    const line = Number(record.slice(first + 1, second));
    const text = record.slice(second + 1).replace(/\r$/, '');
    const matches = byPath.get(path) ?? [];
    for (const at of columnsIn(text, query, caseSensitive)) {
      if (matches.length >= MAX_PER_FILE) {
        truncated = true;
        break;
      }
      matches.push({ line, at, ...shown(text, at, query.length) });
    }
    byPath.set(path, matches);
  }

  // Open documents: from their rooms, as they are being edited.
  const live = new Set<string>();
  for (const rec of host.openRooms()) {
    if (rec.branch !== branch) continue;
    const text = host.roomText(rec.room);
    if (text === undefined) continue;
    live.add(rec.path);
    const found = searchText(text, query, caseSensitive);
    if (found.length) byPath.set(rec.path, found);
    else byPath.delete(rec.path);
  }

  const files: SearchFile[] = [];
  for (const [path, matches] of [...byPath].sort(([a], [b]) => a.localeCompare(b))) {
    if (!matches.length) continue;
    // A link the workspace tracks is searched as its target's name by git: not a file to show.
    if (!live.has(path)) {
      if ((await lstat(join(host.dir, path)).catch(() => null))?.isSymbolicLink()) continue;
      // Text not in UTF-8 (Latin-1, say) would show with its characters changed, and the app does not open it.
      const bytes = await readFile(join(host.dir, path)).catch(() => null);
      if (!bytes || !isUtf8(bytes)) continue;
    }
    if (total >= MAX_MATCHES) {
      truncated = true;
      break;
    }
    const kept = matches.slice(0, MAX_MATCHES - total);
    if (kept.length < matches.length) truncated = true;
    total += kept.length;
    const entry = await host.treeEntry(path, branch);
    files.push({ path, type: entry?.type ?? null, ...(entry && 'title' in entry ? { title: entry.title ?? null } : {}), live: live.has(path), matches: kept });
  }
  return { files, truncated };
}
