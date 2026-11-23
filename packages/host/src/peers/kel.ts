// A person's identity as a stable ID with keys that change (docs/decisions/0066-permissions-without-a-centre.md).
//
// An identity is a short log of signed events, the same on every device that
// has them, whatever order they arrive in:
//
// - inception: the identity's first key, and the hash of the key that may
//   replace it (its recovery key, kept apart: printed, or in a password
//   manager). The identity's ID is the hash of this event, so it never changes.
// - rotation: reveals the key the event before committed to, names the hash of
//   the next, and lists the signing keys that are still the person's. Signed by
//   the key it reveals, so only whoever holds the recovery key can make one: a
//   stolen identity key cannot. (Pre-rotation, as KERI does it.)
//
// What an identity's key signs (vouching for a computer's signing key, revoking
// one) counts as the identity's while that key is its key; after a rotation,
// what an earlier key vouched for counts only if every later rotation lists it
// (its cutoff: the same on every device, unlike "from when a device hears of
// it"). Two different events at the same place in one identity's log (only a
// leaked recovery key could make that so) leave the identity in dispute, and
// nothing its keys sign counts.
//
// Trustees are gone (0078): a rotation made before may still name some, which
// its signature covers, and says nothing; a trustee rotation (`trot`) is not an
// event any more, refused as any other that is not one.
import { createHash } from 'node:crypto';
import crypto from 'hypercore-crypto';
import type { KeyPair } from '../keys.js';

export interface Inception {
  v: 1;
  t: 'icp';
  /** The identity's first key, hex. */
  key: string;
  /** The hash of the key that may replace it (nextDigest). */
  next: string;
  /** When it was made (ms); 0 for an identity made from a key kept before identities had logs. */
  at: number;
  /** `key`'s signature over the rest, hex. */
  sig: string;
}

export interface Rotation {
  v: 1;
  t: 'rot';
  /** The identity it changes. */
  id: string;
  /** Its place in the log: the inception is 0. */
  seq: number;
  /** The hash of the event before it (eventHash). */
  prior: string;
  /** The key it reveals: the one the event before committed to. From now on, the identity's key. */
  key: string;
  /** The hash of the key that may replace this one. */
  next: string;
  /** The signing keys that are still the person's: what earlier keys vouched for counts only if listed here. Sorted. */
  keep: string[];
  /** Trustees it named, made before 0078: covered by its signature, and saying nothing now. */
  trustees?: { threshold: number; ids: string[] };
  at: number;
  /** `key`'s signature over the rest, hex. */
  sig: string;
}

export type KeyEvent = Inception | Rotation;

const hexKey = /^[0-9a-f]{64}$/;
const hexSig = /^[0-9a-f]{128}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Unsigned = Omit<Inception, 'sig'> | Omit<Rotation, 'sig'>;

function body(e: Unsigned): string {
  if (e.t === 'icp') return ['kuraa-identity', e.v, e.t, e.key, e.next, e.at].join('\0');
  // Trustees where a rotation from before 0078 named them: signed as it was.
  const trustees = e.trustees ? ['trustees', e.trustees.threshold, e.trustees.ids.join(',')] : [];
  return ['kuraa-identity', e.v, e.t, e.id, e.seq, e.prior, e.key, e.next, e.keep.join(','), ...trustees, e.at].join('\0');
}

/** The hash a key is committed to by, before it is revealed. */
export const nextDigest = (key: string) => sha256(`kuraa-next\0${key}`);

/** An event's hash, signature and all: what the event after it names as `prior`. */
export const eventHash = (e: KeyEvent) => sha256(`${body(e)}\0${e.sig}`);

/** An identity's ID: the hash of its inception. */
export const identityId = (icp: Inception) => sha256(`kuraa-identity-id\0${body(icp)}`);

/** The identity an event is of. */
export const eventIdentity = (e: KeyEvent) => (e.t === 'icp' ? identityId(e) : e.id);

const signed = <T extends KeyEvent>(e: Omit<T, 'sig'>, key: KeyPair): T =>
  ({ ...e, sig: crypto.sign(Buffer.from(body(e as Unsigned)), key.secretKey).toString('hex') }) as T;

/** A new identity's first event: `key` is its key, `recovery` the one that may replace it (kept apart). */
export function incept(key: KeyPair, recovery: { publicKey: Buffer }, at = Date.now()): Inception {
  return signed<Inception>({ v: 1, t: 'icp', key: key.publicKey.toString('hex'), next: nextDigest(recovery.publicKey.toString('hex')), at }, key);
}

/**
 * Replace an identity's key with its recovery key (`recovery`, which becomes its
 * key), committing to `nextRecovery`, keeping `keep` as the person's signing
 * keys. Refused if `recovery` is not the key the log's last event committed to.
 */
export function rotate(log: KeyEvent[], recovery: KeyPair, nextRecovery: { publicKey: Buffer }, keep: string[], at = Date.now()): Rotation {
  const state = resolve(log);
  if (!state) throw new Error('Not an identity');
  if (state.disputed) throw new Error('This identity is in dispute: two different changes were made to it');
  const last = state.events[state.events.length - 1]!;
  const key = recovery.publicKey.toString('hex');
  if (nextDigest(key) !== last.next) throw new Error('This is not the recovery key for this identity as it is now');
  const clean = [...new Set(keep)].filter((k) => hexKey.test(k)).sort();
  return signed<Rotation>({ v: 1, t: 'rot', id: state.id, seq: last.t === 'icp' ? 1 : last.seq + 1, prior: eventHash(last), key, next: nextDigest(nextRecovery.publicKey.toString('hex')), keep: clean, at }, recovery);
}

