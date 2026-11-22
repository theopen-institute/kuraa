// A workspace's policy: groups of admins and members, the same on every device (policy.ts, decision 0066).
import { describe, expect, it } from 'vitest';
import crypto from 'hypercore-crypto';
import { evaluate, grantMessage, makeOp, type PolicyEntry, type PolicyOp, type Role } from '../src/peers/policy.js';

const WS = 'ab'.repeat(16);
type Key = ReturnType<typeof crypto.keyPair>;

/** People: each a signing key, and the identity it is (as vouches would say). */
const person = () => {
  const key = crypto.keyPair();
  return { key, id: crypto.keyPair().publicKey.toString('hex') };
};
const [ada, bo, cy, dee] = [person(), person(), person(), person()];
const people = [ada, bo, cy, dee];
const personOf = (k: string) => people.find((p) => p.key.publicKey.toString('hex') === k)?.id ?? null;

/** A history being made: each operation after all before it. */
function history(pin = true) {
  const entries: PolicyEntry[] = [];
  const ctx = () => ({ workspace: WS, pin: pin ? entries[0]?.id ?? null : null, personOf });
  const now = () => evaluate(entries, ctx());
  const add = (op: PolicyOp, by: { key: Key }, parents = op.t === 'genesis' ? [] : now().heads) => {
    const e = makeOp(WS, op, parents, by.key);
    entries.push(e);
    return e;
  };
  return { entries, ctx, now, add };
}

const grant = (who: { id: string }, role: Role, group = 'workspace'): PolicyOp => ({ t: 'grant', group, who: who.id, role });
const sign = (by: { key: Key }, genesis: string | null, link: string, group: string, role: Role, once: boolean) =>
  crypto.sign(grantMessage(WS, genesis, link, group, role, once), by.key.secretKey).toString('hex');

