// Whose work a device accepts on its own (docs/decisions/0032-accepting-work.md,
// 0033-document-rules-and-people.md).
//
// A device fetches every member's work and shows all of it; what it decides is
// which of it comes into its branches without asking. By default, every
// member's, everywhere. A rule names a branch, and a folder or file in it (or
// none: the whole branch), and the devices or people whose work comes in there:
// - On a whole branch, others' work waits as a proposal, to accept or leave.
// - On a folder or file, others' history still comes in, but this device keeps
//   its own version of what the rule covers; their version can be taken later.
// The most specific rule for a file is the one that counts. Live editing follows
// the same rules: a device applies another's live edits to a document only if it
// would accept its commits to it.
//
// Likewise for changes to the members: every member's, or only these devices'
// or people's. Nothing here is shared or agreed: each device's rules are its own,
// published so others can see them (records.ts), and a device that accepts no
// one's work drifts apart, and may always fork.

/** One rule: on `branch`, in `path` ('' the whole branch; 'dir/' a folder; else a file), work comes in only from `from`. */
export interface AcceptRule {
  branch: string;
  path: string;
  /** Device keys or person keys, hex (this device's own key for "only its own"). */
  from: string[];
}

/** Whose work this device accepts on its own. */
export interface AcceptRules {
  rules: AcceptRule[];
  /** The devices or people whose changes to the members this device accepts; null: every member's. */
  membership: string[] | null;
}

export const EVERYONE: AcceptRules = { rules: [], membership: null };

/** The rule that counts for a file on a branch: the most specific one, if any. */
export function ruleFor(rules: AcceptRule[] | undefined, branch: string, path: string): AcceptRule | undefined {
  let best: AcceptRule | undefined;
  for (const r of rules ?? []) {
    if (r.branch !== branch) continue;
    const covers = r.path === '' || r.path === path || (r.path.endsWith('/') && path.startsWith(r.path));
    if (covers && (!best || r.path.length > best.path.length)) best = r;
  }
  return best;
}

/** Whether, by these rules, work from one with these identities (a device key, and its person's) comes in on `branch` as a whole. */
export function acceptsBranch(rules: AcceptRule[] | undefined, who: string[], branch: string): boolean {
  const r = (rules ?? []).find((x) => x.branch === branch && x.path === '');
  return !r || r.from.some((k) => who.includes(k));
}

/** Whether, by these rules, work from one with these identities comes in on `branch` for the file at `path`. */
export function acceptsPath(rules: AcceptRule[] | undefined, who: string[], branch: string, path: string): boolean {
  const r = ruleFor(rules, branch, path);
  return !r || r.from.some((k) => who.includes(k));
}

/**
 * Whether this device commits a room it has open with others, on `branch` at
 * `path`. Devices that accept each other's edits to it hold the same room, and
 * the lowest key among them commits it. A device none of the others there
 * accepts commits only what was edited on it (`localEdits`): what it took from
 * the others, they commit.
 */
export function commitsRoom(me: { key: string; who: string[]; rules?: AcceptRule[] }, others: { key: string; who: string[]; rules?: AcceptRule[] }[], branch: string, path: string, localEdits: boolean): boolean {
  const mutual = others.filter((o) => acceptsPath(me.rules, o.who, branch, path) && acceptsPath(o.rules, me.who, branch, path));
  if (!mutual.length) return localEdits || !others.length;
  return [me.key, ...mutual.map((o) => o.key)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))[0] === me.key;
}

const isKey = (k: unknown): k is string => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k);

/** A rule's path, as rules keep it: relative, with '/', a folder ending in '/'; '' for the whole branch. */
export function rulePath(p: string): string {
  const clean = p.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '').replace(/\/{2,}/g, '/');
  return clean === '.' ? '' : clean;
}

/** Rules from untrusted JSON (a file, a record, an invitation): only what is well formed. */
export function readRules(v: unknown): AcceptRules {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const rules: AcceptRule[] = [];
  if (Array.isArray(o.rules)) {
    for (const r of o.rules as Record<string, unknown>[]) {
      if (!r || typeof r.branch !== 'string' || !r.branch || typeof r.path !== 'string' || !Array.isArray(r.from)) continue;
      rules.push({ branch: r.branch, path: rulePath(r.path), from: [...new Set(r.from.filter(isKey))] });
    }
  }
  // One rule per branch and path: the last given.
  const one = new Map(rules.map((r) => [`${r.branch}\0${r.path}`, r]));
  return { rules: [...one.values()], membership: Array.isArray(o.membership) ? [...new Set(o.membership.filter(isKey))] : null };
}

/** Rules as one string, the same for the same rules (records sign it; invitations carry it). */
export function canonicalRules(r: AcceptRules): string {
  const rules = [...r.rules].map((x) => ({ branch: x.branch, path: x.path, from: [...x.from].sort() }))
    .sort((a, b) => (`${a.branch}\0${a.path}` < `${b.branch}\0${b.path}` ? -1 : 1));
  return JSON.stringify({ rules, membership: r.membership ? [...r.membership].sort() : null });
}

/** Rules as one field of an invitation or link. */
export const encodeRules = (r: AcceptRules) => Buffer.from(canonicalRules(r)).toString('base64url');

/** Rules from one field of an invitation or link; null if it is missing or damaged. */
export function decodeRules(field: string | undefined): AcceptRules | null {
  if (!field) return null;
  try {
    return readRules(JSON.parse(Buffer.from(field, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}
