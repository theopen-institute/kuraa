// A workspace's policy: who is in it, in which groups, as admins or members
// (docs/decisions/0066-permissions-without-a-centre.md).
//
// The policy is a history of signed operations, each naming the operations its
// maker had seen (its parents), so they form a graph that every device holds
// alike. Each is signed by the signing key of a person (the identity that
// vouched for that key is who made it), and checked against the policy as the
// operations before it left it. Every device puts the same operations in the
// same order (parents first, then by hash) and so reaches the same policy, from
// whatever order they arrived in.
//
// - genesis: the first, naming the workspace's first admins. A workspace made
//   since is pinned to its genesis (`kuraa.genesis`, and every invite link
//   carries it): no other counts. One from before has none pinned: each of its
//   devices writes down, as a legacy genesis, everyone it knows of, and all of
//   them count together (everyone an admin, as every member had the same say:
//   0038), until an admin seals the list: then only the geneses the seal names.
// - grant, revoke: a person put in a group (as admin or member) or taken out.
//   An admin of the group, or of the workspace, may. Taking someone out of the
//   workspace takes them out of every group. The workspace keeps one admin at
//   least; anyone may leave a group.
// - join: whoever was let in by an invite link puts themselves in the group the
//   link names, as it says, signed by an admin of it (the link's grant). A link
//   for one person puts one in.
//
// - rule: who may change what (0066, step 3): a path (the whole workspace `''`,
//   a folder `dir/`, or a file) and who may write there: people, groups
//   (`group:<name>`), or the workspace's admins (`admins`). The most specific
//   rule for a file counts; with none, anyone may. Only the workspace's admins
//   make rules; a rule naming no one is taken away.
//
// - space: who may read a set of files (0066, step 5): a space's ID and its
//   audience (people, `group:<name>`, `admins`), like a rule's. Anyone in the
//   workspace may make one they are in themselves; its audience may be changed
//   by whoever made it, or by the workspace's admins. Files not in a space are
//   the workspace's: everyone in it reads them.
//
// - verifier: a server whose attestations count here (attest.ts, step 6): its
//   key and where it is; an admin's to add, or take away (with no address).
//
// Anywhere a person can be named (a group, a rule, an audience), `email:<address>`
// names whoever holds an attestation of that address by a verifier counted here.
//
// Groups: `workspace` (everyone in it), and any an admin of the workspace makes
// by putting someone in it. A group may hold people (identity IDs) and, as
// members, other groups (`group:<name>`).
import { createHash } from 'node:crypto';
import crypto from 'hypercore-crypto';
import type { KeyPair } from '../keys.js';

export type Role = 'admin' | 'member';

export type PolicyOp =
  | { t: 'genesis'; admins: string[]; legacy: boolean }
  | { t: 'grant'; group: string; who: string; role: Role }
  | { t: 'revoke'; group: string; who: string; cutoff?: string[] }
  | { t: 'join'; group: string; role: Role; link: string; once: boolean; granter: string; grant: string }
  | { t: 'seal'; geneses: string[] }
  | { t: 'rule'; path: string; by: string[] }
  | { t: 'space'; id: string; audience: string[] }
  | { t: 'verifier'; key: string; url: string };

/** A policy operation as a record carries it (records.ts, kind `policy`). */
export interface PolicyEntry {
  /** Its hash (opHash): what operations after it name as parents. */
  id: string;
  op: PolicyOp;
  parents: string[];
  /** The signing key that signed it: the person's who made it. */
  signer: string;
  proof: string;
}

export const WORKSPACE = 'workspace';
const hexKey = /^[0-9a-f]{64}$/;
const hexSig = /^[0-9a-f]{128}$/;
const groupName = /^[a-z0-9][a-z0-9-]{0,39}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Whether a name is one a group can have. */
export const isGroupName = (name: string) => groupName.test(name);

