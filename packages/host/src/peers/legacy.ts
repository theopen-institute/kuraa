// A workspace from before 0066, founded again once (0078).
//
// A workspace made before policies had no genesis pinned: each of its devices
// wrote down a legacy genesis, held some as its own (`legacy.json`), and kept
// to the seal it saw count, so its devices could each work its policy out a
// little differently. Since 0078 nothing counts in such a workspace until it is
// founded again: its owner (or, where it has none, one of its admins) makes a
// new genesis naming themselves, and puts everyone back as they were (refound).
// Each device takes that genesis only if it is signed by whoever its own last
// working out of the legacy policy has as owner (or as an admin, where it has
// no owner), and is pinned to it from then on.
//
// That last working out is made once, here, the first time a device of this
// version holds the workspace, by the rules it was worked out by before (rank,
// seals: decision 0072, 0075; email checks, retired with 0078, aside), and kept
// (`legacy-last.json`); `legacy.json` is removed. Meanwhile the device keeps to
// that policy as it was: who is in, groups, permissions and spaces stay as they
// were, and nothing new counts. This file is that code, frozen: nothing else
// uses it.
import crypto from 'hypercore-crypto';
import { admittedGrantMessage, grantMessage, linkGrantMessage, Policy, WORKSPACE, type Perm, type PolicyEntry, type Role } from './policy.js';

/** The last working out of a legacy workspace's policy on this device, as kept. */
export interface LegacySnapshot {
  /** The owner (whoever sealed it); null: none, its admins equal. */
  owner: string | null;
  /** Each group's entries, by role. */
  groups: Record<string, Record<string, Role>>;
  perms: Record<string, Perm>;
  spaces: Record<string, { audience: string[]; by: string }>;
  /** Signing keys dropped, and their cutoffs. */
  dropped: Record<string, string[]>;
  /** People taken out, and their cutoffs. */
  cutoffs: Record<string, string[]>;
  /** The legacy geneses that counted (none: no policy at all). */
  geneses: string[];
}

/** The admins of a snapshot: people the workspace group has as admins. */
export const snapshotAdmins = (s: LegacySnapshot) => Object.entries(s.groups[WORKSPACE] ?? {}).filter(([w, r]) => r === 'admin' && /^[0-9a-f]{64}$/.test(w)).map(([w]) => w).sort();

/** Who may found a legacy workspace again, as a device's snapshot has it: its owner; with none, any of its admins; with no policy at all, anyone in it (all equal: 0038). */
export function mayRefound(s: LegacySnapshot, person: string | null): boolean {
  if (!person) return false;
  if (s.owner) return person === s.owner;
  if (s.geneses.length) return snapshotAdmins(s).includes(person);
  return true;
}

/** The policy a device keeps to until its workspace is founded again: the snapshot as it was, nothing new counting. */
export function frozenPolicy(s: LegacySnapshot, workspace: string): Policy {
  const groups = new Map(Object.entries(s.groups).map(([g, m]) => [g, new Map(Object.entries(m))]));
  if (!groups.has(WORKSPACE)) groups.set(WORKSPACE, new Map());
  return new Policy({
    groups, geneses: s.geneses, applied: [], heads: [], perms: new Map(Object.entries(s.perms)), spaces: new Map(Object.entries(s.spaces)),
    // The owner of a legacy workspace has none of an owner's powers until it is founded again: nothing new counts.
    owner: s.owner, dropped: new Map(Object.entries(s.dropped)), cutoffs: new Map(Object.entries(s.cutoffs)), workspace,
  });
}

export interface LegacyContext {
  workspace: string;
  /** The legacy geneses this device holds as its own (none said: every one). */
  legacy?: string[];
  /** The seal this device keeps to. */
  seal?: string | null;
  personOf(signingKey: string): string | null;
  cutKey?: (signingKey: string) => string[] | null | undefined;
}

/** A legacy workspace's policy, worked out as it was before 0078 (docs/decisions/0075). */
export function evaluateLegacy(entries: PolicyEntry[], ctx: LegacyContext): LegacySnapshot {
  const byId = new Map<string, PolicyEntry>();
  for (const e of entries) if (!byId.has(e.id)) byId.set(e.id, e);
  const order = linearize(byId);
  const legacy = countedLegacy(order, ctx);
  const kept = ctx.seal ? byId.get(ctx.seal) : undefined;
  if (kept?.op.t === 'seal') {
    const named = kept.op.geneses;
    return snapshot(apply(order, legacy.filter((g) => named.includes(g)), ctx));
  }
  const first = apply(order, legacy, ctx);
  if (first.state.seal) {
    const named = first.state.seal.geneses;
    return snapshot(apply(order, legacy.filter((g) => named.includes(g)), { ...ctx, seal: first.state.seal.id }));
  }
  return snapshot(first);
}

