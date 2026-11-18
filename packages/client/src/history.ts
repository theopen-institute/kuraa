// The history as people read it: runs of the host's own saves grouped into
// editing sessions, with named versions and merges standing out between them.
import type { CommitInfo } from './api.js';

/** Saves this far apart or more start a new session. */
const SESSION_GAP_MS = 2 * 60 * 60 * 1000;

export type HistoryEntry =
  | { kind: 'commit'; commit: CommitInfo }
  | { kind: 'session'; id: string; commits: CommitInfo[] };

/** Group commits (newest first) into entries: consecutive saves close in time become one session. */
export function groupHistory(commits: CommitInfo[]): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const c of commits) {
    const last = out[out.length - 1];
    if (c.kind === 'autosave') {
      if (last?.kind === 'session') {
        const earliest = last.commits[last.commits.length - 1]!;
        if (Date.parse(earliest.date) - Date.parse(c.date) < SESSION_GAP_MS) {
          last.commits.push(c);
          continue;
        }
      }
      out.push({ kind: 'session', id: c.hash, commits: [c] });
    } else out.push({ kind: 'commit', commit: c });
  }
  // A session of one save is just that save.
  return out.map((e) => (e.kind === 'session' && e.commits.length === 1 ? { kind: 'commit', commit: e.commits[0]! } : e));
}

/** Everyone who took part in some commits, each once, in order of appearance. */
export function peopleOf(commits: CommitInfo[]): string {
  return [...new Set(commits.flatMap((c) => [c.author, ...c.coAuthors.map((a) => a.name)]))].join(', ');
}

/** The parts of the document a session's saves changed, from their messages ("Edit Notes: Methods, Results (Ada)"). */
export function partsOf(commits: CommitInfo[]): string[] {
  const parts: string[] = [];
  for (const c of [...commits].reverse()) {
    const m = /^(?:Edit|Create) .*?: (.*?)(?: and \d+ more)?(?: \([^)]*\))?$/.exec(c.subject);
    for (const p of m?.[1]?.split(', ') ?? []) if (p && !parts.includes(p)) parts.push(p);
  }
  return parts;
}