function encodeOp(op: PolicyOp): string {
  switch (op.t) {
    case 'genesis': return ['genesis', op.admins.join(','), op.legacy ? 'legacy' : ''].join('\0');
    case 'grant': return ['grant', op.group, op.who, op.role].join('\0');
    case 'revoke': return ['revoke', op.group, op.who, ...(op.cutoff ? [op.cutoff.join(',')] : [])].join('\0');
    case 'join': return ['join', op.group, op.role, op.link, op.once ? 'once' : 'anyone', op.granter, op.grant].join('\0');
    case 'seal': return ['seal', op.geneses.join(',')].join('\0');
    case 'rule': return ['rule', op.path, op.by.join(',')].join('\0');
    case 'space': return ['space', op.id, op.audience.join(',')].join('\0');
    case 'verifier': return ['verifier', op.key, op.url].join('\0');
  }
}

/** What a person's signing key signs to make an operation, in one workspace. */
export const policyMessage = (workspace: string, op: PolicyOp, parents: string[], signer: string) =>
  Buffer.from(['kuraa-policy', workspace, encodeOp(op), [...parents].sort().join(','), signer].join('\0'));

/** An operation's hash. */
export const opHash = (workspace: string, op: PolicyOp, parents: string[], signer: string) => sha256(policyMessage(workspace, op, parents, signer).toString('latin1'));

/** What an admin's signing key signs to let an invite link's holder into a group (the link's grant). */
export const grantMessage = (workspace: string, genesis: string | null, link: string, group: string, role: Role, once: boolean) =>
  Buffer.from(['kuraa-grant', workspace, genesis ?? '', link, group, role, once ? 'once' : 'anyone'].join('\0'));

/** Make an operation, signed with a person's signing key. */
export function makeOp(workspace: string, op: PolicyOp, parents: string[], key: KeyPair): PolicyEntry {
  const signer = key.publicKey.toString('hex');
  const sorted = [...new Set(parents)].sort();
  return { id: opHash(workspace, op, sorted, signer), op, parents: sorted, signer, proof: crypto.sign(policyMessage(workspace, op, sorted, signer), key.secretKey).toString('hex') };
}

const sortedUnique = (list: unknown, test: RegExp): string[] | null => {
  if (!Array.isArray(list) || list.length > 1000 || !list.every((x) => typeof x === 'string' && test.test(x))) return null;
  const s = [...new Set(list as string[])].sort();
  return s.join() === (list as string[]).join() ? s : null;
};

const emailEntry = 'email:[^\\s@,]{1,64}@[^\\s@,]{1,190}\\.[^\\s@,.A-Z]{2,63}';
const whoTest = new RegExp(`^(?:[0-9a-f]{64}|group:[a-z0-9][a-z0-9-]{0,39}|${emailEntry})$`);
const writerTest = new RegExp(`^(?:[0-9a-f]{64}|group:[a-z0-9][a-z0-9-]{0,39}|admins|${emailEntry})$`);

/** Whether a string names someone in a group, rule or audience: an identity, a group, the admins, or an email (step 6). */
export const isWriter = (w: string) => writerTest.test(w);

/** Whether a path is one a rule can name: `''` (everything), `dir/` (a folder), or a file; relative, with no `.` or `..` parts. */
export function isRulePath(path: string): boolean {
  if (path === '') return true;
  if (path.length > 500 || path.startsWith('/') || path.includes('\0') || path.includes('\\')) return false;
  const parts = (path.endsWith('/') ? path.slice(0, -1) : path).split('/');
  return parts.every((p) => p !== '' && p !== '.' && p !== '..');
}