function snapshot(r: { state: State; geneses: string[]; cutoffs: Map<string, string[]> }): LegacySnapshot {
  const s = r.state;
  return {
    owner: s.owner,
    groups: Object.fromEntries([...s.groups].map(([g, m]) => [g, Object.fromEntries(m)])),
    perms: Object.fromEntries(s.perms),
    spaces: Object.fromEntries(s.spaces),
    dropped: Object.fromEntries(s.dropped),
    cutoffs: Object.fromEntries(r.cutoffs),
    geneses: r.geneses,
  };
}

function countedLegacy(order: PolicyEntry[], ctx: LegacyContext): string[] {
  const legacy = order.filter((e) => e.op.t === 'genesis' && e.op.legacy);
  if (!ctx.legacy) return legacy.map((e) => e.id);
  const own = new Set(ctx.legacy);
  const counted = new Set<string>();
  const admins = new Set<string>();
  for (let grew = true; grew;) {
    grew = false;
    for (const e of legacy) {
      if (counted.has(e.id) || e.op.t !== 'genesis') continue;
      const signer = ctx.personOf(e.signer);
      if (!own.has(e.id) && !(signer && admins.has(signer))) continue;
      counted.add(e.id);
      for (const a of e.op.admins) admins.add(a);
      grew = true;
    }
  }
  return legacy.filter((e) => counted.has(e.id)).map((e) => e.id);
}

function linearize(byId: Map<string, PolicyEntry>): PolicyEntry[] {
  const missing = new Map<PolicyEntry, number>();
  const children = new Map<string, PolicyEntry[]>();
  const ready: PolicyEntry[] = [];
  for (const e of byId.values()) {
    if ((e.op.t === 'genesis') !== (e.parents.length === 0)) continue;
    const parents = [...new Set(e.parents)];
    missing.set(e, parents.length);
    if (!parents.length) ready.push(e);
    for (const p of parents) children.set(p, [...(children.get(p) ?? []), e]);
  }
  const out: PolicyEntry[] = [];
  while (ready.length) {
    ready.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const next = ready.shift()!;
    out.push(next);
    for (const c of children.get(next.id) ?? []) {
      const left = missing.get(c)! - 1;
      missing.set(c, left);
      if (left === 0) ready.push(c);
    }
  }
  return out;
}

interface State {
  groups: Map<string, Map<string, Role>>;
  perms: Map<string, Perm>;
  spaces: Map<string, { audience: string[]; by: string }>;
  owner: string | null;
  usedLinks: Set<string>;
  seal: { id: string; geneses: string[] } | null;
  applied: string[];
  since: Map<string, number>;
  ownerSince: number;
  dropped: Map<string, string[]>;
  unlinked: Set<string>;
  admitted: Set<string>;
}

interface Removal { person: string; group: string; kind: 'out' | 'demote'; wasAdmin: boolean }

/** Enough of a policy to judge by, as before 0078: admins equal where there is no owner. */
class View {
  constructor(private readonly s: State) {}
  role(id: string, group: string = WORKSPACE): Role | null {
    if (group !== WORKSPACE && !this.roleIn(id, WORKSPACE, new Set())) return null;
    return this.roleIn(id, group, new Set());
  }
  private roleIn(id: string, group: string, seen: Set<string>): Role | null {
    if (seen.has(group)) return null;
    seen.add(group);
    const g = this.s.groups.get(group);
    if (!g) return null;
    const own = g.get(id);
    if (own) return own;
    for (const who of g.keys()) if (who.startsWith('group:') && this.roleIn(id, who.slice(6), seen)) return 'member';
    return null;
  }
  isAdmin(id: string | null, group: string = WORKSPACE): boolean {
    return !!id && (this.role(id, WORKSPACE) === 'admin' || (group !== WORKSPACE && this.role(id, group) === 'admin'));
  }
  mayAssignAdmins(id: string | null): boolean {
    return this.s.owner ? !!id && id === this.s.owner : this.isAdmin(id);
  }
}