/** An event from elsewhere, checked for shape and signature; null if it is not one. */
export function readEvent(v: unknown): KeyEvent | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (e.v !== 1 || typeof e.key !== 'string' || !hexKey.test(e.key) || typeof e.next !== 'string' || !hexKey.test(e.next)
    || typeof e.at !== 'number' || !Number.isSafeInteger(e.at) || e.at < 0 || typeof e.sig !== 'string' || !hexSig.test(e.sig)) return null;
  let ev: KeyEvent;
  if (e.t === 'icp') ev = { v: 1, t: 'icp', key: e.key, next: e.next, at: e.at, sig: e.sig };
  // A trustee rotation (`trot`, before 0078) is not one any more.
  else if (e.t === 'rot') {
    if (typeof e.id !== 'string' || !hexKey.test(e.id) || typeof e.seq !== 'number' || !Number.isSafeInteger(e.seq) || e.seq < 1
      || typeof e.prior !== 'string' || !hexKey.test(e.prior) || !Array.isArray(e.keep) || e.keep.length > 1000) return null;
    const keep = e.keep as unknown[];
    if (!keep.every((k) => typeof k === 'string' && hexKey.test(k))) return null;
    const sorted = [...new Set(keep as string[])].sort();
    if (sorted.join() !== (keep as string[]).join()) return null;
    let trustees: { threshold: number; ids: string[] } | undefined;
    if (e.trustees !== undefined) {
      const t = e.trustees as { threshold?: unknown; ids?: unknown };
      if (!t || typeof t.threshold !== 'number' || !Array.isArray(t.ids) || t.ids.length > 50 || !t.ids.every((x) => typeof x === 'string' && hexKey.test(x))) return null;
      const ids = [...new Set(t.ids as string[])].sort();
      if (ids.join() !== (t.ids as string[]).join() || !Number.isInteger(t.threshold) || t.threshold < 1 || t.threshold > ids.length) return null;
      trustees = { threshold: t.threshold, ids };
    }
    ev = { v: 1, t: 'rot', id: e.id, seq: e.seq, prior: e.prior, key: e.key, next: e.next, keep: sorted, ...(trustees ? { trustees } : {}), at: e.at, sig: e.sig };
  } else return null;
  const { sig, ...rest } = ev;
  return crypto.verify(Buffer.from(body(rest)), Buffer.from(sig, 'hex'), Buffer.from(ev.key, 'hex')) ? ev : null;
}

export interface IdentityState {
  id: string;
  /** The log, in order, as far as it is known without a gap. */
  events: KeyEvent[];
  /** The identity's key now. */
  current: string;
  /** Two different events at one place: nothing its keys sign counts. */
  disputed: boolean;
}

/**
 * An identity's log from whatever events are known of it (any order, any
 * repeats, others' mixed in): followed from the inception as far as each next
 * event is known. `id`: which identity, if the events are of several; else the
 * one inception among them.
 */
export function resolve(events: KeyEvent[], id?: string): IdentityState | null {
  const icp = events.find((e): e is Inception => e.t === 'icp' && (!id || identityId(e) === id));
  if (!icp) return null;
  const which = identityId(icp);
  const chain: KeyEvent[] = [icp];
  const rotations = events.filter((e): e is Rotation => e.t === 'rot' && e.id === which);
  for (;;) {
    const last = chain[chain.length - 1]!;
    const seq = last.t === 'icp' ? 1 : last.seq + 1;
    const prior = eventHash(last);
    const next = new Map<string, Rotation>();
    for (const r of rotations) if (r.seq === seq && r.prior === prior && nextDigest(r.key) === last.next) next.set(eventHash(r), r);
    if (next.size > 1) return { id: which, events: chain, current: last.key, disputed: true };
    const r = [...next.values()][0];
    if (!r) return { id: which, events: chain, current: last.key, disputed: false };
    chain.push(r);
  }
}

/**
 * Whether what `signer` (one of the identity's keys) vouched for, `subject` (a
 * signing key), counts: the signer is the identity's key now, or an earlier one
 * whose every later rotation lists the subject.
 */
export function vouchCounts(state: IdentityState, signer: string, subject: string): boolean {
  if (state.disputed) return false;
  const at = state.events.findIndex((e) => e.key === signer);
  if (at < 0) return false;
  return state.events.slice(at + 1).every((e) => e.t !== 'icp' && e.keep.includes(subject));
}

/**
 * Whether a revocation of `subject` signed by `signer` counts: by the identity's
 * key now, always; by an earlier key, unless a later rotation lists the subject
 * as still the person's (that rotation is the later word).
 */
export function revocationCounts(state: IdentityState, signer: string, subject: string): boolean {
  if (state.disputed) return false;
  const at = state.events.findIndex((e) => e.key === signer);
  if (at < 0) return false;
  return !state.events.slice(at + 1).some((e) => e.t !== 'icp' && e.keep.includes(subject));
}
