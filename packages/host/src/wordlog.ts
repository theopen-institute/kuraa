// Words written, by day and by person, from the workspace's history (0094).
//
// Each commit that is not a merge is counted on its own: for each document it
// changed (Markdown, Quarto's, R Markdown; renames followed), the words before
// and after it (kernel's wordChange): net (how many more) and added (words
// written, so a rewrite counts). Merges are passed over: they bring together
// work already counted in the commits on each side, whichever device made
// them, so what was written on another device counts on the day it was
// written, whenever it arrived. Its day is the commit's own (its author's
// date, where it was made). Everyone credited on it is given all of it: the
// people named as co-authors (an automatic save names whoever changed the
// document since the last one), else its author (a commit made elsewhere, or by
// hand). What has not been committed yet (an open document typed in since its
// last save) is added for today, credited to whoever typed it.
//
// A commit never changes, so what it counts is kept (.git/kuraa/words.json)
// and counted once.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { wordChange } from '@kuraa/kernel';
import type { Git } from './git.js';

const DOCUMENT = /\.(md|markdown|qmd|rmd)$/i;
const CACHE_VERSION = 1;

export interface WordPerson {
  name: string;
  email: string;
}

/** What one commit wrote. */
export interface CommitWords {
  /** Its day, where it was made: YYYY-MM-DD. */
  date: string;
  people: WordPerson[];
  net: number;
  added: number;
}

/** A day's words, by person. */
export interface DayWords {
  date: string;
  people: (WordPerson & { net: number; added: number })[];
}

/** Changes not committed yet: a document's text at its last commit and now, and who changed it. */
export interface Uncommitted {
  before: string | null;
  after: string;
  people: WordPerson[];
}

/** Co-authors as a commit's trailers name them. */
export function coAuthors(trailers: string): WordPerson[] {
  const out: WordPerson[] = [];
  for (const t of trailers.split('\x1d')) {
    const m = /^\s*(.*?)\s*<([^>]*)>\s*$/.exec(t);
    if (m && m[2]) out.push({ name: m[1] || m[2], email: m[2] });
  }
  return out;
}

/** Each commit's changed paths from `git diff-tree --stdin -z --name-status`: [old, new]; null where there was none. */
export function parseDiffTree(out: string): Map<string, [string | null, string | null][]> {
  const tokens = out.split('\0');
  const commits = new Map<string, [string | null, string | null][]>();
  let current: [string | null, string | null][] | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    if (/^[0-9a-f]{40}$/.test(t) && !/^[ACDMRTUX]/.test(t)) {
      current = [];
      commits.set(t, current);
      continue;
    }
    if (!current || !t) continue;
    const kind = t[0];
    if (kind === 'R' || kind === 'C') {
      const from = tokens[++i] ?? null;
      const to = tokens[++i] ?? null;
      current.push([kind === 'R' ? from : null, to]);
    } else {
      const path = tokens[++i] ?? null;
      current.push(kind === 'A' ? [null, path] : kind === 'D' ? [path, null] : [path, path]);
    }
  }
  return commits;
}

/** Blobs as `git cat-file --batch` gives them, in the order asked: their text, or null where missing. */
export function parseBatch(bytes: Buffer, count: number): (string | null)[] {
  const out: (string | null)[] = [];
  let at = 0;
  while (out.length < count && at < bytes.length) {
    const nl = bytes.indexOf(0x0a, at);
    if (nl < 0) break;
    const head = bytes.subarray(at, nl).toString('utf8');
    at = nl + 1;
    const m = /^\S+ (\S+) (\d+)$/.exec(head);
    if (!m) {
      out.push(null);
      continue;
    }
    const size = Number(m[2]);
    out.push(m[1] === 'blob' ? bytes.subarray(at, at + size).toString('utf8') : null);
    at += size + 1;
  }
  while (out.length < count) out.push(null);
  return out;
}

