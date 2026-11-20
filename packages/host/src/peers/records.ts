// Membership as signed records (docs/decisions/0031-signed-membership.md,
// 0038-equal-peers.md).
//
// Each change to who is in a workspace is a statement signed by the device that
// made it: this device is in (add), this one is out (remove), this link no longer
// lets anyone in (revoke-link). Devices keep the records they take and pass them
// all on, so a change reaches every device through any other, and each can tell
// which device made it, whoever passed it on. Every member's records are taken:
// all members have the same say (0038).
//
// For attribution only, who wrote what: the signing key the commits made on a
// device are signed with (signs, carrying that key's own signature, so no
// device can claim a key it does not hold; the latest of each device counts),
// this key is a person's (vouch: with their identity's signature and the key's
// own), and this one no longer is (revoke-key, with their identity's
// signature; 0035). Any member may pass these on.
//
// The git config this layer has always used (remotes, kuraa.removed,
// kuraa.revokedlinks) stays: it is what the records taken say, applied.
import crypto from 'hypercore-crypto';

export type RecordKind = 'add' | 'remove' | 'revoke-link' | 'signs' | 'vouch' | 'revoke-key';

export interface MemberRecord {
  v: 1;
  kind: RecordKind;
  /** The workspace it is about (a record of one workspace means nothing in another, or in a fork). */
  workspace: string;
  /** add, remove: a device key. revoke-link: a link id. signs, vouch, revoke-key: a signing key. */
  subject: string;
  /** add: what the device is called. vouch: what the person is called. revoke-link: 'used', for a link for one person that let them in. */
  name?: string;
  /** vouch, revoke-key: the person's identity key. */
  person?: string;
  /** signs: the signing key's signature (signsMessage); vouch, revoke-key: the person's (vouchMessage, revokeKeyMessage). Hex. */
  proof?: string;
  /** vouch: the signing key's own signature over the same (vouchMessage). Hex. */
  keyProof?: string;
  /** The device that made it, hex key. */
  by: string;
  /** When (ms), as the device that made it says: which key a device last said it signs with, and a person's latest name. */
  at: number;
  /** `by`'s signature over the rest, hex. */
  sig: string;
}

const hexKey = /^[0-9a-f]{64}$/;

function message(r: Omit<MemberRecord, 'sig'>): Buffer {
  return Buffer.from(['kuraa-record', r.v, r.kind, r.workspace, r.subject, r.name ?? '', r.by, r.at, r.proof ?? '', r.person ?? '', r.keyProof ?? ''].join('\0'));
}

/** What a signing key signs to say a device signs with it. */
export const signsMessage = (device: string) => Buffer.from(`kuraa-signs\0${device}`);
/** What a person's identity and a signing key both sign to say the key is theirs (in every workspace). */
export const vouchMessage = (key: string, person: string, name: string) => Buffer.from(`kuraa-vouch\0${key}\0${person}\0${name}`);
/** What a person's identity signs to say a signing key is no longer theirs. */
export const revokeKeyMessage = (key: string) => Buffer.from(`kuraa-revoke-key\0${key}`);

export const sign = (message: Buffer, key: { secretKey: Buffer }) => crypto.sign(message, key.secretKey).toString('hex');

/** Whether a record is one a device makes about itself (signs): the latest of each device counts. */
export const aboutItself = (k: RecordKind) => k === 'signs';

/** Whether a record is one a person makes, with their identity's signature (vouch, revoke-key): any member may pass it on. */
export const byPerson = (k: RecordKind) => k === 'vouch' || k === 'revoke-key';

export function signRecord(r: Omit<MemberRecord, 'v' | 'sig' | 'by' | 'at'> & { at?: number }, key: { publicKey: Buffer; secretKey: Buffer }): MemberRecord {
  const body = { v: 1 as const, ...r, by: key.publicKey.toString('hex'), at: r.at ?? Date.now() };
  return { ...body, sig: crypto.sign(message(body), key.secretKey).toString('hex') };
}

