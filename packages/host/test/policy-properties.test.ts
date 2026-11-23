// The policy's properties, over histories made at random (docs/policy.md; decisions 0072, 0078).
//
// Several devices make operations, each on the policy as it knows it, and pass
// what they hold to one another now and then, so operations are made at the
// same time as others, by people being taken out, made admins, given the
// workspace, and so on. Among them, adversaries (0078): strangers with no
// identity, someone with an identity never let in, people taken out going on as
// if they were not, operations made on an old view of the policy (back-dated:
// naming old heads), naming parents no one holds, grants and joins replayed by
// someone else, a rival genesis, and every kind of clash. Whatever happens,
// every device that holds the same operations must come to the same policy, and
// that policy must keep the rules docs/policy.md sets out.
//
// The seeds are fixed (KURAA_FUZZ_SEED changes them), so a failure is found again.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import crypto from 'hypercore-crypto';
import { admittedGrantMessage, evaluate, linkGrantMessage, makeOp, WORKSPACE, type Policy, type PolicyContext, type PolicyEntry, type PolicyOp, type Role } from '../src/peers/policy.js';

const WS = 'cd'.repeat(16);
const ISSUER = 'ee'.repeat(32);
/** People with identities: Ada (the owner), Bo, Cy, Dee, Fay; then Eve, who has one but is never let in by anyone in. */
const people = Array.from({ length: 6 }, () => ({ key: crypto.keyPair(), id: crypto.keyPair().publicKey.toString('hex') }));
const HONEST = 5;
const EVE = 5;
/** Keys no identity vouched for: strangers. */
const strangers = Array.from({ length: 2 }, () => crypto.keyPair());
const strangerKeys = new Set(strangers.map((k) => k.publicKey.toString('hex')));
const byKey = new Map(people.map((p) => [p.key.publicKey.toString('hex'), p.id]));
const personOf = (k: string) => byKey.get(k) ?? null;
const ids = people.map((p) => p.id);
const [ada, bo, cy, dee] = people as [typeof people[0], typeof people[0], typeof people[0], typeof people[0]];
const GROUPS = [WORKSPACE, 'team'];
const PATHS = ['', 'chapters/', 'chapters/one.md'];
const SPACES = ['11'.repeat(16), '22'.repeat(16)];
const LINKS = ['0123456789abcdef', 'fedcba9876543210'];

/** What a device does next: make an operation (on what it holds now, or on an old view of it), take what another holds, or an adversary's move. */
type Step =
  | { k: 'op'; device: number; by: number; op: OpSpec; back: number }
  | { k: 'sync'; from: number; to: number }
  | { k: 'stranger'; device: number; who: number; op: OpSpec }
  | { k: 'forged'; device: number; by: number; op: OpSpec }
  | { k: 'replay'; device: number; by: number; pick: number }
  | { k: 'rival'; device: number; by: number };

type OpSpec =
  | { t: 'grant'; group: number; who: number; role: Role }
  | { t: 'nest' }
  | { t: 'revoke'; group: number; who: number }
  | { t: 'leave'; group: number }
  | { t: 'owner'; who: number }
  | { t: 'perm'; path: number; write: number[]; read: number[] }
  | { t: 'space'; id: number; audience: number[] }
  | { t: 'join'; group: number; role: Role; granter: number; link: number; once: boolean; admitted: boolean }
  | { t: 'drop'; whose: number }
  | { t: 'unlink'; link: number; group: number }
  | { t: 'admit'; link: number; who: number };