function freshState(order: PolicyEntry[], counted: Set<string>): State {
  const groups = new Map<string, Map<string, Role>>([[WORKSPACE, new Map()]]);
  const since = new Map<string, number>();
  for (const e of order) if (counted.has(e.id) && e.op.t === 'genesis') for (const id of e.op.admins) {
    groups.get(WORKSPACE)!.set(id, 'admin');
    since.set(id, 0);
  }
  return { groups, perms: new Map(), spaces: new Map(), owner: null, usedLinks: new Set(), seal: null, applied: order.filter((e) => counted.has(e.id)).map((e) => e.id), since, ownerSince: 0, dropped: new Map(), unlinked: new Set(), admitted: new Set() };
}

const adminCount = (s: State) => [...s.groups.get(WORKSPACE)!].filter(([, r]) => r === 'admin').length;

function rankKey(s: State, id: string): [number, number, string] {
  if (id === s.owner) return [0, s.ownerSince, id];
  const role = s.groups.get(WORKSPACE)!.get(id);
  if (role) return [role === 'admin' ? 1 : 2, s.since.get(id) ?? Number.MAX_SAFE_INTEGER, id];
  return [3, 0, id];
}

const compareKeys = (a: [number, number, string], b: [number, number, string]) =>
  a[0] - b[0] || a[1] - b[1] || (a[2] < b[2] ? -1 : a[2] > b[2] ? 1 : 0);

const emailIn = (list: string[] | undefined) => !!list?.some((w) => w.startsWith('email:'));

function allowed(e: PolicyEntry, by: string, s: State, ctx: LegacyContext): boolean {
  const now = new View(s);
  const ws = s.groups.get(WORKSPACE)!;
  const op = e.op;
  if (s.dropped.has(e.signer)) return false;
  switch (op.t) {
    case 'grant': {
      // Email entries (retired with 0078) are left aside.
      if (op.who.startsWith('email:')) return false;
      const nested = op.who.startsWith('group:');
      if (nested && (op.group === WORKSPACE || op.role !== 'member' || op.who.slice(6) === op.group)) return false;
      const may = s.groups.has(op.group) ? now.isAdmin(by, op.group) : now.isAdmin(by);
      const demotesLast = op.group === WORKSPACE && ws.get(op.who) === 'admin' && op.role !== 'admin' && adminCount(s) === 1;
      if (op.group === WORKSPACE && (op.role === 'admin' || ws.get(op.who) === 'admin') && !now.mayAssignAdmins(by)) return false;
      if (op.group === WORKSPACE && op.who === s.owner && op.role !== 'admin') return false;
      return may && !demotesLast && (op.group === WORKSPACE || nested || ws.has(op.who));
    }
    case 'revoke': {
      const may = now.isAdmin(by, op.group) || op.who === by;
      const lastAdmin = op.group === WORKSPACE && ws.get(op.who) === 'admin' && adminCount(s) === 1;
      if (op.group === WORKSPACE && op.who === s.owner) return false;
      if (op.group === WORKSPACE && ws.get(op.who) === 'admin' && op.who !== by && !now.mayAssignAdmins(by)) return false;
      return may && !lastAdmin && !!s.groups.get(op.group)?.has(op.who);
    }
    case 'join': {
      // Servers (0099) came after policies were pinned: a legacy policy has none.
      if (op.role === 'server') return false;
      if (s.unlinked.has(`${op.link} ${op.group}`)) return false;
      const signed = (m: Buffer) => crypto.verify(m, Buffer.from(op.grant, 'hex'), Buffer.from(op.granter, 'hex'));
      const admitted = op.issuer !== undefined && signed(admittedGrantMessage(ctx.workspace, null, op.link, op.group, op.role, op.once, op.expires ?? 0, op.issuer));
      if (admitted && !s.admitted.has(`${op.link} ${e.signer}`)) return false;
      const grantOk = admitted || signed(op.issuer !== undefined
        ? linkGrantMessage(ctx.workspace, null, op.link, op.group, op.role, op.once, op.expires ?? 0, op.issuer)
        : grantMessage(ctx.workspace, null, op.link, op.group, op.role, op.once));
      const granter = grantOk ? ctx.personOf(op.granter) : null;
      if (op.group === WORKSPACE && op.role === 'admin' && !now.mayAssignAdmins(granter)) return false;
      return !!granter && s.groups.has(op.group) && now.isAdmin(granter, op.group) && !(op.once && s.usedLinks.has(op.link));
    }
    case 'owner':
      return !!s.owner && by === s.owner && op.who !== by && ws.has(op.who);
    case 'drop': {
      if (s.dropped.has(op.key) || !now.role(by)) return false;
      const whose = ctx.personOf(op.key);
      if (whose === by) return true;
      const ofAdmin = !!whose && (ws.get(whose) === 'admin' || whose === s.owner);
      return now.isAdmin(by) && (!ofAdmin || now.mayAssignAdmins(by));
    }
    case 'seal':
      return !s.seal && now.isAdmin(by) && (!ctx.seal || e.id === ctx.seal);
    case 'unlink':
      return now.isAdmin(by, op.group);
    case 'admit':
      return !!now.role(by);
    case 'rule':
      return !emailIn(op.by) && now.isAdmin(by);
    case 'perm':
      return !emailIn(op.write) && !emailIn(op.read) && now.isAdmin(by);
    case 'witness':
      return now.isAdmin(by);
    case 'verifier':
      return false;
    case 'space': {
      if (emailIn(op.audience)) return false;
      const had = s.spaces.get(op.id);
      if (!now.role(by)) return false;
      const holdsMaker = op.audience.some((w) => w === by || (w === 'admins' && now.isAdmin(by)) || (w.startsWith('group:') && now.role(by, w.slice(6)) !== null));
      return had ? had.by === by || now.isAdmin(by) : holdsMaker;
    }
    // Said since 0115, of a workspace founded since: a workspace from before judges by its legacy policy alone.
    case 'rules':
    case 'genesis':
      return false;
  }
}

