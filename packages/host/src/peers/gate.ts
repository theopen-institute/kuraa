// Who may change what, applied where work comes in (docs/decisions/0066-permissions-without-a-centre.md, step 3).
//
// Bringing another copy's commits in, each commit that is new here is judged by
// who signed it (the person their signing key is) against the workspace's write
// rules (policy.ts). A file whose last change among them is by someone who may
// not change it keeps this side's version in the merge; the change is refused,
// and kept on record in the merge (`Kuraa-Refused`). A later change by someone who
// may takes the file up.
// Every device holding the same policy judges the same commits alike.
//
// Signed commits say which policy they were made under (`Kuraa-Policy`): a
// device that does not hold that much of the policy yet waits before bringing
// them in, so it never judges by less than their maker knew.
//
// Cutoffs (step 4): a commit signed by a key no longer its person's (revoked, or
// dropped when their identity was recovered), or by someone taken out of the
// workspace, counts only if it is among the commits that the revocation or
// removal named (what its maker had then); any other is refused, whatever the
// rules, every file it changes kept as it was here.
//
// Merge commits are made again (step 4): what one holds beyond the merge of its
// parents as this device makes it is its own change, by whoever signed it (a
// merge carrying a live room's text is signed by the device that made it; an
// ordinary merge is no one's), judged as any change is. A file it kept as one
// side had it, saying so, is no change of its own. A merge made by another
// version of merging is checked only for what it holds that neither parent did.
import type { Git } from '../git.js';
import { commitSigner } from '../signing.js';
import type { Policy } from './policy.js';

/** The trailer a signed commit names the policy it was made under with: the policy's heads. */
export const POLICY_TRAILER = 'Kuraa-Policy';
/** A merge's record of a change it refused: `<commit> <path>`. */
export const REFUSED_TRAILER = 'Kuraa-Refused';

export interface GateResult {
  /** Files that keep this side's version: path → its blob here (null: not here). */
  keeps: Map<string, string | null>;
  /** The changes refused, for the merge to keep on record: the commit proposing each file's text, and whose it is. */
  refused: { commit: string; path: string; by: string | null }[];
  /** Policy operations named by commits coming in that this device does not hold yet: wait for them. */
  waitFor: string[];
}

/** A merge's record of which version of merging made it. */
export const MERGE_TRAILER = 'Kuraa-Merge';

