// The policy's properties, over histories made at random (docs/policy.md; decision 0072).
//
// Several devices make operations, each on the policy as it knows it, and pass
// what they hold to one another now and then, so operations are made at the
// same time as others, by people being taken out, made admins, given the
// workspace, and so on. Whatever happens, every device that holds the same
// operations must come to the same policy, and that policy must keep the rules
// docs/policy.md sets out.
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import crypto from 'hypercore-crypto';
import { evaluate, linkGrantMessage, makeOp, WORKSPACE, type Policy, type PolicyContext, type PolicyEntry, type PolicyOp, type Role } from '../src/peers/policy.js';

const WS = 'cd'.repeat(16);
const ISSUER = 'ee'.repeat(32);
const people = Array.from({ length: 5 }, () => ({ key: crypto.keyPair(), id: crypto.keyPair().publicKey.toString('hex') }));
const byKey = new Map(people.map((p) => [p.key.publicKey.toString('hex'), p.id]));
const personOf = (k: string) => byKey.get(k) ?? null;
const ids = people.map((p) => p.id);
const [ada, bo, cy, dee] = people as [typeof people[0], typeof people[0], typeof people[0], typeof people[0]];
const GROUPS = [WORKSPACE, 'team'];
const PATHS = ['', 'chapters/', 'chapters/one.md'];
const SPACES = ['11'.repeat(16), '22'.repeat(16)];
const LINKS = ['0123456789abcdef', 'fedcba9876543210'];

/** What a device does next: make an operation, or take what another holds. */
type Step =
  | { k: 'op'; device: number; by: number; op: OpSpec }
  | { k: 'sync'; from: number; to: number };

type OpSpec =
  | { t: 'grant'; group: number; who: number; role: Role }
  | { t: 'nest' }
  | { t: 'revoke'; group: number; who: number }
  | { t: 'leave'; group: number }
  | { t: 'owner'; who: number }
  | { t: 'perm'; path: number; write: number[] }
  | { t: 'space'; id: number; audience: number[] }
  | { t: 'join'; group: number; role: Role; granter: number; link: number; once: boolean }
  | { t: 'drop'; whose: number };

const person = fc.integer({ min: 0, max: people.length - 1 });
const role = fc.constantFrom<Role>('admin', 'member');
const group = fc.integer({ min: 0, max: GROUPS.length - 1 });
const opSpec: fc.Arbitrary<OpSpec> = fc.oneof(
  { weight: 4, arbitrary: fc.record({ t: fc.constant('grant' as const), group, who: person, role }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('nest' as const) }) },
  { weight: 4, arbitrary: fc.record({ t: fc.constant('revoke' as const), group, who: person }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('leave' as const), group }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('owner' as const), who: person }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('perm' as const), path: fc.integer({ min: 0, max: PATHS.length - 1 }), write: fc.uniqueArray(person, { maxLength: 2 }) }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('space' as const), id: fc.integer({ min: 0, max: SPACES.length - 1 }), audience: fc.uniqueArray(person, { minLength: 1, maxLength: 3 }) }) },
  { weight: 2, arbitrary: fc.record({ t: fc.constant('join' as const), group, role, granter: person, link: fc.integer({ min: 0, max: LINKS.length - 1 }), once: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ t: fc.constant('drop' as const), whose: person }) },
);
const DEVICES = 3;
const device = fc.integer({ min: 0, max: DEVICES - 1 });
const step: fc.Arbitrary<Step> = fc.oneof(
  { weight: 3, arbitrary: fc.record({ k: fc.constant('op' as const), device, by: person, op: opSpec }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant('sync' as const), from: device, to: device }) },
);

/** The workspace's start: a pinned genesis (Ada its owner), or one from before (Ada, Bo and Cy equal admins, no owner). */
function begin(pinned: boolean): { entries: PolicyEntry[]; ctx: PolicyContext } {
  const genesis = makeOp(WS, { t: 'genesis', admins: pinned ? [ada.id] : [ada.id, bo.id, cy.id].sort(), legacy: !pinned }, [], ada.key);
  const ctx: PolicyContext = { workspace: WS, pin: pinned ? genesis.id : null, personOf };
  const entries = [genesis];
  const add = (op: PolicyOp) => entries.push(makeOp(WS, op, [entries[entries.length - 1]!.id], ada.key));
  if (pinned) {
    add({ t: 'grant', group: WORKSPACE, who: bo.id, role: 'admin' });
    add({ t: 'grant', group: WORKSPACE, who: cy.id, role: 'admin' });
  }
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
    case 'perm': return spec.write.length ? { t: 'perm', path: PATHS[spec.path]!, write: spec.write.map((i) => ids[i]!).sort() } : { t: 'perm', path: PATHS[spec.path]! };
    case 'space': return { t: 'space', id: SPACES[spec.id]!, audience: spec.audience.map((i) => ids[i]!).sort() };
    case 'drop': return { t: 'drop', key: people[spec.whose]!.key.publicKey.toString('hex') };
    case 'join': {
      const g = GROUPS[spec.group]!;
      const link = LINKS[spec.link]!;
      const grant = crypto.sign(linkGrantMessage(WS, ctx.pin, link, g, spec.role, spec.once, 0, ISSUER), people[spec.granter]!.key.secretKey).toString('hex');
      return { t: 'join', group: g, role: spec.role, link, once: spec.once, granter: people[spec.granter]!.key.publicKey.toString('hex'), grant, expires: 0, issuer: ISSUER };
    }
  }
}