const honest = fc.integer({ min: 0, max: HONEST - 1 });
const anyone = fc.integer({ min: 0, max: people.length - 1 });
const role = fc.constantFrom<Role>('admin', 'member');
const group = fc.integer({ min: 0, max: GROUPS.length - 1 });
const opSpec: fc.Arbitrary<OpSpec> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('grant' as const), group, who: honest, role }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('nest' as const) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('revoke' as const), group, who: honest }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('leave' as const), group }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('owner' as const), who: honest }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('perm' as const), path: fc.integer({ min: 0, max: PATHS.length - 1 }), write: fc.uniqueArray(honest, { maxLength: 2 }), read: fc.uniqueArray(honest, { maxLength: 2 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('space' as const), id: fc.integer({ min: 0, max: SPACES.length - 1 }), audience: fc.uniqueArray(honest, { minLength: 1, maxLength: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('join' as const), group, role, granter: anyone, link: fc.integer({ min: 0, max: LINKS.length - 1 }), once: fc.boolean(), admitted: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('drop' as const), whose: honest }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('unlink' as const), link: fc.integer({ min: 0, max: LINKS.length - 1 }), group }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('admit' as const), link: fc.integer({ min: 0, max: LINKS.length - 1 }), who: anyone }) },
);
const DEVICES = 3;
const device = fc.integer({ min: 0, max: DEVICES - 1 });
/** How many of a device's past views back an operation is made on (0: what it holds now). */
const back = fc.oneof({ weight: 4, arbitrary: fc.constant(0) }, { weight: 1, arbitrary: fc.integer({ min: 1, max: 6 }) });
const honestStep: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant('op' as const), device, by: honest, op: opSpec, back: fc.constant(0) }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('sync' as const), from: device, to: device }) },
);
const adversarialStep: fc.Arbitrary<Step> = fc.oneof(
  { weight: 6, arbitrary: fc.record({ k: fc.constant('op' as const), device, by: anyone, op: opSpec, back }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant('sync' as const), from: device, to: device }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('stranger' as const), device, who: fc.integer({ min: 0, max: strangers.length - 1 }), op: opSpec }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('forged' as const), device, by: anyone, op: opSpec }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('replay' as const), device, by: anyone, pick: fc.nat() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('rival' as const), device, by: anyone }) },
);

/** The workspace's start: a pinned genesis, Ada its owner; Bo and Cy admins, Dee a member, Bo an admin of the team. */
function begin(): { entries: PolicyEntry[]; ctx: PolicyContext } {
  const genesis = makeOp(WS, { t: 'genesis', admins: [ada.id], legacy: false }, [], ada.key);
  const ctx: PolicyContext = { workspace: WS, pin: genesis.id, personOf };
  const entries = [genesis];
  const add = (op: PolicyOp) => entries.push(makeOp(WS, op, [entries[entries.length - 1]!.id], ada.key));
  add({ t: 'grant', group: WORKSPACE, who: bo.id, role: 'admin' });
  add({ t: 'grant', group: WORKSPACE, who: cy.id, role: 'admin' });
  add({ t: 'grant', group: WORKSPACE, who: dee.id, role: 'member' });
  add({ t: 'grant', group: 'team', who: bo.id, role: 'admin' });
  return { entries, ctx };
}

const headsOf = (held: Map<string, PolicyEntry>) => {
  const named = new Set([...held.values()].flatMap((e) => e.parents));
  return [...held.keys()].filter((id) => !named.has(id));
};

function toOp(spec: OpSpec, by: number, ctx: PolicyContext): PolicyOp {
  switch (spec.t) {
    case 'grant': return { t: 'grant', group: GROUPS[spec.group]!, who: ids[spec.who]!, role: spec.role };
    case 'nest': return { t: 'grant', group: 'team', who: 'group:readers', role: 'member' };
    case 'revoke': return { t: 'revoke', group: GROUPS[spec.group]!, who: ids[spec.who]! };
    case 'leave': return { t: 'revoke', group: GROUPS[spec.group]!, who: ids[by]! };
    case 'owner': return { t: 'owner', who: ids[spec.who]! };
    case 'perm': {
      const write = spec.write.map((i) => ids[i]!).sort();
      const read = spec.read.map((i) => ids[i]!).sort();
      return { t: 'perm', path: PATHS[spec.path]!, ...(write.length ? { write } : {}), ...(read.length && PATHS[spec.path]!.endsWith('/') ? { read } : {}) };
    }
    case 'space': return { t: 'space', id: SPACES[spec.id]!, audience: spec.audience.map((i) => ids[i]!).sort() };
    case 'drop': return { t: 'drop', key: people[spec.whose]!.key.publicKey.toString('hex') };
    case 'unlink': return { t: 'unlink', link: LINKS[spec.link]!, group: GROUPS[spec.group]! };
    case 'admit': return { t: 'admit', link: LINKS[spec.link]!, key: people[spec.who]!.key.publicKey.toString('hex') };
    case 'join': {
      const g = GROUPS[spec.group]!;
      const link = LINKS[spec.link]!;
      // A grant from before links were let in by (counting by itself), or one since (counting only for whom a device in let in).
      const message = spec.admitted ? admittedGrantMessage : linkGrantMessage;
      const grant = crypto.sign(message(WS, ctx.pin, link, g, spec.role, spec.once, 0, ISSUER), people[spec.granter]!.key.secretKey).toString('hex');
      return { t: 'join', group: g, role: spec.role, link, once: spec.once, granter: people[spec.granter]!.key.publicKey.toString('hex'), grant, expires: 0, issuer: ISSUER };
    }
  }
}