/** A record from another device, checked for shape and signature; null if it is not one. */
export function readRecord(v: unknown): MemberRecord | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  const kinds: RecordKind[] = ['add', 'remove', 'revoke-link', 'signs', 'vouch', 'revoke-key'];
  if (r.v !== 1 || !kinds.includes(r.kind as RecordKind) || typeof r.workspace !== 'string' || typeof r.subject !== 'string'
    || typeof r.by !== 'string' || !hexKey.test(r.by) || typeof r.at !== 'number' || typeof r.sig !== 'string' || !/^[0-9a-f]{128}$/.test(r.sig)) return null;
  if (r.name !== undefined && typeof r.name !== 'string') return null;
  if (r.proof !== undefined && (typeof r.proof !== 'string' || !/^[0-9a-f]{128}$/.test(r.proof))) return null;
  if (r.person !== undefined && (typeof r.person !== 'string' || !hexKey.test(r.person))) return null;
  if (r.keyProof !== undefined && (typeof r.keyProof !== 'string' || !/^[0-9a-f]{128}$/.test(r.keyProof))) return null;
  const kind = r.kind as RecordKind;
  if (kind !== 'revoke-link' && !hexKey.test(r.subject)) return null;
  if (kind === 'revoke-link' && !/^[0-9a-f]{16}$/.test(r.subject)) return null;
  if ((kind === 'signs' || byPerson(kind)) && typeof r.proof !== 'string') return null;
  if (byPerson(kind) && typeof r.person !== 'string') return null;
  if (kind === 'vouch' && (typeof r.name !== 'string' || typeof r.keyProof !== 'string')) return null;
  const rec: MemberRecord = {
    v: 1, kind, workspace: r.workspace, subject: r.subject, by: r.by, at: r.at, sig: r.sig,
    ...(r.name !== undefined ? { name: r.name as string } : {}),
    ...(r.proof !== undefined ? { proof: r.proof as string } : {}),
    ...(r.person !== undefined ? { person: r.person as string } : {}),
    ...(r.keyProof !== undefined ? { keyProof: r.keyProof as string } : {}),
  };
  const { sig, ...body } = rec;
  if (!crypto.verify(message(body), Buffer.from(sig, 'hex'), Buffer.from(rec.by, 'hex'))) return null;
  // Each says what only the key it is about could say.
  const proven = (message: Buffer, key: string, proof = rec.proof!) => crypto.verify(message, Buffer.from(proof, 'hex'), Buffer.from(key, 'hex'));
  if (kind === 'signs' && !proven(signsMessage(rec.by), rec.subject)) return null;
  if (kind === 'vouch') {
    const m = vouchMessage(rec.subject, rec.person!, rec.name!);
    if (!proven(m, rec.person!) || !proven(m, rec.subject, rec.keyProof)) return null;
  }
  if (kind === 'revoke-key' && !proven(revokeKeyMessage(rec.subject), rec.person!)) return null;
  return rec;
}

/** What a device knows when it judges a record. */
export interface Standing {
  workspace: string;
  /** This device's key. */
  self: string;
  /** Devices it is paired with. */
  members: Set<string>;
  removed: Set<string>;
}

/**
 * Whether to take a record now: 'take' (any member's), 'wait' (its signer is
 * not paired here yet; it comes again with the next hello), or 'refuse' (another
 * workspace's, or a removed device's).
 */
export function judge(r: MemberRecord, s: Standing): 'take' | 'wait' | 'refuse' {
  if (r.workspace !== s.workspace) return 'refuse';
  if (r.by === s.self) return 'take';
  if (s.removed.has(r.by)) return 'refuse';
  return s.members.has(r.by) ? 'take' : 'wait';
}

/**
 * The devices that records show to be in a workspace, as far as `from` (devices
 * already trusted: a link's maker, and those it came in through) vouch for them:
 * those they paired (add), those those paired, and so on, each record signed by
 * a device already counted; less those a counted device removed. A record a
 * device signs about how it came in counts for nothing: anyone may sign one.
 */
export function traced(from: string[], list: unknown[], workspace: string): Set<string> {
  const records = list.map(readRecord).filter((r): r is MemberRecord => !!r && r.workspace === workspace);
  const known = new Set(from);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of records) {
      if (r.kind === 'add' && known.has(r.by) && !known.has(r.subject)) {
        known.add(r.subject);
        grew = true;
      }
    }
  }
  for (const r of records) if (r.kind === 'remove' && known.has(r.by)) known.delete(r.subject);
  return known;
}
