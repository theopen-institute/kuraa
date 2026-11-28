// The rules of 0121, as a workspace's owner says it is judged by them (`rules` 13): no one overrides what anyone ever
// made an admin is, or an admin's or a server's join, by naming old parents (at the same time is the maker's to say),
// but the owner; a space made with a nonce is its maker's ID; a link of its own key is joined by its holder alone.
import { describe, expect, it } from 'vitest';
import crypto from 'hypercore-crypto';
import { admittedGrantMessage, boundGrantMessage, evaluate, linkProofMessage, makeOp, readOp, spaceIdFor, type PolicyEntry, type PolicyOp } from '../src/peers/policy.js';

const WS = 'ab'.repeat(16);
type Key = ReturnType<typeof crypto.keyPair>;
const hex = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');
const sig = (m: Buffer, k: Key) => crypto.sign(m, k.secretKey).toString('hex');

function history(rules: boolean) {
  const people: { key: Key; id: string }[] = [];
  const entries: PolicyEntry[] = [];
  const personOf = (k: string) => people.find((p) => hex(p.key) === k)?.id ?? null;
  const ctx = () => ({ workspace: WS, pin: entries[0]?.id ?? null, personOf });
  const now = () => evaluate(entries, ctx());
  const add = (op: PolicyOp, key: Key, parents?: string[]) => {
    const e = makeOp(WS, op, parents ?? (op.t === 'genesis' ? [] : now().heads), key);
    entries.push(e);
    return e;
  };
  const person = () => {
    const p = { key: crypto.keyPair(), id: crypto.keyPair().publicKey.toString('hex') };
    people.push(p);
    return p;
  };
  const O = person();
  const genesis = add({ t: 'genesis', admins: [O.id], legacy: false }, O.key);
  if (rules) add({ t: 'rules', v: 13 }, O.key);
  return { entries, now, add, person, O, genesis };
}