/** Play the steps: each device holds what it made and what it took (and what it held before, to make operations on an old view); returns every device's operations. */
function play(steps: Step[]) {
  const { entries, ctx } = begin();
  const devices = Array.from({ length: DEVICES }, () => new Map(entries.map((e) => [e.id, e])));
  const views = Array.from({ length: DEVICES }, () => [headsOf(devices[0]!)]);
  const forged = new Set<string>();
  const made: PolicyEntry[] = [];
  const put = (d: number, e: PolicyEntry) => {
    devices[d]!.set(e.id, e);
    views[d]!.push(headsOf(devices[d]!));
    made.push(e);
  };
  for (const s of steps) {
    if (s.k === 'sync') {
      for (const [id, e] of devices[s.from]!) devices[s.to]!.set(id, e);
      views[s.to]!.push(headsOf(devices[s.to]!));
      continue;
    }
    const held = devices[s.device]!;
    const heads = headsOf(held);
    if (s.k === 'op') {
      const view = views[s.device]!;
      const parents = s.back ? view[Math.max(0, view.length - 1 - s.back)]! : heads;
      // No one in lets Eve in: her joins carry grants she signed herself, and no one admits her key.
      const spec = s.by === EVE && s.op.t === 'join' ? { ...s.op, granter: EVE } : s.op.t === 'admit' && s.op.who === EVE ? { ...s.op, who: s.by === EVE ? 0 : s.by } : s.op;
      put(s.device, makeOp(WS, toOp(spec, s.by, ctx), parents, people[s.by]!.key));
    } else if (s.k === 'stranger') {
      put(s.device, makeOp(WS, toOp(s.op, 0, ctx), heads, strangers[s.who]!));
    } else if (s.k === 'forged') {
      // Naming a parent no one holds: it waits, for ever.
      const e = makeOp(WS, toOp(s.op, s.by, ctx), [...heads, crypto.randomBytes(32).toString('hex')], people[s.by]!.key);
      forged.add(e.id);
      put(s.device, e);
    } else if (s.k === 'replay') {
      // Someone else's grant or join, made again as their own, after what this device holds. (A join by a grant
      // from before links were let in by, for anyone, can be made again by whoever holds the policy until it is
      // unlinked, as 0075 says: Eve, who holds none of it, replays only grants and handovers.)
      const pick = made.filter((e) => ((e.op.t === 'grant' || e.op.t === 'owner') && e.op.who !== ids[EVE]) || (e.op.t === 'join' && s.by !== EVE));
      const e = pick[s.pick % Math.max(1, pick.length)];
      if (e) put(s.device, makeOp(WS, e.op, heads, people[s.by]!.key));
    } else if (s.k === 'rival') {
      // A genesis of someone's own, and an operation on it and on the workspace's heads both.
      const g = makeOp(WS, { t: 'genesis', admins: [ids[s.by]!], legacy: false }, [], people[s.by]!.key);
      put(s.device, g);
      put(s.device, makeOp(WS, { t: 'grant', group: WORKSPACE, who: ids[s.by]!, role: 'admin' }, [g.id, ...heads], people[s.by]!.key));
    }
  }
  const all = new Map<string, PolicyEntry>();
  for (const d of devices) for (const [id, e] of d) all.set(id, e);
  return { ctx, devices: devices.map((d) => [...d.values()]), all: [...all.values()], forged };
}