/** An operation from elsewhere, checked for shape (not for who may make it); null if it is not one. */
export function readOp(v: unknown): PolicyOp | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const role = (r: unknown): r is Role => r === 'admin' || r === 'member';
  switch (o.t) {
    case 'genesis': {
      const admins = sortedUnique(o.admins, hexKey);
      return admins && typeof o.legacy === 'boolean' ? { t: 'genesis', admins, legacy: o.legacy } : null;
    }
    case 'grant':
      return typeof o.group === 'string' && groupName.test(o.group) && typeof o.who === 'string' && whoTest.test(o.who) && role(o.role)
        ? { t: 'grant', group: o.group, who: o.who, role: o.role } : null;
    case 'revoke': {
      if (typeof o.group !== 'string' || !groupName.test(o.group) || typeof o.who !== 'string' || !whoTest.test(o.who)) return null;
      if (o.cutoff === undefined) return { t: 'revoke', group: o.group, who: o.who };
      const cutoff = sortedUnique(o.cutoff, /^[0-9a-f]{40,64}$/);
      return cutoff ? { t: 'revoke', group: o.group, who: o.who, cutoff } : null;
    }
    case 'join':
      return typeof o.group === 'string' && groupName.test(o.group) && role(o.role) && typeof o.link === 'string' && /^[0-9a-f]{16}$/.test(o.link)
        && typeof o.once === 'boolean' && typeof o.granter === 'string' && hexKey.test(o.granter) && typeof o.grant === 'string' && hexSig.test(o.grant)
        ? { t: 'join', group: o.group, role: o.role, link: o.link, once: o.once, granter: o.granter, grant: o.grant } : null;
    case 'seal': {
      const geneses = sortedUnique(o.geneses, hexKey);
      return geneses && geneses.length ? { t: 'seal', geneses } : null;
    }
    case 'rule': {
      const by = sortedUnique(o.by, writerTest);
      return typeof o.path === 'string' && isRulePath(o.path) && by ? { t: 'rule', path: o.path, by } : null;
    }
    case 'space': {
      const audience = sortedUnique(o.audience, writerTest);
      return typeof o.id === 'string' && /^[0-9a-f]{32}$/.test(o.id) && audience && audience.length ? { t: 'space', id: o.id, audience } : null;
    }
    case 'verifier':
      return typeof o.key === 'string' && hexKey.test(o.key) && typeof o.url === 'string' && o.url.length <= 500 && (o.url === '' || /^https?:\/\/\S+$/.test(o.url))
        ? { t: 'verifier', key: o.key, url: o.url } : null;
    default:
      return null;
  }
}

/** Whether an entry is as its signer made it, for this workspace: shape, hash and signature. */
export function entrySigned(workspace: string, e: PolicyEntry): boolean {
  if (!hexKey.test(e.signer) || !hexSig.test(e.proof) || !e.parents.every((p) => hexKey.test(p))) return false;
  if ([...new Set(e.parents)].sort().join() !== e.parents.join()) return false;
  if (e.id !== opHash(workspace, e.op, e.parents, e.signer)) return false;
  return crypto.verify(policyMessage(workspace, e.op, e.parents, e.signer), Buffer.from(e.proof, 'hex'), Buffer.from(e.signer, 'hex'));
}

export interface PolicyContext {
  workspace: string;
  /** The genesis this workspace is pinned to; null: one from before, whose legacy geneses count. */
  pin: string | null;
  /** The person (identity ID) a signing key is, as the records show; null if no one's. */
  personOf(signingKey: string): string | null;
  /** The emails attested of a person by verifiers this workspace counts (step 6). */
  claimsOf?: (id: string) => string[];
  /** Every email attested of anyone by those verifiers (who has been invited by email and is in: step 6). */
  claimed?: Set<string>;
}