/** Play the steps: each device holds what it made and what it took; returns every device's operations. */
function play(pinned: boolean, steps: Step[]) {
  const { entries, ctx } = begin(pinned);
  const devices = Array.from({ length: DEVICES }, () => new Map(entries.map((e) => [e.id, e])));
  for (const s of steps) {
    if (s.k === 'sync') {
      for (const [id, e] of devices[s.from]!) devices[s.to]!.set(id, e);
      continue;
    }
    const held = devices[s.device]!;
    const e = makeOp(WS, toOp(s.op, s.by, ctx), headsOf(held), people[s.by]!.key);
    held.set(e.id, e);
  }
  const all = new Map<string, PolicyEntry>();
  for (const d of devices) for (const [id, e] of d) all.set(id, e);
  return { ctx, devices: devices.map((d) => [...d.values()]), all: [...all.values()] };
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
    disputes: p.disputes,
    usedLinks: [...p.usedLinks].sort(),
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

/** The rules every policy keeps (docs/policy.md, *What always holds*); a list of those it breaks. */
function broken(p: Policy, entries: PolicyEntry[], pinned: boolean): string[] {
  const out: string[] = [];
  const ws = p.groups.get(WORKSPACE)!;
  const admins = [...ws].filter(([w, r]) => isPerson(w) && r === 'admin').map(([w]) => w);
  if (!admins.length) out.push('the workspace has no admin');
  if (pinned && !p.owner) out.push('a pinned workspace has no owner');
  if (p.owner && ws.get(p.owner) !== 'admin') out.push('the owner is not an admin');
  for (const [g, members] of p.groups) for (const w of members.keys()) if (isPerson(w) && !ws.has(w)) out.push(`${w.slice(0, 6)} is in ${g} but not the workspace`);
  // Nothing someone out of the workspace did after (or at the same time as) being taken out counts.
  const byId = new Map(entries.map((e) => [e.id, e]));
  const past = pasts(entries);
  const applied = p.applied.map((id) => byId.get(id)!).filter((e) => e.op.t !== 'genesis');
  for (const e of applied) {
    const who = personOf(e.signer);
    if (!who) {
      out.push('an operation signed by no one counted');
      continue;
    }
    if (ws.has(who)) continue;
    // Leaving a group oneself is no power, and always counts.
    if (e.op.t === 'revoke' && e.op.who === who) continue;
    const removals = applied.filter((r) => r.op.t === 'revoke' && r.op.group === WORKSPACE && r.op.who === who);
    if (!removals.some((r) => past.get(r.id)!.has(e.id))) out.push(`${e.op.t} by ${who.slice(0, 6)}, out of the workspace, counted though not before their removal`);
  }
  // Nothing signed by a key dropped counts but what is in the drop's past (and the drop itself).
  for (const d of applied) {
    if (d.op.t !== 'drop') continue;
    const key = d.op.key;
    for (const e of applied) if (e !== d && e.signer === key && !past.get(d.id)!.has(e.id)) out.push(`${e.op.t} signed by a dropped key counted, not before the drop`);
  }
  if ([...p.dropped.keys()].some((k) => !applied.some((d) => d.op.t === 'drop' && d.op.key === k))) out.push('a key dropped by no drop that counted');
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

const RUNS = Number(process.env.KURAA_FUZZ_RUNS ?? 500);

describe('the policy, over histories made at random', () => {
  // The histories are worth testing: many operations count, and many are made at the same time as others that count.
  it('makes histories with much made at the same time', () => {
    let applied = 0;
    let withConcurrent = 0;
    const samples = fc.sample(fc.tuple(fc.boolean(), fc.array(step, { minLength: 10, maxLength: 24 })), { numRuns: 200, seed: 7 });
    for (const [pinned, steps] of samples) {
      const { ctx, all } = play(pinned, steps);
      const p = evaluate(all, ctx);
      const past = pasts(all);
      const counted = p.applied.slice(begin(pinned).entries.length);
      applied += counted.length;
      if (counted.some((a) => counted.some((b) => a !== b && !past.get(a)!.has(b) && !past.get(b)!.has(a)))) withConcurrent++;
    }
    expect(applied / samples.length).toBeGreaterThan(3);
    expect(withConcurrent / samples.length).toBeGreaterThan(0.3);
  });

  for (const pinned of [true, false]) {
    describe(pinned ? 'a workspace with an owner' : 'a workspace from before, its admins equal', () => {
      it('is the same from the same operations, in any order, with any repeated', () => {
        fc.assert(fc.property(fc.array(step, { maxLength: Number(process.env.KURAA_FUZZ_STEPS ?? 24) }), fc.integer(), (steps, seed) => {
          const { ctx, all } = play(pinned, steps);
          const once = summary(evaluate(all, ctx));
          expect(summary(evaluate(shuffled(all, seed), ctx))).toEqual(once);
          expect(summary(evaluate([...all, ...shuffled(all, seed ^ 0x5bd1e995).slice(0, 5)], ctx))).toEqual(once);
        }), { numRuns: RUNS });
      });

      it('keeps its rules on every device, whatever each holds', () => {
        fc.assert(fc.property(fc.array(step, { maxLength: Number(process.env.KURAA_FUZZ_STEPS ?? 24) }), (steps) => {
          const { ctx, devices, all } = play(pinned, steps);
          for (const held of [...devices, all]) expect(broken(evaluate(held, ctx), held, pinned)).toEqual([]);
        }), { numRuns: RUNS });
      });
    });
  }
});