/** Everything a policy says, in a form two can be compared by. */
function summary(p: Policy) {
  const sorted = <T>(xs: T[]) => [...xs].sort((a, b) => (JSON.stringify(a) < JSON.stringify(b) ? -1 : 1));
  return {
    groups: sorted([...p.groups].map(([g, m]) => [g, sorted([...m])])),
    owner: p.owner,
    perms: sorted([...p.perms]),
    spaces: sorted([...p.spaces]),
    applied: p.applied,
    heads: p.heads,
    cutoffs: sorted([...p.cutoffs]),
    clashes: p.clashes,
    counted: [...p.counted].sort(),
    usedLinks: [...p.usedLinks].sort(),
    dropped: sorted([...p.dropped]),
  };
}

/** Each operation's past: every operation it descends from. */
function pasts(entries: PolicyEntry[]): Map<string, Set<string>> {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const out = new Map<string, Set<string>>();
  const past = (id: string): Set<string> => {
    const had = out.get(id);
    if (had) return had;
    const s = new Set<string>();
    for (const p of byId.get(id)?.parents ?? []) {
      s.add(p);
      for (const x of past(p)) s.add(x);
    }
    out.set(id, s);
    return s;
  };
  for (const e of entries) past(e.id);
  return out;
}

const isPerson = (w: string) => /^[0-9a-f]{64}$/.test(w);

type Place = 'out' | 'member' | 'admin' | 'in';
function placesOf(e: PolicyEntry): { group: string; who: string; place: Place }[] {
  const op = e.op;
  const by = personOf(e.signer)!;
  if (op.t === 'grant') return [{ group: op.group, who: op.who, place: op.role }];
  if (op.t === 'revoke') return [{ group: op.group, who: op.who, place: 'out' }];
  if (op.t === 'owner') return [{ group: WORKSPACE, who: op.who, place: 'admin' }];
  if (op.t === 'join') return op.group === WORKSPACE ? [{ group: WORKSPACE, who: by, place: op.role }] : [{ group: op.group, who: by, place: op.role }, { group: WORKSPACE, who: by, place: 'in' }];
  return [];
}
const differ = (a: Place, b: Place) => a !== b && !((a === 'in' && b !== 'out') || (b === 'in' && a !== 'out'));