export class Policy {
  constructor(
    /** Each group's people and groups, by role. */
    readonly groups: Map<string, Map<string, Role>>,
    /** The geneses that count. */
    readonly geneses: string[],
    /** The operations that counted, in the order they were applied. */
    readonly applied: string[],
    /** The operations no other names as a parent: what a new one names. */
    readonly heads: string[],
    /** Links for one person that let someone in. */
    readonly usedLinks: Set<string>,
    /** A workspace from before: an admin sealed its legacy geneses. */
    readonly sealed = false,
    /** Who may write where: path → who (rule). */
    readonly rules = new Map<string, string[]>(),
    /** Removals of admins made at the same time that would have left none, so none stood (step 4): who, and the operations. */
    readonly disputes: { people: string[]; ops: string[] }[] = [],
    /** People out of the workspace, and the commits they had made that still count (their removals' cutoffs, gate.ts). */
    readonly cutoffs = new Map<string, string[]>(),
    /** Spaces (step 5): ID → who may read it, and who made it. */
    readonly spaces = new Map<string, { audience: string[]; by: string }>(),
    /** Verifiers whose attestations count here (step 6): key → where it is. */
    readonly verifiers = new Map<string, string>(),
    /** The emails attested of a person (by verifiers counted here). */
    readonly claimsOf: (id: string) => string[] = () => [],
    /** Every email attested of anyone (by verifiers counted here). */
    readonly claimed = new Set<string>(),
  ) {}

  /** Whether an entry naming someone (`email:` included) names this person. */
  private names(entry: string, id: string): boolean {
    return entry === id || (entry.startsWith('email:') && this.claimsOf(id).includes(entry.slice(6)));
  }

  /** Whether an audience entry (a person, `group:<name>`, `admins`) holds a person. */
  private holds(entry: string, id: string): boolean {
    return this.names(entry, id) || (entry === 'admins' && this.isAdmin(id)) || (entry.startsWith('group:') && this.role(id, entry.slice(6)) !== null);
  }

  /**
   * Whether a person may read a space (null: the workspace's own files, which
   * everyone in it reads; anyone, where there is no policy). A space unknown
   * here (its operation not yet come) is read by no one.
   */
  mayRead(id: string | null, space: string | null): boolean {
    if (!this.founded) return space === null;
    if (!id || !this.role(id)) return false;
    if (space === null) return true;
    const s = this.spaces.get(space);
    return !!s && s.audience.some((e) => this.holds(e, id));
  }

  /** Everyone in the workspace who may read a space now: for whether one audience holds another (what code may read). */
  readers(space: string | null): Set<string> {
    return new Set([...(this.groups.get(WORKSPACE)?.keys() ?? [])].filter((id) => /^[0-9a-f]{64}$/.test(id) && this.mayRead(id, space)));
  }

  /** The rule that counts for a file: the most specific path that holds it; null if none. */
  ruleFor(path: string): { path: string; by: string[] } | null {
    let best: string | null = null;
    for (const r of this.rules.keys()) {
      const holds = r === '' || r === path || (r.endsWith('/') && path.startsWith(r));
      if (holds && (best === null || r.length > best.length)) best = r;
    }
    return best === null ? null : { path: best, by: this.rules.get(best)! };
  }

  /** Whether a person (null: no one's, as an unsigned commit) may change a file: by its rule, or anyone if it has none. */
  mayWrite(id: string | null, path: string): boolean {
    const rule = this.ruleFor(path);
    if (!rule) return true;
    if (!id) return false;
    return rule.by.some((w) => this.names(w, id) || (w === 'admins' && this.isAdmin(id)) || (w.startsWith('group:') && this.role(id, w.slice(6)) !== null));
  }

  /** Whether there is a policy at all (a genesis that counts). */
  get founded(): boolean {
    return this.geneses.length > 0;
  }

  /** A person's role in a group: by their own entry, or (as a member) through a group in it. Outside the workspace, in none. */
  role(id: string, group: string = WORKSPACE): Role | null {
    if (group !== WORKSPACE && !this.roleIn(id, WORKSPACE, new Set())) return null;
    return this.roleIn(id, group, new Set());
  }

  private roleIn(id: string, group: string, seen: Set<string>): Role | null {
    if (seen.has(group)) return null;
    seen.add(group);
    const g = this.groups.get(group);
    if (!g) return null;
    const own = g.get(id) ?? [...g].find(([who]) => who.startsWith('email:') && this.names(who, id))?.[1];
    if (own) return own;
    for (const who of g.keys()) if (who.startsWith('group:') && this.roleIn(id, who.slice(6), seen)) return 'member';
    return null;
  }

