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
// them in, so it never judges by less than their maker knew. It asks the device
// they came from, which holds every operation its commits name (it waited for
// them itself): one it says it does not hold is no one's, and is not waited for
// (peers.ts, knownFrom); the commits are judged by the policy held.
//
// Cutoffs (step 4): a commit signed by a key no longer its person's (revoked, or
// dropped when their identity was recovered), or by someone taken out of the
// workspace, counts only if it is among the commits that the revocation or
// removal named (what its maker had then); any other is refused, whatever the
// rules, every file it changes kept as it was here.
//
// Whoever made it, a change that would put a link (a symlink) in the workspace,
// or a path that differs from another in it only by case or Unicode form (one
// file, on the disks of most Macs and of Windows: a way round a rule on the
// other) is refused the same way. What a device judges by is the commit
// itself, and the rules: every device judges it alike.
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
  /** The tree of the merge of two commits, as this device makes it; and what its merges' trailer says (merging.ts, mergeTrailerValue). */
  remake?: (a: string, b: string) => Promise<string>;
  mergeTrailer?: string;
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
  // Last refused change of each file (null once someone who may change it has), and the commit that proposes its text.
  const tainted = new Map<string, { commit: string; by: string | null } | null>();
  const among = async (c: string, heads: string[]) => {
    for (const h of heads) if (h === c || (await git.run(['merge-base', '--is-ancestor', c, h], { allowFail: true })).code === 0) return true;
    return false;
  };
  // Write rules, or cutoffs, to judge by; else only what no one brings in this way (unsafePaths).
  const judging = ctx.policy.rules.size > 0 || cutKeys.size > 0 || ctx.policy.cutoffs.size > 0;
  for (const [c, ...parents] of list as [string, ...string[]][]) {
    if (!judging) {
      const changed = (await git.run(['diff-tree', '-r', '--no-commit-id', '--name-only', '-z', '--no-renames', '--root', ...(parents.length >= 2 ? [parents[0]!] : []), c])).stdout.split('\0').filter(Boolean);
      const unsafe = await unsafePaths(git, c, parents, changed, ctx.policy);
      if (!unsafe.size) {
        for (const path of changed) tainted.set(path, null);
        continue;
      }
      const signer = await commitSigner(git, c);
      const by = signer ? ctx.personOf(signer) : null;
      for (const path of changed) tainted.set(path, unsafe.has(path) ? { commit: c, by } : null);
      continue;
    }
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
    const unsafe = await unsafePaths(git, c, parents, changed, ctx.policy);
    for (const path of changed) {
      // By someone who may: taken, and whatever was refused before it with it.
      if (!cut && !unsafe.has(path) && ctx.policy.mayWrite(by, path)) tainted.set(path, null);
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

/** A path as a disk that tells neither case nor Unicode forms apart takes it (most Macs', Windows'). */
export const foldPath = (path: string) => path.normalize('NFC').toLowerCase();

/** A path and each folder it is in: `a/b/c` → `a/`, `a/b/`, `a/b/c`. */
const prefixes = (path: string) => path.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/') + (i < parts.length - 1 ? '/' : ''));

/**
 * The paths a commit changes that no one may bring in this way: a link (a
 * symlink: git checks it out as one, and it can point anywhere), or a path new
 * in it that is another in it, or one a rule names, but for case or Unicode
 * form (on a disk that tells them apart by neither, the same file).
 */
async function unsafePaths(git: Git, commit: string, parents: string[], changed: string[], policy: Policy): Promise<Set<string>> {
  const out = new Set<string>();
  if (!changed.length) return out;
  const modes = await entries(git, commit, changed);
  for (const [path, mode] of modes) if (mode === '120000') out.add(path);
  // New here: in the commit, and not in its first parent (as it is spelled).
  const before = parents[0] ? await entries(git, parents[0], changed) : new Map<string, string>();
  const added = changed.filter((p) => modes.has(p) && !before.has(p));
  if (!added.length) return out;
  // Each spelling of each path and folder in the commit, and in the rules, by how a disk folds it.
  const spellings = new Map<string, Set<string>>();
  const note = (p: string) => {
    const f = foldPath(p);
    const had = spellings.get(f);
    if (had) had.add(p);
    else spellings.set(f, new Set([p]));
  };
  const tree = (await git.run(['ls-tree', '-r', '-z', '--name-only', commit])).stdout.split('\0').filter(Boolean);
  for (const p of tree) for (const q of prefixes(p)) note(q);
  for (const key of policy.perms.keys()) if (key && !key.startsWith('h:')) note(key);
  for (const p of added) if (prefixes(p).some((q) => [...(spellings.get(foldPath(q)) ?? [])].some((x) => x !== q))) out.add(p);
  return out;
}

/** The entries for some paths in a commit: path → mode (none for a path it has not). */
async function entries(git: Git, commit: string, paths: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < paths.length; i += 500) {
    // The paths as they are spelt in the commits (git on a Mac would otherwise compose them, and find another).
    const listed = (await git.run(['-c', 'core.precomposeunicode=false', '--literal-pathspecs', 'ls-tree', '-z', '--full-tree', commit, '--', ...paths.slice(i, i + 500)], { allowFail: true })).stdout;
    for (const entry of listed.split('\0').filter(Boolean)) {
      const tab = entry.indexOf('\t');
      if (tab > 0) out.set(entry.slice(tab + 1), entry.split(' ')[0]!);
    }
  }
  return out;
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
  if (parents.length === 2 && ctx.remake && version === ctx.mergeTrailer) {
    differs = await files(await ctx.remake(parents[0]!, parents[1]!), `${merge}^{tree}`);
  } else {
    const sets = await Promise.all(parents.map((p) => files(p, merge)));
    differs = sets[0]!.filter((p) => sets.every((s) => s.includes(p)));
  }
  const kept = new Set(message.split('\n').map((l) => /^Kept (.+) as it was: not .+ to change$/.exec(l)?.[1]).filter((x): x is string => !!x));
  const out: string[] = [];
  // Where both sides' changes were kept out, the merge keeps the file as it was where they parted (host.ts, judgeBoth).
  let base: string | null | undefined;
  const mergeBase = async () => {
    if (base === undefined) base = parents.length === 2 ? ((await git.run(['merge-base', parents[0]!, parents[1]!], { allowFail: true })).stdout.trim() || null) : null;
    return base;
  };
  for (const path of differs) {
    if (kept.has(path)) {
      const mine = await blobAt(git, merge, path);
      let fromSide = false;
      for (const p of parents) if ((await blobAt(git, p, path)) === mine) fromSide = true;
      const parted = fromSide ? null : await mergeBase();
      if (!fromSide && parted && (await blobAt(git, parted, path)) === mine) fromSide = true;
      if (fromSide) continue;
    }
    out.push(path);
  }
  return out;
}
