// Signed records (docs/decisions/0031-signed-membership.md, 0072).
//
// What devices tell each other about the workspace, each signed by the device
// that made it, kept, and passed on, so it reaches every device through any
// other. Which devices are in is not said by any record of its own (0072): a
// device is in where it signs with a key (signs) a person vouched for (vouch),
// and the policy has that person in the workspace, the key not dropped or
// revoked. Records signed in themselves by people's and keys' own signatures
// (key-event, vouch, revoke-key, signs, policy) are taken whoever made or
// passed them on; the rest (link, revoke-link, secret) only from a device in. From
// a device not known to be in, only those about it, and only if they show it is
// in (Identity.proven): nothing else a stranger sends is kept, or passed on.
// Pairing records from before (add) are kept but say nothing; removals from
// before (remove) still count, and none is made. An acknowledgement (ack) says
// how much of the policy a device holds: removals it holds are confirmed, in
// the app's words, by its person; it decides nothing.
//
// For attribution only, who wrote what: the signing key the commits made on a
// device are signed with (signs, carrying that key's own signature, so no
// device can claim a key it does not hold; the latest of each device counts),
// this key is a person's (vouch: with their identity's signature and the key's
// own), and this one no longer is (revoke-key, with their identity's
// signature; 0035). Any member may pass these on. A person is their identity's
// ID, whose key may change (0066, kel.ts): its events travel as records too
// (key-event), and a vouch or revocation names which of its keys signed it.
//
// Finding each other (0050): an invite link a member made, and the topic its
// holders look the workspace up by (link: no secret in it, so a link revoked or
// expired says nothing of where the devices are), which every member announces
// while the link lets people in; and the workspace's secret, made anew (secret)
// when a device is removed, so the removed device can no longer find the
// others. The latest secret counts. Never passed to a removed device.
//
// Attestations (attest: email checks by a verifier) are no longer taken since
// 0078: one from an older device is refused, as any record of no known kind.
//
// The git config this layer has always used (remotes, kuraa.removed,
// kuraa.revokedlinks) stays: it is what the records taken say, applied.
import { createHash } from 'node:crypto';
import crypto from 'hypercore-crypto';
import { eventHash, eventIdentity, readEvent, type KeyEvent } from './kel.js';
import { entrySigned, readOp, type PolicyEntry, type PolicyOp } from './policy.js';

export type RecordKind = 'add' | 'remove' | 'revoke-link' | 'signs' | 'vouch' | 'revoke-key' | 'link' | 'secret' | 'key-event' | 'policy' | 'ack';

export interface MemberRecord {
  v: 1;
  kind: RecordKind;
  /** The workspace it is about (a record of one workspace means nothing in another, or in a fork). */
  workspace: string;
  /** add, remove: a device key. revoke-link, link: a link id. signs, vouch, revoke-key: a signing key. secret: the workspace's secret. key-event: the identity's ID. policy: the operation's hash. */
  subject: string;
  /** add: what the device is called. vouch: what the person is called. revoke-link: 'used', for a link for one person that let them in. */
  name?: string;
  /** vouch, revoke-key: the person's identity (its ID). */
  person?: string;
  /** vouch, revoke-key: which of the identity's keys signed (`proof`). */
  personKey?: string;
  /** key-event: one event of the identity's log (kel.ts), as it was signed. */
  event?: KeyEvent;
  /** revoke-key: the commits (branch tips) its maker's device had when it said so: what the key signed among them still counts (its cutoff, 0066). */
  heads?: string[];
  /** revoke-key: the policy operations its maker's device had: those the key signed among them still count (0072). ack: the policy operations its maker's device holds (all they descend from too). */
  policyHeads?: string[];
  /** policy: the operation (policy.ts), the operations its maker had seen, and the signing key that signed it (`proof`). */
  op?: PolicyOp;
  parents?: string[];
  signer?: string;
  /** signs: the signing key's signature (signsMessage); vouch, revoke-key: the person's (vouchMessage, revokeKeyMessage). Hex. */
  proof?: string;
  /** vouch: the signing key's own signature over the same (vouchMessage). Hex. */
  keyProof?: string;
  /** link: the topic the link's holders look the workspace up by, hex. */
  topic?: string;
  /** link: when it stops letting people in (ms since 1970); 0: never. */
  expires?: number;
  /** The device that made it, hex key. */
  by: string;
  /** When (ms), as the device that made it says: which key a device last said it signs with, and a person's latest name. */
  at: number;
  /** `by`'s signature over the rest, hex. */
  sig: string;
}