  isAdmin(id: string | null, group: string = WORKSPACE): boolean {
    return !!id && (this.role(id, WORKSPACE) === 'admin' || (group !== WORKSPACE && this.role(id, group) === 'admin'));
  }

  /** The people (not groups) with an entry in a group, and their roles. */
  people(group: string = WORKSPACE): { id: string; role: Role }[] {
    return [...(this.groups.get(group) ?? new Map<string, Role>())].filter(([who]) => /^[0-9a-f]{64}$/.test(who)).map(([id, role]) => ({ id, role }));
  }

  /** People named by email in a group whom no identity here is attested to be yet: invited, not (yet) in (step 6). */
  invited(group: string = WORKSPACE): { email: string; role: Role }[] {
    return [...(this.groups.get(group) ?? new Map<string, Role>())]
      .filter(([who]) => who.startsWith('email:') && !this.claimed.has(who.slice(6)))
      .map(([who, role]) => ({ email: who.slice(6), role }));
  }

  /** A short name for the policy as it is: the hash of its heads (what a commit made under it names, later). */
  get version(): string {
    return sha256(`kuraa-policy-version\0${this.heads.join(',')}`);
  }
}

/** The policy the operations make, in this workspace (see the top of this file). */
export function evaluate(entries: PolicyEntry[], ctx: PolicyContext): Policy {
  const byId = new Map<string, PolicyEntry>();
  for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e);
  const order = linearize(byId);
  const genesisOk = (e: PolicyEntry) => e.op.t === 'genesis' && (ctx.pin ? e.id === ctx.pin && !e.op.legacy : e.op.legacy);
  const all = order.filter((e) => genesisOk(e)).map((e) => e.id);
  const first = apply(order, all, ctx);
  // A workspace from before: once an admin sealed its legacy geneses, only those the seal names.
  if (!ctx.pin && first.seal) {
    const named = all.filter((g) => first.seal!.includes(g));
    const second = apply(order, named, ctx);
    return second.policy;
  }
  return first.policy;
}

/** Parents first, then by hash; operations whose parents are not all known wait (left out). */
function linearize(byId: Map<string, PolicyEntry>): PolicyEntry[] {
  const known = new Set<string>();
  const out: PolicyEntry[] = [];
  let pending = [...byId.values()].filter((e) => (e.op.t === 'genesis') === (e.parents.length === 0));
  for (;;) {
    // One at a time, the lowest of those ready first: an operation that becomes ready meanwhile is sorted with the rest.
    const ready = pending.filter((e) => e.parents.every((p) => known.has(p))).sort((a, b) => (a.id < b.id ? -1 : 1));
    const next = ready[0];
    if (!next) return out;
    out.push(next);
    known.add(next.id);
    pending = pending.filter((e) => e !== next);
  }
}

/** What a policy is made of, as operations are applied to it. */
interface State {
  groups: Map<string, Map<string, Role>>;
  rules: Map<string, string[]>;
  spaces: Map<string, { audience: string[]; by: string }>;
  verifiers: Map<string, string>;
  usedLinks: Set<string>;
  seal: string[] | null;
  applied: string[];
}

/** An operation that takes someone out of a group, or makes them no longer its admin: what its cutoff is about (step 4). */
interface Removal {
  /** Who. */
  person: string;
  group: string;
  kind: 'out' | 'demote';
  /** They were an admin of the group before it. */
  wasAdmin: boolean;
}

const view = (s: State, claims?: (id: string) => string[]) => new Policy(s.groups, [], s.applied, [], s.usedLinks, !!s.seal, s.rules, [], new Map(), s.spaces, s.verifiers, claims);