describe('the rules of 0121: who may override whom', () => {
  it('counts a rules operation only from the owner, and judges the whole history by it', () => {
    const h = history(false);
    const A = h.person();
    h.add({ t: 'grant', group: 'workspace', who: A.id, role: 'admin' }, h.O.key);
    h.add({ t: 'rules', v: 13 }, A.key);
    expect(h.now().rulesVersion).toBe(12);
    h.add({ t: 'rules', v: 13 }, h.O.key);
    expect(h.now().rulesVersion).toBe(13);
    expect(h.now().rulesUnknown).toBe(false);
    // Later rules than this build knows: said, to be updated.
    h.add({ t: 'rules', v: 14 }, h.O.key);
    expect(h.now().rulesUnknown).toBe(true);
  });

  for (const rules of [false, true]) {
    it(`${rules ? 'stops' : 'without them, lets'} an admin demote another admin by naming old parents`, () => {
      const h = history(rules);
      const A = h.person();
      const B = h.person();
      const gA = h.add({ t: 'grant', group: 'workspace', who: A.id, role: 'admin' }, h.O.key);
      h.add({ t: 'grant', group: 'workspace', who: B.id, role: 'admin' }, h.O.key);
      h.add({ t: 'grant', group: 'workspace', who: B.id, role: 'member' }, A.key, [gA.id]);
      expect(h.now().role(B.id)).toBe(rules ? 'admin' : 'member');
    });
  }

  it('stops an admin undoing the owner’s handover, taking out or dropping an admin, by naming old parents', () => {
    const h = history(true);
    const A = h.person();
    const B = h.person();
    const C = h.person();
    const gA = h.add({ t: 'grant', group: 'workspace', who: A.id, role: 'admin' }, h.O.key);
    h.add({ t: 'grant', group: 'workspace', who: B.id, role: 'member' }, h.O.key);
    h.add({ t: 'owner', who: B.id }, h.O.key);
    h.add({ t: 'grant', group: 'workspace', who: B.id, role: 'member' }, A.key, [gA.id]);
    expect(h.now().owner).toBe(B.id);
    // C made an admin by the new owner; A takes C out, and drops C's key, as if before.
    h.add({ t: 'grant', group: 'workspace', who: C.id, role: 'admin' }, B.key);
    h.add({ t: 'revoke', group: 'workspace', who: C.id }, A.key, [gA.id]);
    h.add({ t: 'drop', key: hex(C.key) }, A.key, [gA.id]);
    expect(h.now().role(C.id)).toBe('admin');
    expect(h.now().dropped.has(hex(C.key))).toBe(false);
  });

  it('stops an admin unlinking a server’s link after the fact, which would take out the server and everyone it let in', () => {
    const h = history(true);
    const A = h.person();
    const M = h.person();
    const P = h.person();
    h.add({ t: 'grant', group: 'workspace', who: A.id, role: 'admin' }, h.O.key);
    const before = h.add({ t: 'grant', group: 'workspace', who: M.id, role: 'member' }, h.O.key);
    const S = crypto.keyPair();
    const sl = '1111111111111111';
    h.add({ t: 'admit', link: sl, key: hex(S) }, M.key);
    h.add({ t: 'join', group: 'workspace', role: 'server', link: sl, once: true, granter: hex(h.O.key), grant: sig(admittedGrantMessage(WS, h.genesis.id, sl, 'workspace', 'server', true, 0, hex(h.O.key)), h.O.key), expires: 0, issuer: hex(h.O.key) }, S);
    const pl = '2222222222222222';
    h.add({ t: 'admit', link: pl, key: hex(P.key) }, S);
    h.add({ t: 'join', group: 'workspace', role: 'member', link: pl, once: true, granter: hex(A.key), grant: sig(admittedGrantMessage(WS, h.genesis.id, pl, 'workspace', 'member', true, 0, hex(A.key)), A.key), expires: 0, issuer: hex(A.key) }, P.key);
    h.add({ t: 'unlink', link: sl, group: 'workspace' }, A.key, [before.id]);
    expect(h.now().isServer(hex(S))).toBe(true);
    expect(h.now().role(P.id)).toBe('member');
  });

  it('still settles honest operations at once as before: the owner overrides an admin, the less of two admins’ words on a member counts', () => {
    const h = history(true);
    const A = h.person();
    const A2 = h.person();
    const M = h.person();
    const gA = h.add({ t: 'grant', group: 'workspace', who: A.id, role: 'admin' }, h.O.key);
    h.add({ t: 'grant', group: 'workspace', who: A2.id, role: 'admin' }, h.O.key);
    const gM = h.add({ t: 'grant', group: 'workspace', who: M.id, role: 'member' }, h.O.key);
    // Two admins at once: one takes M out, the other (no change) says member. Out counts.
    h.add({ t: 'revoke', group: 'workspace', who: M.id }, A.key, [gM.id]);
    h.add({ t: 'grant', group: 'workspace', who: M.id, role: 'member' }, A2.key, [gM.id]);
    expect(h.now().role(M.id)).toBeNull();
    // The owner, at the same time as A is made admin, makes A a member: the owner's word, the less, counts.
    h.add({ t: 'grant', group: 'workspace', who: A.id, role: 'member' }, h.O.key, [gA.id]);
    expect(h.now().role(A.id)).toBe('member');
  });
});