const hexKey = /^[0-9a-f]{64}$/;

function message(r: Omit<MemberRecord, 'sig'>): Buffer {
  // A link's topic and expiry only where there are any: records made before them are signed as they were.
  const link = r.topic !== undefined ? [r.topic, r.expires ?? 0] : [];
  // Likewise the identity's key, and an event (by its hash: the event is signed in itself).
  const person = r.personKey !== undefined ? ['personKey', r.personKey] : [];
  const event = r.event !== undefined ? ['event', eventHash(r.event)] : [];
  // A policy operation is signed in itself, and named by its hash (the subject), which covers it.
  const policy = r.signer !== undefined ? ['signer', r.signer] : [];
  const heads = r.heads !== undefined ? ['heads', r.heads.join(',')] : [];
  const policyHeads = r.policyHeads !== undefined ? ['policyHeads', r.policyHeads.join(',')] : [];
  return Buffer.from(['kuraa-record', r.v, r.kind, r.workspace, r.subject, r.name ?? '', r.by, r.at, r.proof ?? '', r.person ?? '', r.keyProof ?? '', ...link, ...person, ...event, ...policy, ...heads, ...policyHeads].join('\0'));
}

/** What a signing key signs to say a device signs with it. */
export const signsMessage = (device: string) => Buffer.from(`kuraa-signs\0${device}`);
/** What a person's identity (its key, for its ID) and a signing key both sign to say the key is theirs (in every workspace). */
export const vouchMessage = (key: string, person: string, name: string) => Buffer.from(`kuraa-vouch\0${key}\0${person}\0${name}`);
/** What a person's identity signs to say a signing key is no longer theirs. */
export const revokeKeyMessage = (key: string) => Buffer.from(`kuraa-revoke-key\0${key}`);

export const sign = (message: Buffer, key: { secretKey: Buffer }) => crypto.sign(message, key.secretKey).toString('hex');

/** Whether a record is one a device makes about itself (signs; ack, 0072): the latest of each device counts. */
export const aboutItself = (k: RecordKind) => k === 'signs' || k === 'ack';

/** Whether a record is one a person makes, with their identity's signature (vouch, revoke-key): any member may pass it on. */
export const byPerson = (k: RecordKind) => k === 'vouch' || k === 'revoke-key';

/** A policy record's operation, as policy.ts takes it. */
export const policyEntry = (r: MemberRecord): PolicyEntry => ({ id: r.subject, op: r.op!, parents: r.parents!, signer: r.signer!, proof: r.proof! });

export function signRecord(r: Omit<MemberRecord, 'v' | 'sig' | 'by' | 'at'> & { at?: number }, key: { publicKey: Buffer; secretKey: Buffer }): MemberRecord {
  const body = { v: 1 as const, ...r, by: key.publicKey.toString('hex'), at: r.at ?? Date.now() };
  return { ...body, sig: crypto.sign(message(body), key.secretKey).toString('hex') };
}

/**
 * What a record says, as a key two devices compare (0071): what is kept once,
 * whoever passed it on (a person's event, a policy operation),
 * by that; anything else by its signature. Two devices holding the same event
 * passed on by different devices hold the same records, as far as asking for
 * what is missing goes (node.ts, digestOf), and do not ask each other for ever.
 */
export function recordKey(r: MemberRecord): string {
  if (r.kind === 'key-event' && r.event) return `e:${eventHash(r.event)}`;
  if (r.kind === 'policy') return `p:${r.subject}`;
  return `s:${r.sig}`;
}

/** A record's key, short (node.ts, want): 64 bits of its hash. */
export const shortKey = (r: MemberRecord) => createHash('sha256').update(recordKey(r)).digest('hex').slice(0, 16);

/**
 * How far ahead of this device's clock a record may say it was made (0071):
 * further, and it waits until it is no longer ahead. The latest of some records
 * counts (the secret, which key a device signs with, a person's name), so one
 * dated years ahead would count for good.
 */
export const FUTURE_MS = 10 * 60_000;