function freshState(order: PolicyEntry[], counted: Set<string>): State {
  const groups = new Map<string, Map<string, Role>>([[WORKSPACE, new Map()]]);
  for (const e of order) if (counted.has(e.id) && e.op.t === 'genesis') for (const id of e.op.admins) groups.get(WORKSPACE)!.set(id, 'admin');
  return { groups, rules: new Map(), spaces: new Map(), verifiers: new Map(), usedLinks: new Set(), seal: null, applied: order.filter((e) => counted.has(e.id)).map((e) => e.id) };
}

const adminCount = (s: State) => [...s.groups.get(WORKSPACE)!].filter(([, r]) => r === 'admin').length;

/** Whether `by` may make operation `e`, with the policy as `s` (its past) has it. */
function allowed(e: PolicyEntry, by: string, s: State, ctx: PolicyContext): boolean {
  const now = view(s, ctx.claimsOf);
  const ws = s.groups.get(WORKSPACE)!;
  const op = e.op;
  switch (op.t) {
    case 'grant': {
      const nested = op.who.startsWith('group:');
      const byEmail = op.who.startsWith('email:');
      if (nested && (op.group === WORKSPACE || op.role !== 'member' || op.who.slice(6) === op.group)) return false;
      // A new group is the workspace's admins' to make.
      const may = s.groups.has(op.group) ? now.isAdmin(by, op.group) : now.isAdmin(by);
      const demotesLast = op.group === WORKSPACE && ws.get(op.who) === 'admin' && op.role !== 'admin' && adminCount(s) === 1;
      // Into another group, only someone in the workspace (or named by email: they come in by being attested).
      return may && !demotesLast && (op.group === WORKSPACE || nested || byEmail || ws.has(op.who));
    }
    case 'revoke': {
      const may = now.isAdmin(by, op.group) || op.who === by;
      const lastAdmin = op.group === WORKSPACE && ws.get(op.who) === 'admin' && adminCount(s) === 1;
      return may && !lastAdmin && !!s.groups.get(op.group)?.has(op.who);
    }
    case 'join': {
      const grantOk = crypto.verify(grantMessage(ctx.workspace, ctx.pin, op.link, op.group, op.role, op.once), Buffer.from(op.grant, 'hex'), Buffer.from(op.granter, 'hex'));
      const granter = grantOk ? ctx.personOf(op.granter) : null;
      return !!granter && s.groups.has(op.group) && now.isAdmin(granter, op.group) && !(op.once && s.usedLinks.has(op.link));
    }
    case 'seal':
      return !s.seal && now.isAdmin(by);
    case 'rule':
    case 'verifier':
      return now.isAdmin(by);
    case 'space': {
      // Made by anyone in the workspace who is in it themselves; changed by whoever made it, or an admin.
      const had = s.spaces.get(op.id);
      if (!now.role(by)) return false;
      const holdsMaker = op.audience.some((e) => e === by || (e === 'admins' && now.isAdmin(by)) || (e.startsWith('group:') && now.role(by, e.slice(6)) !== null));
      return had ? had.by === by || now.isAdmin(by) : holdsMaker;
    }
    case 'genesis':
      return false;
  }
}

/** Apply an operation allowed in its past to a policy; whether it changed anything it could. */
function effect(e: PolicyEntry, by: string, s: State): boolean {
  const op = e.op;
  const group = (name: string) => {
    let g = s.groups.get(name);
    if (!g) s.groups.set(name, (g = new Map()));
    return g;
  };
  const ws = group(WORKSPACE);
  switch (op.t) {
    case 'grant':
      // Into another group, only someone (still) in the workspace, or named by email.
      if (op.group !== WORKSPACE && !op.who.startsWith('group:') && !op.who.startsWith('email:') && !ws.has(op.who)) return false;
      group(op.group).set(op.who, op.role);
      return true;
    case 'revoke':
      if (!s.groups.get(op.group)?.has(op.who)) return false;
      s.groups.get(op.group)!.delete(op.who);
      // Out of the workspace: out of every group.
      if (op.group === WORKSPACE) for (const g of s.groups.values()) g.delete(op.who);
      return true;
    case 'join':
      // A link for one person puts one in: the first, in the order every device puts them in.
      if (op.once && s.usedLinks.has(op.link)) return false;
      if (op.once) s.usedLinks.add(op.link);
      if (op.group !== WORKSPACE && !ws.has(by)) ws.set(by, 'member');
      // Never less than they are already.
      if (group(op.group).get(by) !== 'admin') group(op.group).set(by, op.role);
      return true;
    case 'seal':
      if (s.seal) return false;
      s.seal = op.geneses;
      return true;
    case 'rule':
      if (op.by.length) s.rules.set(op.path, op.by);
      else s.rules.delete(op.path);
      return true;
    case 'space':
      s.spaces.set(op.id, { audience: op.audience, by: s.spaces.get(op.id)?.by ?? by });
      return true;
    case 'verifier':
      if (op.url) s.verifiers.set(op.key, op.url);
      else s.verifiers.delete(op.key);
      return true;
    case 'genesis':
      return false;
  }
}