function effect(e: PolicyEntry, by: string, s: State, at: number): boolean {
  const op = e.op;
  const group = (name: string) => {
    let g = s.groups.get(name);
    if (!g) s.groups.set(name, (g = new Map()));
    return g;
  };
  const ws = group(WORKSPACE);
  const place = (who: string, role: Role) => {
    if (ws.get(who) !== role) s.since.set(who, at);
    ws.set(who, role);
  };
  switch (op.t) {
    case 'grant':
      if (op.group !== WORKSPACE && !op.who.startsWith('group:') && !ws.has(op.who)) return false;
      if (op.group === WORKSPACE) place(op.who, op.role);
      else group(op.group).set(op.who, op.role);
      return true;
    case 'revoke':
      if (!s.groups.get(op.group)?.has(op.who)) return false;
      s.groups.get(op.group)!.delete(op.who);
      if (op.group === WORKSPACE) {
        for (const g of s.groups.values()) g.delete(op.who);
        s.since.delete(op.who);
      }
      return true;
    case 'join':
      if (op.role === 'server') return false;
      if (op.once && s.usedLinks.has(op.link)) return false;
      if (op.once) s.usedLinks.add(op.link);
      if (op.group !== WORKSPACE && !ws.has(by)) place(by, 'member');
      if (group(op.group).get(by) !== 'admin') {
        if (op.group === WORKSPACE) place(by, op.role);
        else group(op.group).set(by, op.role);
      }
      return true;
    case 'seal':
      if (s.seal) return false;
      s.seal = { id: e.id, geneses: op.geneses };
      if (!s.owner) {
        s.owner = by;
        s.ownerSince = at;
      }
      return true;
    case 'owner':
      s.owner = op.who;
      s.ownerSince = at;
      place(op.who, 'admin');
      return true;
    case 'rule': {
      const had = s.perms.get(op.path) ?? {};
      const next: Perm = { ...(op.by.length ? { write: op.by } : {}), ...(had.read ? { read: had.read } : {}) };
      if (next.write || next.read) s.perms.set(op.path, next);
      else s.perms.delete(op.path);
      return true;
    }
    case 'perm':
      if (op.write || op.read) s.perms.set(op.path, { ...(op.write ? { write: op.write } : {}), ...(op.read ? { read: op.read } : {}), ...(op.space ? { space: op.space } : {}) });
      else s.perms.delete(op.path);
      return true;
    case 'space':
      s.spaces.set(op.id, { audience: op.audience, by: s.spaces.get(op.id)?.by ?? by });
      return true;
    case 'drop':
      s.dropped.set(op.key, op.cutoff ?? []);
      return true;
    case 'unlink':
      s.unlinked.add(`${op.link} ${op.group}`);
      return true;
    case 'admit':
      s.admitted.add(`${op.link} ${op.key}`);
      return true;
    case 'witness':
    case 'verifier':
    case 'rules':
    case 'genesis':
      return false;
  }
}