/** A record from another device, checked for shape and signature; null if it is not one. */
export function readRecord(v: unknown): MemberRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  // Attestations (`attest`) are no longer taken (0078): refused, as any kind not known.
  const kinds: RecordKind[] = ['add', 'remove', 'revoke-link', 'signs', 'vouch', 'revoke-key', 'link', 'secret', 'key-event', 'policy', 'ack'];
  if (r.v !== 1 || !kinds.includes(r.kind as RecordKind) || typeof r.workspace !== 'string' || typeof r.subject !== 'string'
    || typeof r.by !== 'string' || !hexKey.test(r.by) || typeof r.at !== 'number' || typeof r.sig !== 'string' || !/^[0-9a-f]{128}$/.test(r.sig)) return null;
  if (r.name !== undefined && typeof r.name !== 'string') return null;
  if (r.proof !== undefined && (typeof r.proof !== 'string' || !/^[0-9a-f]{128}$/.test(r.proof))) return null;
  if (r.person !== undefined && (typeof r.person !== 'string' || !hexKey.test(r.person))) return null;
  if (r.keyProof !== undefined && (typeof r.keyProof !== 'string' || !/^[0-9a-f]{128}$/.test(r.keyProof))) return null;
  const kind = r.kind as RecordKind;
  if (r.personKey !== undefined && (!byPerson(kind) || typeof r.personKey !== 'string' || !hexKey.test(r.personKey))) return null;
  // A person's records name the key that signed them (0066); those from before identities had logs do not, and count for nothing.
  if (byPerson(kind) && r.personKey === undefined) return null;
  const event = r.event !== undefined ? readEvent(r.event) : null;
  if ((kind === 'key-event') !== (event !== null) || (r.event !== undefined && !event)) return null;
  if (event && eventIdentity(event) !== r.subject) return null;
  const op = r.op !== undefined ? readOp(r.op) : null;
  if ((kind === 'policy') !== (op !== null) || (r.op !== undefined && !op)) return null;
  if (op && (!Array.isArray(r.parents) || !r.parents.every((p) => typeof p === 'string') || typeof r.signer !== 'string' || typeof r.proof !== 'string')) return null;
  if (!op && (r.parents !== undefined || r.signer !== undefined)) return null;
  if (r.attestation !== undefined) return null;
  if (r.heads !== undefined && (kind !== 'revoke-key' || !Array.isArray(r.heads) || r.heads.length > 1000 || !r.heads.every((h) => typeof h === 'string' && /^[0-9a-f]{40,64}$/.test(h)))) return null;
  if (kind === 'ack' && r.policyHeads === undefined) return null;
  if (r.policyHeads !== undefined && ((kind !== 'revoke-key' && kind !== 'ack') || !Array.isArray(r.policyHeads) || r.policyHeads.length > 1000 || !r.policyHeads.every((h) => typeof h === 'string' && hexKey.test(h)))) return null;
  const aboutLink = kind === 'revoke-link' || kind === 'link';
  if (!aboutLink && !hexKey.test(r.subject)) return null;
  if (aboutLink && !/^[0-9a-f]{16}$/.test(r.subject)) return null;
  if (r.topic !== undefined && (kind !== 'link' || typeof r.topic !== 'string' || !hexKey.test(r.topic))) return null;
  if (r.expires !== undefined && (kind !== 'link' || typeof r.expires !== 'number' || !Number.isSafeInteger(r.expires) || r.expires < 0)) return null;
  if (kind === 'link' && r.topic === undefined) return null;
  if ((kind === 'signs' || byPerson(kind)) && typeof r.proof !== 'string') return null;
  if (byPerson(kind) && typeof r.person !== 'string') return null;
  if (kind === 'vouch' && (typeof r.name !== 'string' || typeof r.keyProof !== 'string')) return null;
  const rec: MemberRecord = {
    v: 1, kind, workspace: r.workspace, subject: r.subject, by: r.by, at: r.at, sig: r.sig,
    ...(r.name !== undefined ? { name: r.name as string } : {}),
    ...(r.proof !== undefined ? { proof: r.proof as string } : {}),
    ...(r.person !== undefined ? { person: r.person as string } : {}),
    ...(r.personKey !== undefined ? { personKey: r.personKey as string } : {}),
    ...(event ? { event } : {}),
    ...(op ? { op, parents: r.parents as string[], signer: r.signer as string } : {}),
    ...(r.heads !== undefined ? { heads: r.heads as string[] } : {}),
    ...(r.policyHeads !== undefined ? { policyHeads: r.policyHeads as string[] } : {}),
    ...(r.keyProof !== undefined ? { keyProof: r.keyProof as string } : {}),
    ...(r.topic !== undefined ? { topic: r.topic as string, expires: (r.expires as number | undefined) ?? 0 } : {}),
  };
  const { sig, ...body } = rec;
  if (!crypto.verify(message(body), Buffer.from(sig, 'hex'), Buffer.from(rec.by, 'hex'))) return null;
  // Each says what only the key it is about could say.
  const proven = (message: Buffer, key: string, proof = rec.proof!) => crypto.verify(message, Buffer.from(proof, 'hex'), Buffer.from(key, 'hex'));
  if (kind === 'signs' && !proven(signsMessage(rec.by), rec.subject)) return null;
  // Whether the key that signed is the identity's (and counts) is for whoever reads the records with the identity's log (identity.ts).
  if (kind === 'vouch') {
    const m = vouchMessage(rec.subject, rec.person!, rec.name!);
    if (!proven(m, rec.personKey!) || !proven(m, rec.subject, rec.keyProof)) return null;
  }
  if (kind === 'revoke-key' && !proven(revokeKeyMessage(rec.subject), rec.personKey!)) return null;
  if (kind === 'policy' && !entrySigned(rec.workspace, policyEntry(rec))) return null;
  return rec;
}

