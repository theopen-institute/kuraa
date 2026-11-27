// Servers in a workspace's policy (decision 0099): a key no person vouched for, in by its own join with
// the owner's invite link for a server; reading the workspace's files and spaces naming it, changing
// nothing, acting in nothing, taken out by the owner's drop of its key.
import { describe, expect, it } from 'vitest';
import crypto from 'hypercore-crypto';
import { admittedGrantMessage, evaluate, makeOp, readOp, type JoinRole, type PolicyEntry, type PolicyOp } from '../src/peers/policy.js';

const WS = 'cd'.repeat(16);
type Key = ReturnType<typeof crypto.keyPair>;

const person = () => ({ key: crypto.keyPair(), id: crypto.keyPair().publicKey.toString('hex') });
const [ada, bo, cy] = [person(), person(), person()];
const people = [ada, bo, cy];
const personOf = (k: string) => people.find((p) => p.key.publicKey.toString('hex') === k)?.id ?? null;
/** A server: a signing key, no identity. */
const server = () => {
  const key = crypto.keyPair();
  return { key, id: key.publicKey.toString('hex') };
};
const hexOf = (k: { key: Key }) => k.key.publicKey.toString('hex');
const ISSUER = 'ee'.repeat(32);

function history() {
  const entries: PolicyEntry[] = [];
  const ctx = () => ({ workspace: WS, pin: entries[0]?.id ?? null, personOf });
  const now = () => evaluate(entries, ctx());
  const add = (op: PolicyOp, by: { key: Key }, parents = op.t === 'genesis' ? [] : now().heads) => {
    const e = makeOp(WS, op, parents, by.key);
    entries.push(e);
    return e;
  };
  const genesis = add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
  /** An invite link's grant, by `granter`, as a link let in by (`/3`). */
  const grantFor = (granter: { key: Key }, link: string, role: JoinRole, once = true, group = 'workspace') =>
    crypto.sign(admittedGrantMessage(WS, genesis.id, link, group, role, once, 0, ISSUER), granter.key.secretKey).toString('hex');
  /** `who` joins by a link `granter` made, let in by `admitter`'s device first. */
  const join = (who: { key: Key }, granter: { key: Key }, o: { link?: string; role?: JoinRole; once?: boolean; admitter?: { key: Key } | null; parents?: string[] } = {}) => {
    const link = o.link ?? crypto.randomBytes(8).toString('hex');
    const role = o.role ?? 'server';
    const once = o.once ?? true;
    if (o.admitter !== null) add({ t: 'admit', link, key: hexOf(who) }, o.admitter ?? ada);
    return add({ t: 'join', group: 'workspace', role, link, once, granter: hexOf(granter), grant: grantFor(granter, link, role, once), expires: 0, issuer: ISSUER }, who, o.parents);
  };
  return { entries, ctx, now, add, join, genesis };
}