describe('a workspace’s policy', () => {
  it('lets admins, and only admins, change who is in it; keeps one admin', () => {
    const h = history();
    h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    expect(h.now().role(ada.id)).toBe('admin');
    h.add(grant(bo, 'member'), ada);
    expect(h.now().role(bo.id)).toBe('member');
    // A member may not.
    h.add(grant(cy, 'admin'), bo);
    expect(h.now().role(cy.id)).toBeNull();
    // The only admin may not stop being one, nor be taken out.
    h.add(grant(ada, 'member'), ada);
    h.add({ t: 'revoke', group: 'workspace', who: ada.id }, ada);
    expect(h.now().role(ada.id)).toBe('admin');
    // Once Bo is an admin too, Ada may leave.
    h.add(grant(bo, 'admin'), ada);
    h.add({ t: 'revoke', group: 'workspace', who: ada.id }, ada);
    expect(h.now().role(ada.id)).toBeNull();
    expect(h.now().people()).toEqual([{ id: bo.id, role: 'admin' }]);
  });

  it('has groups the workspace’s admins make, each managed by its own admins too, inside the workspace', () => {
    const h = history();
    h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    h.add(grant(bo, 'member'), ada);
    h.add(grant(cy, 'member'), ada);
    // Bo may not make a group; Ada may, and makes him its admin.
    h.add(grant(bo, 'admin', 'editors'), bo);
    expect(h.now().groups.has('editors')).toBe(false);
    h.add(grant(bo, 'admin', 'editors'), ada);
    h.add(grant(cy, 'member', 'editors'), bo);
    expect(h.now().role(cy.id, 'editors')).toBe('member');
    // No one outside the workspace is put in a group.
    h.add(grant(dee, 'member', 'editors'), bo);
    expect(h.now().role(dee.id, 'editors')).toBeNull();
    // A group in a group: its members are members.
    h.add({ t: 'grant', group: 'team', who: 'group:editors', role: 'member' }, ada);
    expect(h.now().role(cy.id, 'team')).toBe('member');
    // Anyone may leave a group; out of the workspace is out of every group.
    h.add({ t: 'revoke', group: 'editors', who: cy.id }, cy);
    expect(h.now().role(cy.id, 'editors')).toBeNull();
    h.add({ t: 'revoke', group: 'workspace', who: bo.id }, ada);
    expect(h.now().groups.get('editors')!.has(bo.id)).toBe(false);
  });

  it('puts whoever an admin’s invite link let in in its group, as it says; a link for one person, once', () => {
    const h = history();
    const g = h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    const link = '0123456789abcdef';
    const join = (who: { key: Key }, by: { key: Key }, role: Role, once: boolean, genesis: string | null = g.id) =>
      h.add({ t: 'join', group: 'workspace', role, link, once, granter: by.key.publicKey.toString('hex'), grant: sign(by, genesis, link, 'workspace', role, once) }, who);
    join(bo, ada, 'member', true);
    expect(h.now().role(bo.id)).toBe('member');
    // Used: no one else comes in by it.
    join(cy, ada, 'member', true);
    expect(h.now().role(cy.id)).toBeNull();
    // A member's grant lets no one in; nor one for another history of the workspace.
    const other = '1123456789abcdef';
    h.add({ t: 'join', group: 'workspace', role: 'admin', link: other, once: false, granter: bo.key.publicKey.toString('hex'), grant: sign(bo, g.id, other, 'workspace', 'admin', false) }, cy);
    expect(h.now().role(cy.id)).toBeNull();
    h.add({ t: 'join', group: 'workspace', role: 'member', link: other, once: false, granter: ada.key.publicKey.toString('hex'), grant: sign(ada, 'cd'.repeat(32), other, 'workspace', 'member', false) }, cy);
    expect(h.now().role(cy.id)).toBeNull();
    // A grant changed after it was signed (member to admin) counts for nothing.
    h.add({ t: 'join', group: 'workspace', role: 'admin', link: other, once: false, granter: ada.key.publicKey.toString('hex'), grant: sign(ada, g.id, other, 'workspace', 'member', false) }, dee);
    expect(h.now().role(dee.id)).toBeNull();
  });

  it('is the same from its operations in any order, and counts only those from the genesis it is pinned to', () => {
    const h = history();
    h.add({ t: 'genesis', admins: [ada.id], legacy: false }, ada);
    h.add(grant(bo, 'admin'), ada);
    h.add(grant(cy, 'member'), bo);
    h.add(grant(dee, 'member'), cy);
    const want = h.now();
    const shuffled = [...h.entries].reverse();
    const again = evaluate(shuffled, h.ctx());
    expect(again.people()).toEqual(want.people());
    expect(again.heads).toEqual(want.heads);
    expect(again.version).toBe(want.version);
    // A second genesis, by someone who would be its admin, counts for nothing; nor what descends from it.
    const rival = makeOp(WS, { t: 'genesis', admins: [dee.id], legacy: false }, [], dee.key);
    const after = makeOp(WS, grant(cy, 'admin'), [rival.id], dee.key);
    expect(evaluate([...h.entries, rival, after], h.ctx()).people()).toEqual(want.people());
    // Missing an operation's parent: it waits.
    expect(evaluate(h.entries.filter((_, i) => i !== 1), h.ctx()).role(cy.id)).toBeNull();
  });

  it('in a workspace from before: everyone its devices wrote down an admin, until an admin seals the list', () => {
    const h = history(false);
    h.add({ t: 'genesis', admins: [ada.id, bo.id], legacy: true }, ada);
    h.add({ t: 'genesis', admins: [bo.id, cy.id], legacy: true }, bo);
    expect(h.now().people().map((p) => p.role)).toEqual(['admin', 'admin', 'admin']);
    // A genesis of a workspace made since does not count here.
    h.add({ t: 'genesis', admins: [dee.id], legacy: false }, dee);
    expect(h.now().role(dee.id)).toBeNull();
    // Ada seals it: a legacy genesis made later does not count.
    h.add({ t: 'seal', geneses: h.now().geneses }, ada);
    h.add({ t: 'genesis', admins: [dee.id], legacy: true }, dee);
    expect(h.now().role(dee.id)).toBeNull();
    expect(h.now().sealed).toBe(true);
    expect(h.now().role(cy.id)).toBe('admin');
  });
});
