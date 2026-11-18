// Subscription links: signed by the device that made them, checked by any member.
import { describe, expect, it } from 'vitest';
import crypto from 'hypercore-crypto';
import { checkLink, decodeLink, encodeLink, type SubscriptionLink } from '../src/peers/identity.js';

const issuer = crypto.keyPair();
const ws = { id: 'ab'.repeat(16), secret: 'cd'.repeat(32), forkedFrom: null };

function make(expires: number, key = issuer): SubscriptionLink {
  const id = '0123456789abcdef';
  const message = Buffer.from(`kuraa-link\0${ws.id}\0${id}\0${expires}\0${key.publicKey.toString('hex')}`);
  return { workspace: ws, issuer: { key: key.publicKey.toString('hex'), name: 'desk' }, id, expires, signature: crypto.sign(message, key.secretKey).toString('hex') };
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
  });
});
