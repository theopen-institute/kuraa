// Subscription links: signed by the device that made them, checked by any member.
import { describe, expect, it } from 'vitest';
import crypto from 'hypercore-crypto';
import { checkLink, decodeLink, encodeLink, type SubscriptionLink } from '../src/peers/identity.js';
import { canonicalRules } from '../src/peers/accept.js';
import { signRecord, traced } from '../src/peers/records.js';

const issuer = crypto.keyPair();
const ws = { id: 'ab'.repeat(16), secret: 'cd'.repeat(32), forkedFrom: null };

const first = crypto.keyPair();

function make(expires: number, key = issuer): SubscriptionLink {
  const id = '0123456789abcdef';
  const rules = { rules: [], membership: null };
  const through = [first.publicKey.toString('hex')];
  const message = Buffer.from(`kuraa-link\0${ws.id}\0${id}\0${expires}\0${key.publicKey.toString('hex')}\0${through.join(',')}\0${canonicalRules(rules)}`);
  return { workspace: ws, issuer: { key: key.publicKey.toString('hex'), name: 'desk' }, through, id, expires, signature: crypto.sign(message, key.secretKey).toString('hex'), rules };
}

const ok = { workspace: ws.id, issuers: [issuer.publicKey.toString('hex')], revoked: [] };

describe('subscription links', () => {
  it('survive encoding', () => {
    const link = make(0);
    expect(decodeLink(encodeLink(link))).toEqual(link);
    expect(encodeLink(link)).toMatch(/^kuraa-link:[A-Za-z0-9_-]+$/);
    expect(() => decodeLink('kuraa-invite:abc')).toThrow('Not a subscription link');
    expect(() => decodeLink(`kuraa-link:${Buffer.from('a|b').toString('base64url')}`)).toThrow('damaged');
  });

  it('are good when signed by a device this one takes links from, unexpired and not revoked', () => {
    expect(checkLink(make(0), ok)).toBeNull();
    expect(checkLink(make(Date.now() + 60_000), ok)).toBeNull();
    expect(checkLink(make(Date.now() - 1), ok)).toBe('the link has expired');
    expect(checkLink(make(0), { ...ok, revoked: ['0123456789abcdef'] })).toBe('the link was revoked');
    expect(checkLink(make(0), { ...ok, workspace: 'ef'.repeat(16) })).toBe('the link is for another workspace');
    expect(checkLink(make(0, crypto.keyPair()), ok)).toBe('the link was made by a device this one does not take links from');
    // A link whose expiry was changed no longer matches its signature.
    expect(checkLink({ ...make(Date.now() - 1), expires: 0 }, ok)).toBe('the link is not signed by the device it names');
    // So does one whose rules, or the devices its maker came in through, were changed.
    expect(checkLink({ ...make(0), rules: { rules: [{ branch: 'main', path: '', from: ['ab'.repeat(32)] }], membership: null } }, ok)).toBe('the link is not signed by the device it names');
    expect(checkLink({ ...make(0), through: [] }, ok)).toBe('the link is not signed by the device it names');
  });

  it('let a device joining trace who its maker vouches for: forward through pairings, never back', () => {
    const hex = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');
    const [a, b, c, mallory] = [crypto.keyPair(), crypto.keyPair(), crypto.keyPair(), crypto.keyPair()];
    const add = (by: typeof a, subject: typeof a) => signRecord({ kind: 'add', workspace: ws.id, subject: hex(subject), name: 'x' }, by);
    // The first device paired the issuer and a; a paired b; b paired c, and later removed it.
    const records = [add(first, issuer), add(first, a), add(a, b), add(b, c), signRecord({ kind: 'remove', workspace: ws.id, subject: hex(c) }, b)];
    const known = traced([hex(issuer), hex(first)], records, ws.id);
    expect([hex(first), hex(issuer), hex(a), hex(b)].every((k) => known.has(k))).toBe(true);
    expect(known.has(hex(c))).toBe(false);
    // Mallory, who knows the workspace's secret only, signs that she paired the issuer, and that it paired her: neither counts.
    const forged = [...records, add(mallory, issuer), add(mallory, mallory)];
    expect(traced([hex(issuer), hex(first)], forged, ws.id).has(hex(mallory))).toBe(false);
    // Records of another workspace count for nothing.
    expect(traced([hex(issuer)], [signRecord({ kind: 'add', workspace: 'ef'.repeat(16), subject: hex(mallory) }, issuer)], ws.id).has(hex(mallory))).toBe(false);
  });
});