const groupOf = (e: PolicyEntry): string | null => {
  const op = e.op;
  return op.t === 'grant' || op.t === 'join' || op.t === 'revoke' ? op.group : null;
};

type Place = 'out' | 'member' | 'admin' | 'in';
interface Claim { group: string; who: string; place: Place }

function claimsOf(e: PolicyEntry, by: string): Claim[] {
  const op = e.op;
  switch (op.t) {
    case 'grant': return [{ group: op.group, who: op.who, place: op.role }];
    case 'revoke': return [{ group: op.group, who: op.who, place: 'out' }];
    case 'owner': return [{ group: WORKSPACE, who: op.who, place: 'admin' }];
    case 'join': return op.role === 'server' ? [] : op.group === WORKSPACE
      ? [{ group: WORKSPACE, who: by, place: op.role }]
      : [{ group: op.group, who: by, place: op.role }, { group: WORKSPACE, who: by, place: 'in' }];
    default: return [];
  }
}

const differ = (a: Place, b: Place) => a !== b && !((a === 'in' && b !== 'out') || (b === 'in' && a !== 'out'));
const PLACE_ORDER: Record<Place, number> = { out: 0, member: 1, in: 2, admin: 3 };

interface Env {
  counted: Set<string>;
  order: PolicyEntry[];
  at: Map<string, number>;
  anc: Map<string, Set<string>>;
  by: Map<string, string>;
  meta: Map<string, Removal>;
  before: Map<string, State>;
  ctx: LegacyContext;
}