/** The group an operation acts on, and whom it puts in (grant, join). */
const groupOf = (e: PolicyEntry, by: string): { group: string | null; adds: string | null } => {
  const op = e.op;
  if (op.t === 'grant') return { group: op.group, adds: op.who };
  if (op.t === 'join') return { group: op.group, adds: by };
  if (op.t === 'revoke') return { group: op.group, adds: null };
  return { group: null, adds: null };
};

interface Folded { state: State; disputes: { people: string[]; ops: string[] }[] }

/**
 * Apply operations, each allowed in its own past, together (step 4): in the
 * order every device puts them in, where those made at the same time (neither
 * in the other's past) are settled by rules, the same on every device:
 * - a removal's cutoff: what the person taken out (of a group, or of being
 *   its admin) did at the same time, in that group (all of it, for the
 *   workspace), counts for nothing; but two people taking each other out both
 *   count (each is taken out);
 * - removal wins: someone taken out of a group is not put in it at the same time;
 * - the workspace keeps an admin: if the removals made at the same time would
 *   leave none, none of those stands, and the conflict is on record.
 */
function fold(ops: PolicyEntry[], counted: Set<string>, all: PolicyEntry[], anc: Map<string, Set<string>>, meta: Map<string, Removal>, by: Map<string, string>): Folded {
  const concurrent = (a: string, b: string) => a !== b && !anc.get(a)!.has(b) && !anc.get(b)!.has(a);
  const disputes: Folded['disputes'] = [];
  const excluded = new Set<string>();
  for (let round = 0; ; round++) {
    // Cutoffs, until nothing more is voided (a voided removal voids nothing).
    let voided = new Set<string>();
    // At most a few rounds: removals in different groups that would void each other in turn settle as the last round left them.
    for (let changed = true, n = 0; changed && n < 8; n++) {
      changed = false;
      const next = new Set<string>();
      for (const r of ops) {
        const m = meta.get(r.id);
        if (!m || excluded.has(r.id) || voided.has(r.id)) continue;
        for (const e of ops) {
          if (by.get(e.id) !== m.person || !concurrent(e.id, r.id)) continue;
          const em = meta.get(e.id);
          // Each taking the other out, at once, in the same group: both count.
          if (em && em.group === m.group && em.person === by.get(r.id)) continue;
          // Leaving a group oneself is no power to take away.
          if (e.op.t === 'revoke' && e.op.who === m.person) continue;
          const { group } = groupOf(e, m.person);
          if (m.group === WORKSPACE || group === m.group) next.add(e.id);
        }
      }
      if ([...next].some((x) => !voided.has(x)) || [...voided].some((x) => !next.has(x))) changed = true;
      voided = next;
    }
    const state = freshState(all, counted);
    for (const e of ops) {
      if (voided.has(e.id) || excluded.has(e.id)) continue;
      const who = by.get(e.id)!;
      // Removal wins: not put in a group someone takes them out of at the same time.
      const { group, adds } = groupOf(e, who);
      if (adds && group && ops.some((r) => {
        const m = meta.get(r.id);
        return m && m.kind === 'out' && !voided.has(r.id) && !excluded.has(r.id) && m.person === adds && (m.group === group || m.group === WORKSPACE) && concurrent(r.id, e.id);
      })) continue;
      if (effect(e, who, state)) state.applied.push(e.id);
    }
    // No admin left: the removals of admins made at the same time as another do not stand.
    if (adminCount(state) === 0 && round < 3) {
      const clash = ops.filter((r) => {
        const m = meta.get(r.id);
        return m && m.group === WORKSPACE && m.wasAdmin && !excluded.has(r.id) && !voided.has(r.id)
          && ops.some((o) => o !== r && meta.get(o.id)?.group === WORKSPACE && meta.get(o.id)!.wasAdmin && concurrent(o.id, r.id));
      });
      if (clash.length) {
        for (const r of clash) excluded.add(r.id);
        disputes.push({ people: [...new Set(clash.map((r) => meta.get(r.id)!.person))].sort(), ops: clash.map((r) => r.id).sort() });
        continue;
      }
    }
    return { state, disputes };
  }
}

