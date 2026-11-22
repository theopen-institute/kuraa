// An identity as a stable ID with keys that change (kel.ts, decision 0066).
import { describe, expect, it } from 'vitest';
import crypto from 'hypercore-crypto';
import { eventHash, identityId, incept, readEvent, resolve, revocationCounts, rotate, vouchCounts } from '../src/peers/kel.js';

const hex = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');

describe('an identity’s log', () => {
  it('keeps one ID while its key changes, from its events in any order', () => {
    const [k0, k1, k2, k3] = [crypto.keyPair(), crypto.keyPair(), crypto.keyPair(), crypto.keyPair()];
    const icp = incept(k0, k1);
    const r1 = rotate([icp], k1, k2, []);
    const r2 = rotate([icp, r1], k2, k3, []);
    const id = identityId(icp);
    for (const order of [[icp, r1, r2], [r2, icp, r1], [r1, r2, icp, r1]]) {
      const s = resolve(order, id)!;
      expect(s.id).toBe(id);
      expect(s.current).toBe(hex(k2));
      expect(s.disputed).toBe(false);
    }
    // Missing a step: as far as it is known.
    expect(resolve([icp, r2], id)!.current).toBe(hex(k0));
    // Every event survives being passed on as JSON; one changed after signing is not an event.
    for (const e of [icp, r1, r2]) expect(readEvent(JSON.parse(JSON.stringify(e)))).toEqual(e);
    expect(readEvent({ ...r1, keep: ['aa'.repeat(32)] })).toBeNull();
    expect(readEvent({ ...icp, next: 'bb'.repeat(32) })).toBeNull();
    expect(eventHash(r1)).not.toBe(eventHash(r2));
  });

  it('is in dispute when its recovery key was used twice: then nothing its keys sign counts', () => {
    const [k0, k1] = [crypto.keyPair(), crypto.keyPair()];
    const icp = incept(k0, k1);
    const signing = 'cc'.repeat(32);
    const one = rotate([icp], k1, crypto.keyPair(), [signing]);
    const two = rotate([icp], k1, crypto.keyPair(), []);
    const s = resolve([icp, one, two])!;
    expect(s.disputed).toBe(true);
    expect(vouchCounts(s, hex(k1), signing)).toBe(false);
    expect(() => rotate([icp, one, two], k1, crypto.keyPair(), [])).toThrow('dispute');
  });

  it('counts an earlier key’s vouch only for keys every later rotation kept, and its revocation unless one did', () => {
    const [k0, k1, k2] = [crypto.keyPair(), crypto.keyPair(), crypto.keyPair()];
    const [a, b] = ['aa'.repeat(32), 'bb'.repeat(32)];
    const icp = incept(k0, k1);
    const s = resolve([icp, rotate([icp], k1, k2, [a])])!;
    expect(vouchCounts(s, hex(k1), b)).toBe(true);
    expect(vouchCounts(s, hex(k0), a)).toBe(true);
    expect(vouchCounts(s, hex(k0), b)).toBe(false);
    expect(vouchCounts(s, hex(k2), b)).toBe(false); // not (yet) one of its keys
    expect(revocationCounts(s, hex(k0), a)).toBe(false);
    expect(revocationCounts(s, hex(k0), b)).toBe(true);
    expect(revocationCounts(s, hex(k1), a)).toBe(true);
  });
});
