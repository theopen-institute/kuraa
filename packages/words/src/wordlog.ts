// Words written, by day and by person, from the workspace's history (0094),
// read through the feature contract (0125: FeatureContext.history, edited and
// store).
//
// Each commit that is not a merge is counted on its own: for each document it
// changed (a file whose type has prose, 0123: Markdown, R Markdown; renames
// followed), its words before and after it (kernel's wordChange): net (how
// many more) and added (words written, so a rewrite counts). Merges are passed
// over: they bring together work already counted in the commits on each side,
// whichever device made them, so what was written on another device counts on
// the day it was written, whenever it arrived. Its day is the commit's own (its
// author's date, where it was made). Everyone credited on it is given all of
// it: the people named as co-authors (an automatic save names whoever changed
// the document since the last one), else its author (a commit made elsewhere,
// or by hand). What has not been committed yet (an open document typed in since
// its last save) is added for today, credited to whoever typed it.
//
// A commit never changes, so what it counts is kept (the feature's store, on
// this device) and counted once.
import { wordChange } from '@kuraa/kernel';
import type { CommitPerson, FeatureContext, FileAt, HistoryCommit, Json } from '@kuraa/feature-kit/host';

/** What it keeps its counts under. 3: kept in the feature's store (0125), its documents by their type's prose (0123). */
const CACHE = 'commits';
const CACHE_VERSION = 3;

export type WordPerson = CommitPerson;

/** What one commit wrote. */
export interface CommitWords {
  /** Its day, where it was made: YYYY-MM-DD. */
  date: string;
  people: WordPerson[];
  net: number;
  added: number;
}

/** A day's words, by person (0094): net (how many more) and added (written, a rewrite counting too). */
export interface WordsDay {
  /** YYYY-MM-DD. */
  date: string;
  people: (WordPerson & { net: number; added: number })[];
}

/** The day a moment falls on where it was: YYYY-MM-DD of an ISO date with its offset; today, here, for now. */
export const dayOf = (iso?: string): string => {
  if (iso) return iso.slice(0, 10);
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Whoever a commit credits: its co-authors, else its author. */
export const creditedOn = (c: HistoryCommit): WordPerson[] => (c.coAuthors.length ? c.coAuthors : [c.author]);

export class WordLog {
  private cache: Record<string, CommitWords | null> | null = null;

  constructor(private readonly ctx: FeatureContext) {}

  /** What a reader reads of a file's text, by its type (0123); null for one that is not a document of prose, or is kept beside one. */
  private proseOf(path: string): ((text: string) => string) | null {
    if (this.ctx.belongsTo(path) !== null) return null;
    const type = this.ctx.typeOf(path);
    return type?.prose ? (text) => type.prose!(text) : null;
  }

  private async load(): Promise<Record<string, CommitWords | null>> {
    if (this.cache) return this.cache;
    const v = (await this.ctx.store.get(CACHE).catch(() => null)) as { version?: number; commits?: Record<string, CommitWords | null> } | null;
    this.cache = v?.version === CACHE_VERSION && v.commits ? v.commits : {};
    return this.cache;
  }

  private async save(): Promise<void> {
    await this.ctx.store.set(CACHE, { version: CACHE_VERSION, commits: this.cache } as unknown as Json);
  }

  /** What the commits not counted yet wrote, counted and kept. */
  private async count(commits: { id: string; date: string; people: WordPerson[] }[]): Promise<void> {
    const cache = await this.load();
    const todo = commits.filter((c) => !(c.id in cache));
    if (!todo.length) return;
    const changes = await this.ctx.history.changes(todo.map((c) => c.id));
    // Every version needed, asked at once.
    const asks: FileAt[] = [];
    const plan = todo.map((c) => {
      const files = (changes[c.id] ?? []).map((f) => ({ ...f, proseBefore: f.from ? this.proseOf(f.from) : null, proseAfter: f.to ? this.proseOf(f.to) : null })).filter((f) => f.proseBefore || f.proseAfter);
      // A side whose type has no prose (renamed from a text file, say) counts as nothing there.
      return files.map((f) => ({
        before: f.from && f.proseBefore ? asks.push({ commit: c.id, path: f.from, before: true }) - 1 : -1,
        after: f.to && f.proseAfter ? asks.push({ commit: c.id, path: f.to }) - 1 : -1,
        proseBefore: f.proseBefore,
        proseAfter: f.proseAfter,
      }));
    });
    const texts = asks.length ? await this.ctx.history.read(asks) : [];
    todo.forEach((c, i) => {
      let net = 0;
      let added = 0;
      for (const f of plan[i]!) {
        const was = f.before >= 0 ? texts[f.before] ?? null : null;
        const now = f.after >= 0 ? texts[f.after] ?? null : null;
        const w = wordChange(was === null ? null : f.proseBefore!(was), now === null ? null : f.proseAfter!(now));
        net += w.net;
        added += w.added;
      }
      cache[c.id] = plan[i]!.length ? { date: c.date, people: c.people, net, added } : null;
    });
    await this.save().catch(() => undefined);
  }

  /**
   * The words written each day from `since` (YYYY-MM-DD), by person, newest
   * day first: every commit on the branch that is not a merge, and what is not
   * committed yet.
   */
  async days(since: string): Promise<WordsDay[]> {
    // A day's slack: a commit's own date may be behind this host's clock.
    const from = new Date(`${since}T00:00:00Z`);
    from.setUTCDate(from.getUTCDate() - 1);
    const commits = (await this.ctx.history.log({ since: from.toISOString(), merges: false }))
      .map((c) => ({ id: c.id, date: dayOf(c.date), people: creditedOn(c) }))
      .filter((c) => c.date >= since);
    await this.count(commits);
    const cache = await this.load();
    const counted: CommitWords[] = commits.flatMap((c) => cache[c.id] ?? []);
    const today = dayOf();
    for (const e of await this.ctx.edited()) {
      const prose = this.proseOf(e.path);
      if (!prose) continue;
      const w = wordChange(e.before === null ? null : prose(e.before), prose(e.after));
      if ((w.net || w.added) && today >= since) counted.push({ date: today, people: e.people, ...w });
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
