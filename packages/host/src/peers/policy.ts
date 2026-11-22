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
  | { t: 'revoke'; group: string; who: string }
  | { t: 'join'; group: string; role: Role; link: string; once: boolean; granter: string; grant: string }
  | { t: 'seal'; geneses: string[] };

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
    case 'revoke': return ['revoke', op.group, op.who].join('\0');
    case 'join': return ['join', op.group, op.role, op.link, op.once ? 'once' : 'anyone', op.granter, op.grant].join('\0');
    case 'seal': return ['seal', op.geneses.join(',')].join('\0');
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

const whoTest = /^(?:[0-9a-f]{64}|group:[a-z0-9][a-z0-9-]{0,39})$/;

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
    case 'revoke':
      return typeof o.group === 'string' && groupName.test(o.group) && typeof o.who === 'string' && whoTest.test(o.who)
        ? { t: 'revoke', group: o.group, who: o.who } : null;
    case 'join':
      return typeof o.group === 'string' && groupName.test(o.group) && role(o.role) && typeof o.link === 'string' && /^[0-9a-f]{16}$/.test(o.link)
        && typeof o.once === 'boolean' && typeof o.granter === 'string' && hexKey.test(o.granter) && typeof o.grant === 'string' && hexSig.test(o.grant)
        ? { t: 'join', group: o.group, role: o.role, link: o.link, once: o.once, granter: o.granter, grant: o.grant } : null;
    case 'seal': {
      const geneses = sortedUnique(o.geneses, hexKey);
      return geneses && geneses.length ? { t: 'seal', geneses } : null;
    }
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
  ) {}

  /** Whether there is a policy at all (a genesis that counts). */
  get founded(): boolean {
    return this.geneses.length > 0;
  }

  /** A person's role in a group: by their own entry, or (as a member) through a group in it. Outside the workspace, in none. */
  role(id: string, group: string = WORKSPACE): Role | null {
    if (group !== WORKSPACE && !this.groups.get(WORKSPACE)?.has(id)) return null;
    return this.roleIn(id, group, new Set());
  }

  private roleIn(id: string, group: string, seen: Set<string>): Role | null {
    if (seen.has(group)) return null;
    seen.add(group);
    const g = this.groups.get(group);
    if (!g) return null;
    const own = g.get(id);
    if (own) return own;
    for (const who of g.keys()) if (who.startsWith('group:') && this.roleIn(id, who.slice(6), seen)) return 'member';
    return null;
  }

  isAdmin(id: string | null, group: string = WORKSPACE): boolean {
    return !!id && (this.role(id, WORKSPACE) === 'admin' || (group !== WORKSPACE && this.role(id, group) === 'admin'));
  }

  /** The people (not groups) with an entry in a group, and their roles. */
  people(group: string = WORKSPACE): { id: string; role: Role }[] {
    return [...(this.groups.get(group) ?? new Map<string, Role>())].filter(([who]) => !who.startsWith('group:')).map(([id, role]) => ({ id, role }));
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

function apply(order: PolicyEntry[], geneses: string[], ctx: PolicyContext): { policy: Policy; seal: string[] | null } {
  const groups = new Map<string, Map<string, Role>>();
  const group = (name: string) => {
    let g = groups.get(name);
    if (!g) groups.set(name, (g = new Map()));
    return g;
  };
  const counted = new Set(geneses);
  const applied: string[] = [];
  const usedLinks = new Set<string>();
  let seal: string[] | null = null;
  const ws = group(WORKSPACE);
  for (const e of order) if (counted.has(e.id) && e.op.t === 'genesis') for (const id of e.op.admins) ws.set(id, 'admin');
  applied.push(...order.filter((e) => counted.has(e.id)).map((e) => e.id));
  // Operations that descend from a genesis that counts.
  const rooted = new Set(counted);
  const view = () => new Policy(groups, [...counted], applied, [], usedLinks);
  const admins = () => [...ws].filter(([, r]) => r === 'admin').length;
  for (const e of order) {
    if (e.op.t === 'genesis') continue;
    if (!e.parents.some((p) => rooted.has(p))) continue;
    rooted.add(e.id);
    const by = ctx.personOf(e.signer);
    if (!by) continue;
    const now = view();
    const op = e.op;
    let ok = false;
    if (op.t === 'grant') {
      const nested = op.who.startsWith('group:');
      if (nested && (op.group === WORKSPACE || op.role !== 'member' || op.who.slice(6) === op.group)) continue;
      // A new group is the workspace's admins' to make.
      const may = groups.has(op.group) ? now.isAdmin(by, op.group) : now.isAdmin(by);
      const demotesLast = op.group === WORKSPACE && ws.get(op.who) === 'admin' && op.role !== 'admin' && admins() === 1;
      if (may && !demotesLast) {
        // Into another group, only someone in the workspace.
        if (op.group === WORKSPACE || nested || ws.has(op.who)) {
          group(op.group).set(op.who, op.role);
          ok = true;
        }
      }
    } else if (op.t === 'revoke') {
      const may = now.isAdmin(by, op.group) || op.who === by;
      const lastAdmin = op.group === WORKSPACE && ws.get(op.who) === 'admin' && admins() === 1;
      if (may && !lastAdmin && groups.get(op.group)?.has(op.who)) {
        groups.get(op.group)!.delete(op.who);
        // Out of the workspace: out of every group.
        if (op.group === WORKSPACE) for (const g of groups.values()) g.delete(op.who);
        ok = true;
      }
    } else if (op.t === 'join') {
      const genesis = ctx.pin;
      const grantOk = crypto.verify(grantMessage(ctx.workspace, genesis, op.link, op.group, op.role, op.once), Buffer.from(op.grant, 'hex'), Buffer.from(op.granter, 'hex'));
      const granter = grantOk ? ctx.personOf(op.granter) : null;
      const mayGrant = !!granter && (groups.has(op.group) || op.group === WORKSPACE) && now.isAdmin(granter, op.group);
      if (mayGrant && !(op.once && usedLinks.has(op.link))) {
        if (op.once) usedLinks.add(op.link);
        if (op.group !== WORKSPACE && !ws.has(by)) ws.set(by, 'member');
        const g = group(op.group);
        // Never less than they are already.
        if (g.get(by) !== 'admin') g.set(by, op.role);
        ok = true;
      }
    } else if (op.t === 'seal') {
      if (!seal && now.isAdmin(by)) {
        seal = op.geneses;
        ok = true;
      }
    }
    if (ok) applied.push(e.id);
  }
  const parents = new Set(order.flatMap((e) => e.parents));
  const heads = order.filter((e) => rooted.has(e.id) && !parents.has(e.id)).map((e) => e.id).sort();
  return { policy: new Policy(groups, [...counted], applied, heads, usedLinks, !!seal), seal };
}
