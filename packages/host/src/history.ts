// The workspace's history as features read it (FeatureContext.history, 0121):
// the commits on the branch checked out, what each changed, and files as they
// were, read from git all at once where many are asked. Read only.
import { isUtf8 } from 'node:buffer';
import type { CommitPerson, FeatureHistory, FileAt, FileChange, HistoryCommit } from '@kuraa/feature-kit/host';
import type { Git } from './git.js';

const COMMIT = /^[0-9a-f]{40}$/;

/** Co-authors as a commit's trailers name them (separated by \x1d). */
export function coAuthors(trailers: string): CommitPerson[] {
  const out: CommitPerson[] = [];
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
    if (COMMIT.test(t) && !/^[ACDMRTUX]/.test(t)) {
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

/** Blobs as `git cat-file --batch` gives them, in the order asked: their text, or null where missing or not text (UTF-8). */
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
    const blob = bytes.subarray(at, at + size);
    out.push(m[1] === 'blob' && isUtf8(blob) ? blob.toString('utf8') : null);
    at += size + 1;
  }
  while (out.length < count) out.push(null);
  return out;
}

/** The log's records, as `log` asks for them: id, author's date, name, email, co-author trailers, parents. */
export function parseLog(out: string): HistoryCommit[] {
  return out.split('\x1e').map((r) => r.trim()).filter(Boolean).flatMap((r) => {
    const [id = '', date = '', name = '', email = '', trailers = '', parents = ''] = r.split('\x1f');
    if (!COMMIT.test(id)) return [];
    return [{ id, date, author: { name: name || email, email }, coAuthors: coAuthors(trailers), merge: parents.trim().split(/\s+/).filter(Boolean).length > 1 }];
  });
}

/** A path as git takes it in a revision (`<commit>:<path>`): one line, nothing that would be read as more. */
const askable = (f: FileAt) => COMMIT.test(f.commit) && !!f.path && !/[\n\r]/.test(f.path) && !f.path.startsWith('/');

export function gitHistory(git: Git): FeatureHistory {
  return {
    async log(o = {}) {
      if (o.since !== undefined && Number.isNaN(Date.parse(o.since))) throw new Error(`since: a moment, as ISO 8601 (not ${o.since})`);
      const args = ['log', ...(o.merges === false ? ['--no-merges'] : []), ...(o.since ? [`--since=${new Date(o.since).toISOString()}`] : []),
        '--format=%H%x1f%aI%x1f%an%x1f%ae%x1f%(trailers:key=Co-authored-by,valueonly,separator=%x1d)%x1f%P%x1e', 'HEAD'];
      const r = await git.run(args, { allowFail: true });
      return r.code === 0 ? parseLog(r.stdout) : [];
    },
    async changes(commits) {
      const ids = [...new Set(commits.filter((c) => COMMIT.test(c)))];
      const out: { [commit: string]: FileChange[] } = {};
      if (!ids.length) return out;
      const r = await git.run(['diff-tree', '-r', '-M', '--name-status', '-z', '--root', '--stdin'], { input: ids.join('\n') + '\n', allowFail: true });
      const parsed = parseDiffTree(r.stdout);
      for (const id of ids) out[id] = (parsed.get(id) ?? []).map(([from, to]) => ({ from, to }));
      return out;
    },
    async read(files) {
      const asks = files.map((f) => (askable(f) ? `${f.commit}${f.before ? '^' : ''}:${f.path}` : null));
      const real = asks.filter((a): a is string => a !== null);
      if (!real.length) return files.map(() => null);
      const r = await git.run(['cat-file', '--batch'], { input: real.join('\n') + '\n', allowFail: true });
      const texts = parseBatch(r.bytes, real.length);
      let i = 0;
      return asks.map((a) => (a === null ? null : texts[i++] ?? null));
    },
  };
}
