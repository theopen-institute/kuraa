// Invite links: signed by the device that made them, checked by any member.
import { describe, expect, it } from 'vitest';
import crypto from 'hypercore-crypto';
import { checkLink, decodeLink, encodeLink, type InviteLink } from '../src/peers/identity.js';

const issuer = crypto.keyPair();
const ws = { id: 'ab'.repeat(16), secret: 'cd'.repeat(32), forkedFrom: null };

const first = crypto.keyPair();

function make(expires: number, o: { key?: typeof issuer; once?: boolean } = {}): InviteLink {
  const key = o.key ?? issuer;
  const once = o.once ?? false;
  const id = '0123456789abcdef';
  const through = [first.publicKey.toString('hex')];
  const message = Buffer.from(`kuraa-invite\0${ws.id}\0${id}\0${expires}\0${once ? 'once' : 'anyone'}\0${key.publicKey.toString('hex')}\0${through.join(',')}`);
  return { workspace: ws, topic: null, issuer: { key: key.publicKey.toString('hex'), name: 'desk' }, through, id, expires, once, signature: crypto.sign(message, key.secretKey).toString('hex') };
}

/** A link as made since 0050: its own topic, and no secret. */
function makeWithTopic(expires: number): InviteLink {
  const id = 'fedcba9876543210';
  const topic = 'ab'.repeat(32);
  const message = Buffer.from(`kuraa-invite\0${ws.id}\0${id}\0${expires}\0anyone\0${issuer.publicKey.toString('hex')}\0\0${topic}`);
  return { workspace: { id: ws.id, secret: null, forkedFrom: null }, topic, issuer: { key: issuer.publicKey.toString('hex'), name: 'desk' }, through: [], id, expires, once: false, signature: crypto.sign(message, issuer.secretKey).toString('hex') };
}

const ok = { workspace: ws.id, members: [issuer.publicKey.toString('hex')], revoked: [] };

describe('invite links', () => {
  it('survive encoding, for one person or anyone', () => {
    for (const once of [false, true]) {
      const link = make(0, { once });
      expect(decodeLink(encodeLink(link))).toEqual(link);
    }
    expect(encodeLink(make(0))).toMatch(/^kuraa-invite:[A-Za-z0-9_-]+$/);
    // Since 0050: a topic, and not the workspace's secret, which no part of the link says.
    const withTopic = makeWithTopic(0);
    const code = encodeLink(withTopic);
    expect(decodeLink(code)).toEqual(withTopic);
    expect(Buffer.from(code.slice('kuraa-invite:'.length), 'base64url').toString()).not.toContain(ws.secret);
    expect(checkLink(withTopic, ok)).toBeNull();
    // The topic is signed: a link with another is not the one its maker made.
    expect(checkLink({ ...withTopic, topic: 'cd'.repeat(32) }, ok)).toBe('the link is not signed by the device it names');
    expect(() => decodeLink('kuraa-link:abc')).toThrow('Not an invite link');
    expect(() => decodeLink(`kuraa-invite:${Buffer.from('a|b').toString('base64url')}`)).toThrow('damaged');
  });

  it('are good when signed by a member, unexpired, and neither revoked nor used', () => {
    expect(checkLink(make(0), ok)).toBeNull();
    expect(checkLink(make(Date.now() + 60_000), ok)).toBeNull();
    expect(checkLink(make(Date.now() - 1), ok)).toBe('the link has expired');
    expect(checkLink(make(0), { ...ok, revoked: ['0123456789abcdef'] })).toBe('the link was revoked');
    expect(checkLink(make(0, { once: true }), { ...ok, revoked: ['0123456789abcdef'] })).toBe('the link was used, or revoked');
    expect(checkLink(make(0), { ...ok, workspace: 'ef'.repeat(16) })).toBe('the link is for another workspace');
    // Any member's link counts; a stranger's does not.
    const other = crypto.keyPair();
    expect(checkLink(make(0, { key: other }), { ...ok, members: [...ok.members, other.publicKey.toString('hex')] })).toBeNull();
    expect(checkLink(make(0, { key: crypto.keyPair() }), ok)).toBe('the link was made by a device that is not in the workspace');
    // A link whose expiry was changed no longer matches its signature; nor one made for anyone from one for one person.
    expect(checkLink({ ...make(Date.now() - 1), expires: 0 }, ok)).toBe('the link is not signed by the device it names');
    expect(checkLink({ ...make(0, { once: true }), once: false }, ok)).toBe('the link is not signed by the device it names');
    expect(checkLink({ ...make(0), through: [] }, ok)).toBe('the link is not signed by the device it names');
  });

});