/** The rules every policy keeps (docs/policy.md, *What always holds*); a list of those it breaks. */
function broken(p: Policy, entries: PolicyEntry[], forged: Set<string>): string[] {
  const out: string[] = [];
  const ws = p.groups.get(WORKSPACE)!;
  const byId = new Map(entries.map((e) => [e.id, e]));
  const past = pasts(entries);
  const concurrent = (a: string, b: string) => a !== b && !past.get(a)!.has(b) && !past.get(b)!.has(a);
  // One owner, always an admin; so always an admin.
  if (!p.owner) out.push('no owner');
  if (p.owner && ws.get(p.owner) !== 'admin') out.push('the owner is not an admin');
  if (![...ws].some(([w, r]) => isPerson(w) && r === 'admin')) out.push('the workspace has no admin');
  // No one outside the workspace in a group; no stranger or Eve anywhere.
  for (const [g, members] of p.groups) for (const w of members.keys()) {
    if (isPerson(w) && !ws.has(w)) out.push(`${w.slice(0, 6)} is in ${g} but not the workspace`);
    if (w === ids[EVE]) out.push(`Eve, never let in, is in ${g}`);
  }
  const counted = [...p.counted].map((id) => byId.get(id)!).filter((e) => e.op.t !== 'genesis');
  for (const e of counted) {
    if (strangerKeys.has(e.signer) || !personOf(e.signer)) out.push('an operation signed by no one counted');
    if (forged.has(e.id)) out.push('an operation naming a parent no one holds counted');
    if (personOf(e.signer) === ids[EVE]) out.push('an operation of Eve’s counted');
  }
  const applied = p.applied.map((id) => byId.get(id)!).filter((e) => e.op.t !== 'genesis');
  // A removal (or drop) that counts beats what its subject did at the same time, there; but their leaving, and a ring of removals all counting.
  const cuts = (r: PolicyEntry, e: PolicyEntry): boolean => {
    if (r === e || !concurrent(r.id, e.id)) return false;
    if (r.op.t === 'drop') return e.signer === r.op.key;
    if (r.op.t !== 'revoke' && !(r.op.t === 'grant' && r.op.role === 'member')) return false;
    const who = r.op.who;
    if (personOf(e.signer) !== who || (e.op.t === 'revoke' && e.op.who === who)) return false;
    // A grant of member is a removal only of an admin's place: let the policy say; here, a demotion of an admin made by the same past.
    if (r.op.t === 'grant') return false;
    const g = r.op.group;
    return g === WORKSPACE || ((e.op.t === 'grant' || e.op.t === 'revoke' || e.op.t === 'join') && e.op.group === g);
  };
  const reach = (from: PolicyEntry, to: PolicyEntry) => {
    const seen = new Set([from.id]);
    for (const todo = [from]; todo.length;) {
      const x = todo.pop()!;
      for (const y of counted) if (!seen.has(y.id) && cuts(x, y)) {
        if (y === to) return true;
        seen.add(y.id);
        todo.push(y);
      }
    }
    return false;
  };
  // Nothing someone out of the workspace did after (or at the same time as) being taken out counts, but their leaving (and a ring of removals, all counting).
  for (const e of applied) {
    const who = personOf(e.signer);
    if (!who || ws.has(who)) continue;
    if (e.op.t === 'revoke' && e.op.who === who) continue;
    const removals = applied.filter((r) => r.op.t === 'revoke' && r.op.group === WORKSPACE && r.op.who === who);
    if (!removals.some((r) => past.get(r.id)!.has(e.id) || (cuts(r, e) && reach(e, r)))) out.push(`${e.op.t} by ${who.slice(0, 6)}, out of the workspace, counted though not before their removal`);
  }
  for (const r of counted) for (const e of counted) if (cuts(r, e) && !reach(e, r)) out.push(`${e.op.t} counted, made as a removal or drop of its maker counted at the same time`);
  // The restrictive outcome: no two counted at once say different things of one place; at most one handover of two at once.
  for (const a of counted) for (const b of counted) {
    if (a.id >= b.id || !concurrent(a.id, b.id)) continue;
    if (a.op.t === 'owner' && b.op.t === 'owner') out.push('two handovers of the owner’s role made at once both counted');
    for (const x of placesOf(a)) for (const y of placesOf(b)) if (x.group === y.group && x.who === y.who && differ(x.place, y.place)) out.push(`two at once counted saying ${x.place} and ${y.place} of one place`);
    if (a.op.t === 'unlink' && b.op.t === 'join' && a.op.link === b.op.link && a.op.group === b.op.group) out.push('a join counted at once with an unlink of its link');
    if (b.op.t === 'unlink' && a.op.t === 'join' && b.op.link === a.op.link && b.op.group === a.op.group) out.push('a join counted at once with an unlink of its link');
  }
  // Nothing signed by a key dropped counts but what is in the drop's past (and the drop itself), or a ring of drops.
  for (const d of applied) {
    if (d.op.t !== 'drop') continue;
    const key = d.op.key;
    for (const e of applied) if (e !== d && e.signer === key && !past.get(d.id)!.has(e.id) && !reach(e, d)) out.push(`${e.op.t} signed by a dropped key counted, not before the drop`);
  }
  // Nothing by a link unlinked counts but what is in the unlink's past; a grant since links were let in by, only for whom
  // someone in the workspace let in by its link before.
  for (const j of applied) {
    const op = j.op;
    if (op.t !== 'join') continue;
    for (const u of applied) if (u.op.t === 'unlink' && u.op.link === op.link && u.op.group === op.group && !past.get(u.id)!.has(j.id)) out.push('a join counted that was not before its link was unlinked');
    const admitted = crypto.verify(admittedGrantMessage(WS, p.geneses[0]!, op.link, op.group, op.role, op.once, op.expires ?? 0, op.issuer ?? ''), Buffer.from(op.grant, 'hex'), Buffer.from(op.granter, 'hex'));
    if (admitted && !applied.some((a) => a.op.t === 'admit' && a.op.link === op.link && a.op.key === j.signer && past.get(j.id)!.has(a.id))) out.push('a join by a grant since counted with no one letting its maker in');
  }
  // Clashes are on record: each allowed in its own past that did not count lost one; each that lost (but narrowed or once) did not count, to one that did.
  const lost = new Set(p.clashes.map((c) => c.lost));
  for (const id of p.judged) if (!p.counted.has(id) && !lost.has(id)) out.push(`${byId.get(id)!.op.t} did not count, with no clash on record`);
  for (const c of p.clashes) {
    if (c.why === 'narrower' || c.why === 'once') continue;
    if (p.counted.has(c.lost)) out.push(`a ${c.why} clash's loser counted`);
    if (c.won && !p.counted.has(c.won)) out.push(`a ${c.why} clash's winner did not count`);
  }
  return out;
}