/** What a device knows when it judges a record. */
export interface Standing {
  workspace: string;
  /** This device's key. */
  self: string;
  /** Devices in the workspace (0072: as people, their keys and the policy say). */
  members: Set<string>;
  /** Devices out: dropped, their key revoked, their person taken out; or removed before (0072). */
  removed: Set<string>;
  /** Devices whose person is an admin of the workspace (policy.ts); null: no policy yet, every member's word counts (0038). */
  managers: Set<string> | null;
  /** The person each device is (as its signing key's vouch says), where known: a person removes their own computers (0068). */
  persons?: Map<string, string>;
  /** Devices whose person is an admin; and those whose person makes and unmakes admins (the owner): only they remove an admin's computer (0070). */
  adminDevices?: Set<string>;
  assigners?: Set<string>;
  /** Now, as this device's clock says (ms). */
  now?: number;
}

/** Records from before that only an admin's device may have made (0066), or, for a device, one of the same person's (0068): removing a device. */
export const forAdmins = (k: RecordKind) => k === 'remove';

/** Records whose word is in their own signatures, by people and keys, not in the device that made them (0072): taken from whoever passes them on. */
export const selfProven = (k: RecordKind) => k === 'key-event' || k === 'vouch' || k === 'revoke-key' || k === 'signs' || k === 'policy';

/**
 * Whether to take a record now: 'take', 'wait' (its maker is not known to be in
 * yet, or what lets it make it has not come; it comes again with the next
 * hello), or 'refuse' (another workspace's, or an out device's).
 */
export function judge(r: MemberRecord, s: Standing): 'take' | 'wait' | 'refuse' {
  if (r.workspace !== s.workspace) return 'refuse';
  if (r.by === s.self) return 'take';
  if (s.removed.has(r.by)) return 'refuse';
  if (r.at > (s.now ?? Date.now()) + FUTURE_MS) return 'wait';
  // A revocation's cutoff (the commits that still count) is said by a device of the person revoking (0071): no
  // one else may wrap their signature with commits of their own choosing.
  if (r.kind === 'revoke-key') return s.persons?.get(r.by) === r.person ? 'take' : 'wait';
  if (selfProven(r.kind)) return 'take';
  if (!s.members.has(r.by)) return 'wait';
  // A removal from before: an admin's, or the same person's as the device it removes; for an admin's, the owner's.
  if (forAdmins(r.kind) && s.managers) {
    const whose = s.persons?.get(r.by);
    const own = !!whose && whose === s.persons?.get(r.subject);
    const ofAdmin = !!s.adminDevices?.has(r.subject);
    const may = own || (s.managers.has(r.by) && (!ofAdmin || !!s.assigners?.has(r.by)));
    if (!may) return 'wait';
  }
  return 'take';
}