describe('servers in the policy (0099)', () => {
  it('reads a server’s join only for the workspace', () => {
    const base = { t: 'join', role: 'server', link: '0123456789abcdef', once: true, granter: 'aa'.repeat(32), grant: 'bb'.repeat(64) };
    expect(readOp({ ...base, group: 'workspace' })).not.toBeNull();
    expect(readOp({ ...base, group: 'editors' })).toBeNull();
  });

  it('takes a server in by its own join, with the owner’s link for one server, let in by a device in the workspace', () => {
    const h = history();
    h.add({ t: 'grant', group: 'workspace', who: bo.id, role: 'admin' }, ada);
    const s = server();
    h.join(s, ada);
    const p = h.now();
    expect(p.isServer(s.id)).toBe(true);
    expect([...p.servers]).toEqual([s.id]);
    // Not a person: in no group, no role, not among the people.
    expect(p.role(s.id)).toBeNull();
    expect(p.people().map((x) => x.id)).not.toContain(s.id);
  });

  it('refuses a server’s join by an admin’s link, a link for anyone, one no device let it in by, or a link used', () => {
    const h = history();
    h.add({ t: 'grant', group: 'workspace', who: bo.id, role: 'admin' }, ada);
    const [s1, s2, s3, s4, s5] = [server(), server(), server(), server(), server()];
    // An admin is not the owner.
    h.join(s1, bo);
    // A link for anyone.
    h.join(s2, ada, { once: false });
    // No device said it let it in.
    h.join(s3, ada, { admitter: null });
    // A link for one server, used by another.
    const link = '00112233aabbccdd';
    h.join(s4, ada, { link });
    h.join(s5, ada, { link });
    const p = h.now();
    expect([...p.servers]).toEqual([s4.id]);
  });

  it('refuses a server’s join signed by a person’s key, and a person’s join by a server’s link', () => {
    const h = history();
    // Cy (a person) holds a link for a server: their join is a person's, and counts for nothing.
    h.join(cy, ada);
    const p = h.now();
    expect(p.servers.size).toBe(0);
    expect(p.role(cy.id)).toBeNull();
  });

  it('counts nothing else a server signs: no grant, no rule, no admit', () => {
    const h = history();
    const s = server();
    h.join(s, ada);
    h.add({ t: 'grant', group: 'workspace', who: cy.id, role: 'member' }, s);
    h.add({ t: 'rule', path: '', by: [s.id] }, s);
    const before = h.now().applied.length;
    h.add({ t: 'admit', link: 'ffffffffffffffff', key: hexOf(cy) }, s);
    const p = h.now();
    expect(p.role(cy.id)).toBeNull();
    expect(p.rules.size).toBe(0);
    expect(p.applied.length).toBe(before);
  });

  it('puts a server in no group: a grant naming it counts for nothing', () => {
    const h = history();
    const s = server();
    h.join(s, ada);
    h.add({ t: 'grant', group: 'workspace', who: s.id, role: 'member' }, ada);
    h.add({ t: 'grant', group: 'editors', who: s.id, role: 'member' }, ada);
    const p = h.now();
    expect(p.role(s.id)).toBeNull();
    expect(p.groups.get('editors')?.has(s.id) ?? false).toBe(false);
  });

  it('lets a server read the workspace’s own files and spaces naming it, and change nothing', () => {
    const h = history();
    h.add({ t: 'grant', group: 'workspace', who: bo.id, role: 'member' }, ada);
    const s = server();
    h.join(s, ada);
    const named = 'a1'.repeat(16);
    const unnamed = 'b2'.repeat(16);
    const admins = 'c3'.repeat(16);
    h.add({ t: 'space', id: named, audience: [ada.id, s.id].sort() }, ada);
    h.add({ t: 'space', id: unnamed, audience: [ada.id] }, ada);
    h.add({ t: 'space', id: admins, audience: ['admins'] }, ada);
    let p = h.now();
    expect(p.mayRead(s.id, null)).toBe(true);
    expect(p.mayRead(s.id, named)).toBe(true);
    expect(p.mayRead(s.id, unnamed)).toBe(false);
    expect(p.mayRead(s.id, admins)).toBe(false);
    // Nothing written: where no rule says, where a rule names it, its "own" files.
    expect(p.mayWrite(s.id, 'a.md')).toBe(false);
    h.add({ t: 'rule', path: 'notes/', by: [s.id] }, ada);
    p = h.now();
    expect(p.mayWrite(s.id, 'notes/a.md')).toBe(false);
    expect(p.mayWrite(s.id, `a.md.notes/@${s.id}.json`)).toBe(false);
    // Bo still writes where no rule says.
    expect(p.mayWrite(bo.id, 'a.md')).toBe(true);
  });

  it('takes a server out by the owner’s drop of its key, for good; an admin may not', () => {
    const h = history();
    h.add({ t: 'grant', group: 'workspace', who: bo.id, role: 'admin' }, ada);
    const s = server();
    h.join(s, ada);
    h.add({ t: 'drop', key: s.id }, bo);
    expect(h.now().isServer(s.id)).toBe(true);
    h.add({ t: 'drop', key: s.id }, ada);
    expect(h.now().isServer(s.id)).toBe(false);
    expect(h.now().dropped.has(s.id)).toBe(true);
    // Invited again, it does not come back: its key was dropped for good.
    h.join(s, ada);
    expect(h.now().isServer(s.id)).toBe(false);
  });

  it('takes a server out by the owner, as a person is taken out, and lets it back in by a new link; an admin may not', () => {
    const h = history();
    h.add({ t: 'grant', group: 'workspace', who: bo.id, role: 'admin' }, ada);
    const s = server();
    const first = '0a0a0a0a0a0a0a0a';
    h.join(s, ada, { link: first });
    h.add({ t: 'revoke', group: 'workspace', who: s.id }, bo);
    expect(h.now().isServer(s.id)).toBe(true);
    h.add({ t: 'revoke', group: 'workspace', who: s.id }, ada);
    expect(h.now().isServer(s.id)).toBe(false);
    expect(h.now().dropped.has(s.id)).toBe(false);
    // Out: its cutoff on record, as anyone's taken out.
    expect(h.now().cutoffs.has(s.id)).toBe(true);
    // Not by the link it came in by (used), but by a new one, of the owner's.
    h.join(s, ada, { link: first });
    expect(h.now().isServer(s.id)).toBe(false);
    h.join(s, bo);
    expect(h.now().isServer(s.id)).toBe(false);
    h.join(s, ada);
    const p = h.now();
    expect(p.isServer(s.id)).toBe(true);
    expect(p.cutoffs.has(s.id)).toBe(false);
    expect(p.role(s.id)).toBeNull();
    // The same from the operations in any order.
    expect([...evaluate([...h.entries].reverse(), h.ctx()).servers]).toEqual([s.id]);
  });

  it('counts a taking out and a drop made at the same time both: out, and for good', () => {
    const h = history();
    const s = server();
    h.join(s, ada);
    const at = h.now().heads;
    h.add({ t: 'revoke', group: 'workspace', who: s.id }, ada, at);
    h.add({ t: 'drop', key: s.id }, ada, at);
    const p = h.now();
    expect(p.isServer(s.id)).toBe(false);
    expect(p.dropped.has(s.id)).toBe(true);
    expect(evaluate([...h.entries].reverse(), h.ctx()).dropped.has(s.id)).toBe(true);
  });

  it('keeps a drop for good, unlike a taking out: no link lets the key back in', () => {
    const h = history();
    const s = server();
    h.join(s, ada);
    h.add({ t: 'drop', key: s.id }, ada);
    h.join(s, ada);
    expect(h.now().isServer(s.id)).toBe(false);
    // Nor taken out and back: a dropped key is no one's word.
    h.add({ t: 'revoke', group: 'workspace', who: s.id }, ada);
    h.join(s, ada);
    expect(h.now().isServer(s.id)).toBe(false);
  });

  it('lets a drop at the same time as a server’s join win, in any order', () => {
    const h = history();
    const s = server();
    const at = h.now().heads;
    h.add({ t: 'admit', link: '1234123412341234', key: s.id }, ada, at);
    const afterAdmit = h.now().heads;
    // The owner drops the key, not having seen the join; the join, not having seen the drop.
    h.add({ t: 'drop', key: s.id }, ada, afterAdmit);
    h.join(s, ada, { link: '1234123412341234', admitter: null, parents: afterAdmit });
    const p = h.now();
    expect(p.isServer(s.id)).toBe(false);
    expect(p.clashes.some((c) => c.why === 'dropped')).toBe(true);
    const again = evaluate([...h.entries].reverse(), h.ctx());
    expect([...again.servers]).toEqual([...p.servers]);
    expect(again.clashes).toEqual(p.clashes);
  });

  it('lets an unlink at the same time as a server’s join win', () => {
    const h = history();
    const s = server();
    h.add({ t: 'admit', link: '5678567856785678', key: s.id }, ada);
    const at = h.now().heads;
    h.add({ t: 'unlink', link: '5678567856785678', group: 'workspace' }, ada, at);
    h.join(s, ada, { link: '5678567856785678', admitter: null, parents: at });
    expect(h.now().isServer(s.id)).toBe(false);
  });

  it('has several servers, each in by a link of its own', () => {
    const h = history();
    const [s1, s2] = [server(), server()];
    h.join(s1, ada);
    h.join(s2, ada);
    expect([...h.now().servers].sort()).toEqual([s1.id, s2.id].sort());
  });

  it('keeps a server’s join counting when the owner hands the role on, and lets the new owner drop it', () => {
    const h = history();
    h.add({ t: 'grant', group: 'workspace', who: bo.id, role: 'member' }, ada);
    const s = server();
    h.join(s, ada);
    h.add({ t: 'owner', who: bo.id }, ada);
    expect(h.now().isServer(s.id)).toBe(true);
    h.add({ t: 'drop', key: s.id }, ada);
    expect(h.now().isServer(s.id)).toBe(true);
    h.add({ t: 'drop', key: s.id }, bo);
    expect(h.now().isServer(s.id)).toBe(false);
  });
});
