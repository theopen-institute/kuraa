// Suggestions (docs/decisions/0066-permissions-without-a-centre.md, step 3): changes
// to files their makers may not change, kept on record in the history every
// device shares, for those who may change them to take or leave.
//
// A suggestion is a commit proposing a file's text: one its maker made as such
// (`Kuraa-Suggestion`, Host.suggest), or one a merge refused (`Kuraa-Refused`,
// gate.ts). It stays open until seen to (`Kuraa-Resolved`, in a commit that
// changes nothing: accepted, its text having been put in the document as an
// edit, or dismissed) by someone who may change the file, or by whoever
// suggested it; or until the file has that text anyway.
import type { Git } from '../git.js';
import { commitSigner } from '../signing.js';
import { REFUSED_TRAILER, RESOLVED_TRAILER, SUGGESTION_TRAILER, trailers } from './gate.js';

export interface Suggestion {
  /** The commit proposing the text. */
  commit: string;
  path: string;
  /** Whose it is: the person (identity ID) whose signing key signed it, and their name; null if no one's. */
  person: string | null;
  name: string | null;
  /** When it was made (its commit's date, ISO). */
  date: string;
  /** The text proposed; null if the suggestion is to take the file away. */
  text: string | null;
}

export interface SuggestionContext {
  personOf(signingKey: string): string | null;
  nameOf(person: string): string | null;
  /** Whether a person may change the file (a resolution by anyone else, but the suggester, counts for nothing). */
  mayWrite(person: string | null, path: string): boolean;
}

/** `<commit> <path>`, as the trailers say it. */
const pair = (v: string) => {
  const m = /^([0-9a-f]{40,64}) (.+)$/.exec(v);
  return m ? { commit: m[1]!, path: m[2]! } : null;
};

/** The open suggestions on a branch (of one file, if `path` is given), oldest first. */
export async function suggestions(git: Git, branch: string, ctx: SuggestionContext, path?: string): Promise<Suggestion[]> {
  const log = await git.run(['log', '--format=%H%x1f%B%x1e', '-E', `--grep=^(${REFUSED_TRAILER}|${SUGGESTION_TRAILER}|${RESOLVED_TRAILER}):`, branch, '--'], { allowFail: true });
  if (log.code !== 0) return [];
  const proposed = new Map<string, { commit: string; path: string }>();
  const resolutions: { commit: string; path: string; by: string }[] = [];
  for (const entry of log.stdout.split('\x1e')) {
    const [hash, message] = entry.trim().split('\x1f');
    if (!hash || message === undefined) continue;
    for (const v of trailers(message, SUGGESTION_TRAILER)) proposed.set(`${hash} ${v}`, { commit: hash, path: v });
    for (const v of trailers(message, REFUSED_TRAILER)) {
      const p = pair(v);
      if (p) proposed.set(`${p.commit} ${p.path}`, p);
    }
    for (const v of trailers(message, RESOLVED_TRAILER)) {
      const p = pair(v);
      if (p) resolutions.push({ ...p, by: hash });
    }
  }
  const whose = new Map<string, string | null>();
  const personOfCommit = async (c: string) => {
    if (!whose.has(c)) {
      const key = await commitSigner(git, c);
      whose.set(c, key ? ctx.personOf(key) : null);
    }
    return whose.get(c)!;
  };
  const out: Suggestion[] = [];
  for (const s of proposed.values()) {
    if (path !== undefined && s.path !== path) continue;
    if ((await git.run(['cat-file', '-e', `${s.commit}^{commit}`], { allowFail: true })).code !== 0) continue;
    const person = await personOfCommit(s.commit);
    let seen = false;
    for (const r of resolutions) {
      if (r.commit !== s.commit || r.path !== s.path) continue;
      const by = await personOfCommit(r.by);
      if ((by && by === person) || ctx.mayWrite(by, s.path)) seen = true;
    }
    if (seen) continue;
    const then = await git.run(['show', `${s.commit}:${s.path}`], { allowFail: true });
    const now = await git.run(['show', `${branch}:${s.path}`], { allowFail: true });
    const text = then.code === 0 ? then.stdout : null;
    // The file has that text anyway (taken up by an edit): nothing left to suggest.
    if ((now.code === 0 ? now.stdout : null) === text) continue;
    const date = new Date(Number(await git.out(['show', '-s', '--format=%ct', s.commit])) * 1000).toISOString();
    out.push({ commit: s.commit, path: s.path, person, name: person ? ctx.nameOf(person) : null, date, text });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}
