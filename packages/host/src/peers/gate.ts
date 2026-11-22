// Who may change what, applied where work comes in (docs/decisions/0066-permissions-without-a-centre.md, step 3).
//
// Bringing another copy's commits in, each commit that is new here is judged by
// who signed it (the person their signing key is) against the workspace's write
// rules (policy.ts). A file whose last change among them is by someone who may
// not change it keeps this side's version in the merge; the change is refused,
// and kept on record in the merge (`Kuraa-Refused`), where those who may change
// the file see it as a suggestion. A later change by someone who may takes it up.
// Every device holding the same policy judges the same commits alike.
//
// Signed commits say which policy they were made under (`Kuraa-Policy`): a
// device that does not hold that much of the policy yet waits before bringing
// them in, so it never judges by less than their maker knew.
//
// Merge commits are judged as no one's change: they bring together what their
// parents hold (checking that they do, by making them again, is for later).
import type { Git } from '../git.js';
import { commitSigner } from '../signing.js';
import type { Policy } from './policy.js';

/** The trailer a signed commit names the policy it was made under with: the policy's heads. */
export const POLICY_TRAILER = 'Kuraa-Policy';
/** A merge's record of a change it refused: `<commit> <path>`. */
export const REFUSED_TRAILER = 'Kuraa-Refused';
/** A suggestion made as such (Suggest): the commit proposes this path's text. */
export const SUGGESTION_TRAILER = 'Kuraa-Suggestion';
/** The commit that takes a suggestion back off the suggester's own copy: names the suggestion. */
export const SUGGESTED_TRAILER = 'Kuraa-Suggested';
/** A suggestion seen to: accepted or dismissed, `<commit> <path>`. */
export const RESOLVED_TRAILER = 'Kuraa-Resolved';

export interface GateResult {
  /** Files that keep this side's version: path → its blob here (null: not here). */
  keeps: Map<string, string | null>;
  /** The changes refused, for the merge to keep on record: the commit proposing each file's text, and whose it is. */
  refused: { commit: string; path: string; by: string | null }[];
  /** Policy operations named by commits coming in that this device does not hold yet: wait for them. */
  waitFor: string[];
}

export interface GateContext {
  policy: Policy;
  /** The policy operations this device holds. */
  known: Set<string>;
  /** The person (identity ID) a signing key is; null if no one's. */
  personOf(signingKey: string): string | null;
  /** A person's name, to say whose a refused change is. */
  nameOf(id: string): string | null;
}

/** A commit's trailers of one kind, as `git interpret-trailers` would read them. */
export function trailers(message: string, key: string): string[] {
  const out: string[] = [];
  for (const line of message.split('\n')) {
    const m = new RegExp(`^${key}:\\s*(.+)$`).exec(line);
    if (m) out.push(m[1]!.trim());
  }
  return out;
}

/** Judge the commits in `theirs` that `ours` does not hold. */
export async function gate(git: Git, ours: string, theirs: string, ctx: GateContext): Promise<GateResult> {
  const none: GateResult = { keeps: new Map(), refused: [], waitFor: [] };
  const list = (await git.run(['rev-list', '--topo-order', '--reverse', '--no-merges', `${ours}..${theirs}`], { allowFail: true })).stdout.split('\n').filter(Boolean);
  if (!list.length) return none;
  const waitFor = new Set<string>();
  // Last refused change of each file (null once someone who may change it has), and the commit that proposes its text.
  const tainted = new Map<string, { commit: string; by: string | null } | null>();
  for (const c of list) {
    const message = await git.out(['show', '-s', '--format=%B', c]);
    for (const named of trailers(message, POLICY_TRAILER)) for (const h of named.split(/\s+/)) if (/^[0-9a-f]{64}$/.test(h) && !ctx.known.has(h)) waitFor.add(h);
    if (!ctx.policy.rules.size) continue;
    const signer = await commitSigner(git, c);
    const by = signer ? ctx.personOf(signer) : null;
    const changed = (await git.run(['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', '--no-renames', '--root', c])).stdout.split('\0').filter(Boolean);
    // Taking one's own suggestion back off one's copy proposes nothing: the suggestion before it does.
    const takesBack = trailers(message, SUGGESTED_TRAILER).length > 0;
    for (const path of changed) {
      // By someone who may: taken, and whatever was refused before it with it.
      if (ctx.policy.mayWrite(by, path)) tainted.set(path, null);
      // A taking back: still not theirs to change; the suggestion before it, if any, is what is proposed.
      else if (takesBack) tainted.set(path, tainted.get(path) ?? { commit: '', by });
      else tainted.set(path, { commit: c, by });
    }
  }
  if (waitFor.size) return { ...none, waitFor: [...waitFor].sort() };
  const keeps = new Map<string, string | null>();
  const refused: GateResult['refused'] = [];
  for (const [path, t] of [...tainted].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!t) continue;
    const here = (await git.run(['ls-tree', '-z', ours, '--', path])).stdout.split('\0').filter(Boolean)[0];
    keeps.set(path, here ? here.split(/\s+/)[2]! : null);
    if (t.commit) refused.push({ commit: t.commit, path, by: t.by ? ctx.nameOf(t.by) ?? null : null });
  }
  return { keeps, refused, waitFor: [] };
}