function fold(ops: PolicyEntry[], env: Env): State {
  const concurrent = (a: string, b: string) => a !== b && !env.anc.get(a)!.has(b) && !env.anc.get(b)!.has(a);
  const keyOf = (e: PolicyEntry) => rankKey(env.before.get(e.id)!, env.by.get(e.id)!);
  const leaving = (e: PolicyEntry) => e.op.t === 'revoke' && e.op.who === env.by.get(e.id);
  const cuts = (r: PolicyEntry, e: PolicyEntry) => {
    if (r.op.t === 'drop') return r !== e && e.signer === r.op.key && concurrent(r.id, e.id);
    const m = env.meta.get(r.id);
    if (!m || env.by.get(e.id) !== m.person || !concurrent(r.id, e.id) || leaving(e)) return false;
    return m.group === WORKSPACE || groupOf(e) === m.group;
  };
  const excluded = new Set<string>();
  for (;;) {
    const voided = new Set(excluded);
    const deciding = ops.filter((e) => !excluded.has(e.id) && (env.meta.has(e.id) || e.op.t === 'drop' || claimsOf(e, env.by.get(e.id)!).length))
      .map((e) => ({ e, claims: claimsOf(e, env.by.get(e.id)!), key: keyOf(e), least: Math.min(4, ...claimsOf(e, env.by.get(e.id)!).map((c) => PLACE_ORDER[c.place])) }))
      .sort((a, b) => Number(leaving(b.e)) - Number(leaving(a.e)) || compareKeys(a.key, b.key) || a.least - b.least || (a.e.id < b.e.id ? -1 : a.e.id > b.e.id ? 1 : 0));
    const counting: typeof deciding = [];
    for (const x of deciding) {
      const out = counting.some((s) => cuts(s.e, x.e) || cuts(x.e, s.e)
        || s.claims.some((c) => x.claims.some((d) => c.group === d.group && c.who === d.who && differ(c.place, d.place) && concurrent(s.e.id, x.e.id))));
      if (out) voided.add(x.e.id);
      else counting.push(x);
    }
    const removals = counting.filter((x) => env.meta.has(x.e.id) || x.e.op.t === 'drop').map((x) => x.e);
    for (const e of ops) if (!voided.has(e.id) && removals.some((r) => cuts(r, e))) voided.add(e.id);
    const unlinks = ops.filter((u) => u.op.t === 'unlink' && !voided.has(u.id));
    for (const e of ops) {
      const op = e.op;
      if (op.t === 'join' && !voided.has(e.id) && unlinks.some((u) => u.op.t === 'unlink' && u.op.link === op.link && u.op.group === op.group && concurrent(u.id, e.id))) voided.add(e.id);
    }
    const named = (e: PolicyEntry) => (e.op.t === 'seal' ? e.op.geneses.filter((g) => env.counted.has(g)).length : 0);
    const seals = ops.filter((e) => e.op.t === 'seal' && !voided.has(e.id))
      .sort((a, b) => named(b) - named(a) || compareKeys(keyOf(a), keyOf(b)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const e of seals.slice(1)) voided.add(e.id);
    const kept = ops.filter((e) => !voided.has(e.id));
    let unfounded = false;
    for (const e of kept) {
      const past = env.anc.get(e.id)!;
      const then = freshState(env.order, env.counted);
      for (const x of kept) if (past.has(x.id)) effect(x, env.by.get(x.id)!, then, env.at.get(x.id)!);
      if (!allowed(e, env.by.get(e.id)!, then, env.ctx)) {
        excluded.add(e.id);
        unfounded = true;
      }
    }
    if (unfounded) continue;
    const state = freshState(env.order, env.counted);
    for (const e of ops) {
      if (voided.has(e.id)) continue;
      if (effect(e, env.by.get(e.id)!, state, env.at.get(e.id)!)) state.applied.push(e.id);
    }
    if (adminCount(state) === 0 && !state.owner) {
      const taken = ops.filter((r) => {
        const m = env.meta.get(r.id);
        return m && m.group === WORKSPACE && m.wasAdmin && !voided.has(r.id)
          && ops.some((o) => o !== r && env.meta.get(o.id)?.group === WORKSPACE && env.meta.get(o.id)!.wasAdmin && !voided.has(o.id) && concurrent(o.id, r.id));
      }).map((r) => ({ r, key: rankKey(env.before.get(r.id)!, env.meta.get(r.id)!.person) }))
        .sort((a, b) => compareKeys(a.key, b.key) || (a.r.id < b.r.id ? -1 : 1));
      const keep = taken[0];
      if (keep) {
        const person = env.meta.get(keep.r.id)!.person;
        for (const t of taken) if (env.meta.get(t.r.id)!.person === person) excluded.add(t.r.id);
        continue;
      }
    }
    return state;
  }
}

function apply(order: PolicyEntry[], geneses: string[], ctx: LegacyContext): { state: State; geneses: string[]; cutoffs: Map<string, string[]> } {
  const counted = new Set(geneses);
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
  const env: Env = { counted, order, at: new Map(order.map((e, i) => [e.id, i + 1])), anc, by: new Map(), meta: new Map(), before: new Map(), ctx };
  const ok: PolicyEntry[] = [];
  const folds = new Map<string, State>();
  for (const e of ops) {
    const who = ctx.personOf(e.signer);
    if (!who) continue;
    const cut = ctx.cutKey?.(e.signer);
    if (cut && !cut.some((h) => h === e.id || anc.get(h)?.has(e.id))) continue;
    const past = anc.get(e.id)!;
    const mine = ok.filter((x) => past.has(x.id));
    const key = mine.map((x) => x.id).join();
    let before = folds.get(key);
    if (!before) folds.set(key, (before = fold(mine, env)));
    if (!allowed(e, who, before, ctx)) continue;
    env.by.set(e.id, who);
    env.before.set(e.id, before);
    const op = e.op;
    if (op.t === 'revoke') env.meta.set(e.id, { person: op.who, group: op.group, kind: 'out', wasAdmin: before.groups.get(op.group)?.get(op.who) === 'admin' });
    else if (op.t === 'grant' && op.role === 'member' && before.groups.get(op.group)?.get(op.who) === 'admin') env.meta.set(e.id, { person: op.who, group: op.group, kind: 'demote', wasAdmin: true });
    ok.push(e);
  }
  const state = fold(ok, env);
  const cutoffs = new Map<string, string[]>();
  for (const e of ok) {
    const m = env.meta.get(e.id);
    if (!m || m.group !== WORKSPACE || m.kind !== 'out' || state.groups.get(WORKSPACE)!.has(m.person) || e.op.t !== 'revoke' || !state.applied.includes(e.id)) continue;
    cutoffs.set(m.person, [...new Set([...(cutoffs.get(m.person) ?? []), ...(e.op.cutoff ?? [])])].sort());
  }
  return { state, geneses: [...counted], cutoffs };
}