const shuffled = <T>(xs: T[], seed: number) => {
  const a = [...xs];
  let s = seed >>> 0 || 1;
  for (let i = a.length - 1; i > 0; i--) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    const j = s % (i + 1);
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

const RUNS = Number(process.env.KURAA_FUZZ_RUNS ?? 300);
const STEPS = Number(process.env.KURAA_FUZZ_STEPS ?? 24);
const SEED = Number(process.env.KURAA_FUZZ_SEED ?? 78);

describe('the policy, over histories made at random', () => {
  // The histories are worth testing: many operations count, many are made at the same time as others that count, and clashes are many.
  it('makes histories with much made at the same time, and clashes of every kind', () => {
    let applied = 0;
    let withConcurrent = 0;
    const whys = new Set<string>();
    const samples = fc.sample(fc.array(fc.oneof(honestStep, adversarialStep), { minLength: 10, maxLength: 24 }), { numRuns: 300, seed: 7 });
    for (const steps of samples) {
      const { ctx, all } = play(steps);
      const p = evaluate(all, ctx);
      const past = pasts(all);
      const counted = p.applied.slice(begin().entries.length);
      applied += counted.length;
      if (counted.some((a) => counted.some((b) => a !== b && !past.get(a)!.has(b) && !past.get(b)!.has(a)))) withConcurrent++;
      for (const c of p.clashes) whys.add(c.why);
    }
    expect(applied / samples.length).toBeGreaterThan(2);
    expect(withConcurrent / samples.length).toBeGreaterThan(0.2);
    // (Two handovers at once, and what was founded on what lost, rarer, are in policy.test.ts.)
    for (const why of ['removed', 'dropped', 'less', 'unlinked', 'narrower']) expect(whys).toContain(why);
  });

  for (const [name, step] of [['honest', honestStep], ['with adversaries', fc.oneof(honestStep, adversarialStep)]] as const) {
    describe(name, () => {
      it('is the same from the same operations, in any order, with any repeated', () => {
        fc.assert(fc.property(fc.array(step, { maxLength: STEPS }), fc.integer(), (steps, seed) => {
          const { ctx, all } = play(steps);
          const once = summary(evaluate(all, ctx));
          expect(summary(evaluate(shuffled(all, seed), ctx))).toEqual(once);
          expect(summary(evaluate([...all, ...shuffled(all, seed ^ 0x5bd1e995).slice(0, 5)], ctx))).toEqual(once);
        }), { numRuns: RUNS, seed: SEED });
      });

      it('keeps its rules on every device, whatever each holds', () => {
        fc.assert(fc.property(fc.array(step, { maxLength: STEPS }), (steps) => {
          const { ctx, devices, all, forged } = play(steps);
          for (const held of [...devices, all]) expect(broken(evaluate(held, ctx), held, forged)).toEqual([]);
        }), { numRuns: RUNS, seed: SEED + 1 });
      });
    });
  }
});