/** The day a moment falls on where it was: YYYY-MM-DD of an ISO date with its offset; today, here, for now. */
export const dayOf = (iso?: string): string => {
  if (iso) return iso.slice(0, 10);
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export class WordLog {
  private cache: Record<string, CommitWords | null> | null = null;

  constructor(private readonly o: {
    git: Git;
    /** Files a feature keeps beside documents: not documents. */
    isCompanion(path: string): boolean;
  }) {}

  private async cacheFile(): Promise<string> {
    return join(await this.o.git.gitDir(), 'kuraa', 'words.json');
  }

  private async load(): Promise<Record<string, CommitWords | null>> {
    if (this.cache) return this.cache;
    try {
      const v = JSON.parse(await readFile(await this.cacheFile(), 'utf8')) as { version?: number; commits?: Record<string, CommitWords | null> };
      this.cache = v.version === CACHE_VERSION && v.commits ? v.commits : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async save(): Promise<void> {
    const file = await this.cacheFile();
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, JSON.stringify({ version: CACHE_VERSION, commits: this.cache }));
  }

  /** What the commits not counted yet wrote, counted and kept. */
  private async count(commits: { hash: string; date: string; people: WordPerson[] }[]): Promise<void> {
    const cache = await this.load();
    const todo = commits.filter((c) => !(c.hash in cache));
    if (!todo.length) return;
    const tree = await this.o.git.run(['diff-tree', '-r', '-M', '--name-status', '-z', '--root', '--stdin'], { input: todo.map((c) => c.hash).join('\n') + '\n', allowFail: true });
    const changes = parseDiffTree(tree.stdout);
    // Every version needed, asked of git at once.
    const asks: string[] = [];
    const plan = todo.map((c) => {
      const files = (changes.get(c.hash) ?? []).filter(([a, b]) => [a, b].some((p) => p && DOCUMENT.test(p) && !this.o.isCompanion(p)));
      return files.map(([from, to]) => {
        const before = from ? asks.push(`${c.hash}^:${from}`) - 1 : -1;
        const after = to ? asks.push(`${c.hash}:${to}`) - 1 : -1;
        return { before, after };
      });
    });
    const texts = asks.length ? parseBatch((await this.o.git.run(['cat-file', '--batch'], { input: asks.join('\n') + '\n', allowFail: true })).bytes, asks.length) : [];
    todo.forEach((c, i) => {
      let net = 0;
      let added = 0;
      for (const f of plan[i]!) {
        const w = wordChange(f.before >= 0 ? texts[f.before] ?? null : null, f.after >= 0 ? texts[f.after] ?? null : null);
        net += w.net;
        added += w.added;
      }
      cache[c.hash] = plan[i]!.length ? { date: c.date, people: c.people, net, added } : null;
    });
    await this.save().catch(() => undefined);
  }

  /**
   * The words written each day from `since` (YYYY-MM-DD), by person: every
   * commit on the branch that is not a merge, and what is not committed yet.
   */
  async days(since: string, uncommitted: Uncommitted[] = []): Promise<DayWords[]> {
    // A day's slack: a commit's own date may be behind this host's clock.
    const from = new Date(`${since}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 1);
    const log = await this.o.git.run(['log', '--no-merges', `--since=${from.toISOString()}`, '--format=%H%x1f%aI%x1f%an%x1f%ae%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)%x1e', 'HEAD'], { allowFail: true });
    const commits = log.code !== 0 ? [] : log.stdout.split('\x1e').map((r) => r.trim()).filter(Boolean).map((r) => {
      const [hash = '', date = '', name = '', email = '', trailers = ''] = r.split('\x1f');
      const named = coAuthors(trailers);
      return { hash, date: dayOf(date), people: named.length ? named : [{ name: name || email, email }] };
    }).filter((c) => /^[0-9a-f]{40}$/.test(c.hash) && c.date >= since);
    await this.count(commits);
    const cache = await this.load();
    const counted: CommitWords[] = commits.flatMap((c) => cache[c.hash] ?? []);
    const today = dayOf();
    for (const u of uncommitted) {
      const w = wordChange(u.before, u.after);
      if ((w.net || w.added) && today >= since) counted.push({ date: today, people: u.people, ...w });
    }
    // Everyone credited is given all of it.
    const byDay = new Map<string, Map<string, WordPerson & { net: number; added: number }>>();
    for (const c of counted) {
      const day = byDay.get(c.date) ?? new Map();
      byDay.set(c.date, day);
      const seen = new Set<string>();
      for (const p of c.people) {
        const key = (p.email || p.name).toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        const was = day.get(key) ?? { name: p.name, email: p.email, net: 0, added: 0 };
        was.net += c.net;
        was.added += c.added;
        day.set(key, was);
      }
    }
    return [...byDay].sort(([a], [b]) => b.localeCompare(a)).map(([date, people]) => ({ date, people: [...people.values()].sort((a, b) => b.added - a.added) }));
  }
}