export interface GateContext {
  policy: Policy;
  /** Signing keys no longer their person's: whose they were, and the commits that still count (Identity.cutKeys). */
  cutKeys?: Map<string, { person: string; heads: string[] }>;
  /** The tree of the merge of two commits, as this device makes it; and the version of merging it makes it with. */
  remake?: (a: string, b: string) => Promise<string>;
  mergeVersion?: number;
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

/** The policy operations the commits in `theirs` that `ours` does not hold name and this device lacks (0071): cheap, to know before anything else is done. */
export async function policyWaits(git: Git, ours: string | null, theirs: string, known: Set<string>): Promise<string[]> {
  const log = (await git.run(['log', '--format=%B%x1e', ...(ours ? [`${ours}..${theirs}`] : [theirs])], { allowFail: true })).stdout;
  const out = new Set<string>();
  for (const named of trailers(log, POLICY_TRAILER)) for (const h of named.split(/\s+/)) if (/^[0-9a-f]{64}$/.test(h) && !known.has(h)) out.add(h);
  return [...out].sort();
}

/** Judge the commits in `theirs` that `ours` does not hold (null: none, a history arriving for the first time). */
export async function gate(git: Git, ours: string | null, theirs: string, ctx: GateContext): Promise<GateResult> {
  const none: GateResult = { keeps: new Map(), refused: [], waitFor: [] };
  const range = ours ? [`${ours}..${theirs}`] : [theirs];
  // The policy operations they name, all at once first (0071): if one has not come, nothing else is judged yet.
  const messages = new Map<string, string>();
  const log = (await git.run(['log', '--format=%H%x00%B%x1e', ...range], { allowFail: true })).stdout;
  for (const entry of log.split('\x1e')) {
    const at = entry.indexOf('\0');
    if (at < 0) continue;
    messages.set(entry.slice(0, at).trim(), entry.slice(at + 1));
  }
  const waitFor = new Set<string>();
  for (const message of messages.values()) for (const named of trailers(message, POLICY_TRAILER)) for (const h of named.split(/\s+/)) if (/^[0-9a-f]{64}$/.test(h) && !ctx.known.has(h)) waitFor.add(h);
  if (waitFor.size) return { ...none, waitFor: [...waitFor].sort() };
  const list = (await git.run(['rev-list', '--topo-order', '--reverse', '--parents', ...range], { allowFail: true })).stdout.split('\n').filter(Boolean).map((l) => l.split(' '));
  if (!list.length) return none;
  const cutKeys = ctx.cutKeys ?? new Map<string, { person: string; heads: string[] }>();
  const judging = ctx.policy.rules.size > 0 || cutKeys.size > 0 || ctx.policy.cutoffs.size > 0;
  if (!judging) return none;
  // Last refused change of each file (null once someone who may change it has), and the commit that proposes its text.
  const tainted = new Map<string, { commit: string; by: string | null } | null>();
  const among = async (c: string, heads: string[]) => {
    for (const h of heads) if (h === c || (await git.run(['merge-base', '--is-ancestor', c, h], { allowFail: true })).code === 0) return true;
    return false;
  };
  for (const [c, ...parents] of list as [string, ...string[]][]) {
    const message = messages.get(c) ?? await git.out(['show', '-s', '--format=%B', c]);
    const signer = await commitSigner(git, c);
    let by = signer ? ctx.personOf(signer) : null;
    // Past a cutoff: refused, whatever the rules.
    let cut = false;
    const gone = signer ? cutKeys.get(signer) : undefined;
    if (gone) {
      if (await among(c, gone.heads)) by = gone.person;
      else cut = true;
    } else if (by && ctx.policy.cutoffs.has(by) && !(await among(c, ctx.policy.cutoffs.get(by)!))) cut = true;
    const changed = parents.length >= 2
      ? await mergeChanges(git, c, parents, message, ctx)
      : (await git.run(['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', '--no-renames', '--root', c])).stdout.split('\0').filter(Boolean);
    for (const path of changed) {
      // By someone who may: taken, and whatever was refused before it with it.
      if (!cut && ctx.policy.mayWrite(by, path)) tainted.set(path, null);
      else tainted.set(path, { commit: c, by });
    }
  }
  const keeps = new Map<string, string | null>();
  const refused: GateResult['refused'] = [];
  for (const [path, t] of [...tainted].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (!t) continue;
    const here = ours ? (await git.run(['ls-tree', '-z', ours, '--', path])).stdout.split('\0').filter(Boolean)[0] : undefined;
    keeps.set(path, here ? here.split(/\s+/)[2]! : null);
    refused.push({ commit: t.commit, path, by: t.by ? ctx.nameOf(t.by) ?? null : null });
  }
  return { keeps, refused, waitFor: [] };
}

/** A file's blob in a commit; null if it has none. */
async function blobAt(git: Git, commit: string, path: string): Promise<string | null> {
  const r = await git.run(['rev-parse', '-q', '--verify', `${commit}:${path}`], { allowFail: true });
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * What a merge holds of its own: the files where it differs from the merge of
 * its parents as this device makes it (where it was made by the same version
 * of merging; else, where it differs from both parents), but for those it kept
 * as one side had them, saying so.
 */
async function mergeChanges(git: Git, merge: string, parents: string[], message: string, ctx: GateContext): Promise<string[]> {
  const files = async (a: string, b: string) => (await git.run(['diff-tree', '-r', '--name-only', '-z', '--no-renames', a, b])).stdout.split('\0').filter(Boolean);
  let differs: string[];
  const version = trailers(message, MERGE_TRAILER)[0];
  if (parents.length === 2 && ctx.remake && version === String(ctx.mergeVersion)) {
    differs = await files(await ctx.remake(parents[0]!, parents[1]!), `${merge}^{tree}`);
  } else {
    const sets = await Promise.all(parents.map((p) => files(p, merge)));
    differs = sets[0]!.filter((p) => sets.every((s) => s.includes(p)));
  }
  const kept = new Set(message.split('\n').map((l) => /^Kept (.+) as it was: not .+ to change$/.exec(l)?.[1]).filter((x): x is string => !!x));
  const out: string[] = [];
  for (const path of differs) {
    if (kept.has(path)) {
      const mine = await blobAt(git, merge, path);
      let fromSide = false;
      for (const p of parents) if ((await blobAt(git, p, path)) === mine) fromSide = true;
      if (fromSide) continue;
    }
    out.push(path);
  }
  return out;
}