describe('spaces made with a nonce (0121)', () => {
  it('are their makers’: no one else makes them again, with a nonce or without', () => {
    const h = history(true);
    const Ana = h.person();
    const Mal = h.person();
    h.add({ t: 'grant', group: 'workspace', who: Ana.id, role: 'member' }, h.O.key);
    const gM = h.add({ t: 'grant', group: 'workspace', who: Mal.id, role: 'member' }, h.O.key);
    const nonce = 'cd'.repeat(16);
    const id = spaceIdFor(WS, Ana.id, nonce);
    // Not its maker's ID: refused.
    h.add({ t: 'space', id: 'ef'.repeat(16), audience: [Ana.id], nonce }, Ana.key);
    expect(h.now().spaces.has('ef'.repeat(16))).toBe(false);
    h.add({ t: 'space', id, audience: [Ana.id, h.O.id].sort(), nonce }, Ana.key);
    expect(h.now().spaces.get(id)?.audience).toEqual([Ana.id, h.O.id].sort());
    // Mal "makes" it again as if at the same time, without a nonce, and with one of his own: neither counts.
    h.add({ t: 'space', id, audience: [Mal.id] }, Mal.key, [gM.id]);
    h.add({ t: 'space', id, audience: [Mal.id], nonce: '12'.repeat(16) }, Mal.key, [gM.id]);
    expect(h.now().spaces.get(id)).toEqual({ audience: [Ana.id, h.O.id].sort(), by: Ana.id });
    expect(h.now().mayChangeSpace(Ana.id, id)).toBe(true);
  });
});

describe('links of their own key (0121)', () => {
  const joinOp = (h: ReturnType<typeof history>, link: string, linkKey: Key, signer: Key, o: { role?: 'member' | 'admin' | 'server'; proofFor?: Key } = {}): PolicyOp => {
    const role = o.role ?? 'member';
    const reads = role === 'server' ? 'all' : '';
    return {
      t: 'join', group: 'workspace', role, link, once: true, granter: hex(h.O.key),
      grant: sig(boundGrantMessage(WS, h.genesis.id, link, 'workspace', role, true, 0, hex(h.O.key), hex(linkKey), reads), h.O.key),
      expires: 0, issuer: hex(h.O.key), linkKey: hex(linkKey), linkProof: sig(linkProofMessage(WS, link, hex(o.proofFor ?? signer)), linkKey),
      ...(role === 'server' ? { reads: 'all' as const } : {}),
    };
  };

  it('let in only whoever holds the link: one who has seen its grant cannot join by it with a key of their own', () => {
    const h = history(true);
    const M = h.person();
    h.add({ t: 'grant', group: 'workspace', who: M.id, role: 'member' }, h.O.key);
    const link = 'aaaaaaaaaaaaaaaa';
    const linkKey = crypto.keyPair();
    // The rightful joiner: its proof is for its own key.
    const Bo = h.person();
    h.add({ t: 'admit', link, key: hex(Bo.key) }, M.key);
    h.add(joinOp(h, link, linkKey, Bo.key, { role: 'admin' }), Bo.key);
    expect(h.now().role(Bo.id)).toBe('admin');
    // Someone who saw the join (its grant and Bo's proof) joins with a key of their own: the proof is for Bo's key.
    const Eve = h.person();
    const link2 = 'bbbbbbbbbbbbbbbb';
    const linkKey2 = crypto.keyPair();
    const Cy = h.person();
    h.add({ t: 'admit', link: link2, key: hex(Eve.key) }, M.key);
    h.add(joinOp(h, link2, linkKey2, Eve.key, { proofFor: Cy.key }), Eve.key);
    expect(h.now().role(Eve.id)).toBeNull();
  });

  it('let a server in by its own key, reading what its grant says; reads nothing else there is yet', () => {
    const h = history(true);
    const M = h.person();
    h.add({ t: 'grant', group: 'workspace', who: M.id, role: 'member' }, h.O.key);
    const link = 'cccccccccccccccc';
    const linkKey = crypto.keyPair();
    const S = crypto.keyPair();
    h.add({ t: 'admit', link, key: hex(S) }, M.key);
    h.add(joinOp(h, link, linkKey, S, { role: 'server' }), S);
    expect(h.now().isServer(hex(S))).toBe(true);
    // A join saying a server reads anything but everything is not read at all.
    expect(readOp({ ...joinOp(h, link, linkKey, S, { role: 'server' }), reads: 'some' })).toBeNull();
    expect(readOp({ ...joinOp(h, link, linkKey, S), reads: 'all' })).toBeNull();
  });
});