function apply(order: PolicyEntry[], geneses: string[], ctx: PolicyContext): { policy: Policy; seal: string[] | null } {
  const counted = new Set(geneses);
  // Operations that descend from a genesis that counts; each one's past (all it descends from).
  const rooted = new Set(counted);
  const anc = new Map<string, Set<string>>();
  const ops: PolicyEntry[] = [];
  for (const e of order) {
    if (e.op.t === 'genesis') {
      anc.set(e.id, new Set());
      continue;
    }
    if (!e.parents.some((p) => rooted.has(p))) continue;
    rooted.add(e.id);
    const past = new Set<string>();
    for (const p of e.parents) {
      past.add(p);
      for (const x of anc.get(p) ?? []) past.add(x);
    }
    anc.set(e.id, past);
    ops.push(e);
  }
  // Each operation, judged by the policy its own past makes (the same wherever it is judged).
  const ok: PolicyEntry[] = [];
  const by = new Map<string, string>();
  const meta = new Map<string, Removal>();
  for (const e of ops) {
    const who = ctx.personOf(e.signer);
    if (!who) continue;
    const past = anc.get(e.id)!;
    const before = fold(ok.filter((x) => past.has(x.id)), counted, order, anc, meta, by).state;
    if (!allowed(e, who, before, ctx)) continue;
    by.set(e.id, who);
    const op = e.op;
    if (op.t === 'revoke') meta.set(e.id, { person: op.who, group: op.group, kind: 'out', wasAdmin: before.groups.get(op.group)?.get(op.who) === 'admin' });
    else if (op.t === 'grant' && op.role === 'member' && before.groups.get(op.group)?.get(op.who) === 'admin') meta.set(e.id, { person: op.who, group: op.group, kind: 'demote', wasAdmin: true });
    ok.push(e);
  }
  const { state, disputes } = fold(ok, counted, order, anc, meta, by);
  const parents = new Set(order.flatMap((e) => e.parents));
  const heads = order.filter((e) => rooted.has(e.id) && !parents.has(e.id)).map((e) => e.id).sort();
  // Who is out of the workspace, and the content they had seen when taken out (their cutoff: gate.ts).
  const cutoffs = new Map<string, string[]>();
  for (const e of ok) {
    const m = meta.get(e.id);
    if (!m || m.group !== WORKSPACE || m.kind !== 'out' || state.groups.get(WORKSPACE)!.has(m.person) || e.op.t !== 'revoke') continue;
    cutoffs.set(m.person, [...new Set([...(cutoffs.get(m.person) ?? []), ...(e.op.cutoff ?? [])])].sort());
  }
  return { policy: new Policy(state.groups, [...counted], state.applied, heads, state.usedLinks, !!state.seal, state.rules, disputes, cutoffs, state.spaces, state.verifiers, ctx.claimsOf, ctx.claimed), seal: state.seal };
}
