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
// Trustees (step 6): a rotation (so, the recovery key) may name trustees, "any
// 2 of these 3 people" (identities); then, with both its keys lost, the
// identity's key may be replaced by a trustee rotation, signed by its new key
// and by as many trustees as the threshold, each with their identity's key now.
// It competes with an ordinary rotation at the same place like any other.
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
  /** The trustees from now on, if it names them (else as before). */
  trustees?: Trustees;
  at: number;
  /** `key`'s signature over the rest, hex. */
  sig: string;
}

/** Who may, together, replace an identity's key when both its keys are lost: identities, and how many of them it takes. */
export interface Trustees {
  threshold: number;
  /** Identity IDs, sorted. */
  ids: string[];
}

/** A trustee's signature on a trustee rotation: their identity, and its key that signed. */
export interface TrusteeVouch { id: string; key: string; sig: string }

/** A rotation the identity's trustees made (as many as its threshold), not its recovery key: the key it names is new. */
export interface TrusteeRotation {
  v: 1;
  t: 'trot';
  id: string;
  seq: number;
  prior: string;
  key: string;
  next: string;
  keep: string[];
  trustees?: Trustees;
  at: number;
  /** `key`'s signature over the rest (but the vouches). */
  sig: string;
  /** The trustees' signatures over the same. */
  vouches: TrusteeVouch[];
}

export type KeyEvent = Inception | Rotation | TrusteeRotation;

const hexKey = /^[0-9a-f]{64}$/;
const hexSig = /^[0-9a-f]{128}$/;
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

type Unsigned = Omit<Inception, 'sig'> | Omit<Rotation, 'sig'> | Omit<TrusteeRotation, 'sig' | 'vouches'>;

function body(e: Unsigned): string {
  if (e.t === 'icp') return ['kuraa-identity', e.v, e.t, e.key, e.next, e.at].join('\0');
  // Trustees only where named: rotations from before them are signed as they were.
  const trustees = e.trustees ? ['trustees', e.trustees.threshold, e.trustees.ids.join(',')] : [];
  return ['kuraa-identity', e.v, e.t, e.id, e.seq, e.prior, e.key, e.next, e.keep.join(','), ...trustees, e.at].join('\0');
}

/** What trustees (and the new key) sign to make a trustee rotation. */
export const trusteeMessage = (e: Omit<TrusteeRotation, 'sig' | 'vouches'>) => Buffer.from(body(e));

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
export function rotate(log: KeyEvent[], recovery: KeyPair, nextRecovery: { publicKey: Buffer }, keep: string[], at = Date.now(), trustees?: Trustees): Rotation {
  const state = resolve(log);
  if (!state) throw new Error('Not an identity');
  if (state.disputed) throw new Error('This identity is in dispute: two different changes were made to it');
  const last = state.events[state.events.length - 1]!;
  const key = recovery.publicKey.toString('hex');
  if (nextDigest(key) !== last.next) throw new Error('This is not the recovery key for this identity as it is now');
  const clean = [...new Set(keep)].filter((k) => hexKey.test(k)).sort();
  return signed<Rotation>({ v: 1, t: 'rot', id: state.id, seq: last.t === 'icp' ? 1 : last.seq + 1, prior: eventHash(last), key, next: nextDigest(nextRecovery.publicKey.toString('hex')), keep: clean, ...(trustees ? { trustees: cleanTrustees(trustees) } : {}), at }, recovery);
}

function cleanTrustees(t: Trustees): Trustees {
  const ids = [...new Set(t.ids)].filter((x) => hexKey.test(x)).sort();
  if (!ids.length || !Number.isInteger(t.threshold) || t.threshold < 1 || t.threshold > ids.length) throw new Error('Trustees are some people, and how many of them it takes (at least one, at most all)');
  return { threshold: t.threshold, ids };
}

/**
 * What a trustee rotation will say (for the trustees to sign, trusteeMessage):
 * the identity's next place in its log, a new key (`key`), committing to
 * `nextRecovery`, keeping `keep`.
 */
export function trusteeRequest(log: KeyEvent[], key: { publicKey: Buffer }, nextRecovery: { publicKey: Buffer }, keep: string[], at = Date.now()): Omit<TrusteeRotation, 'sig' | 'vouches'> {
  const state = resolve(log, undefined, { trustTrots: true });
  if (!state) throw new Error('Not an identity');
  if (state.disputed) throw new Error('This identity is in dispute: two different changes were made to it');
  if (!state.trustees) throw new Error('This identity has no trustees');
  const last = state.events[state.events.length - 1]!;
  return { v: 1, t: 'trot', id: state.id, seq: last.t === 'icp' ? 1 : last.seq + 1, prior: eventHash(last), key: key.publicKey.toString('hex'), next: nextDigest(nextRecovery.publicKey.toString('hex')), keep: [...new Set(keep)].filter((k) => hexKey.test(k)).sort(), at };
}

/** A trustee's signature on a request (as one of the identity's trustees, with their identity's key). */
export function vouchFor(request: Omit<TrusteeRotation, 'sig' | 'vouches'>, trustee: string, key: KeyPair): TrusteeVouch {
  return { id: trustee, key: key.publicKey.toString('hex'), sig: crypto.sign(trusteeMessage(request), key.secretKey).toString('hex') };
}

/** The trustee rotation, signed by its new key, with the trustees' signatures. */
export function trusteeRotation(request: Omit<TrusteeRotation, 'sig' | 'vouches'>, key: KeyPair, vouches: TrusteeVouch[]): TrusteeRotation {
  const sig = crypto.sign(trusteeMessage(request), key.secretKey).toString('hex');
  const seen = new Set<string>();
  return { ...request, sig, vouches: vouches.filter((v) => !seen.has(v.id) && seen.add(v.id)).sort((a, b) => (a.id < b.id ? -1 : 1)) };
}

/** An event from elsewhere, checked for shape and signature; null if it is not one. */
export function readEvent(v: unknown): KeyEvent | null {
  if (!v || typeof v !== 'object') return null;
  const e = v as Record<string, unknown>;
  if (e.v !== 1 || typeof e.key !== 'string' || !hexKey.test(e.key) || typeof e.next !== 'string' || !hexKey.test(e.next)
    || typeof e.at !== 'number' || !Number.isSafeInteger(e.at) || e.at < 0 || typeof e.sig !== 'string' || !hexSig.test(e.sig)) return null;
  let ev: KeyEvent;
  if (e.t === 'icp') ev = { v: 1, t: 'icp', key: e.key, next: e.next, at: e.at, sig: e.sig };
  else if (e.t === 'rot' || e.t === 'trot') {
    if (typeof e.id !== 'string' || !hexKey.test(e.id) || typeof e.seq !== 'number' || !Number.isSafeInteger(e.seq) || e.seq < 1
      || typeof e.prior !== 'string' || !hexKey.test(e.prior) || !Array.isArray(e.keep) || e.keep.length > 1000) return null;
    const keep = e.keep as unknown[];
    if (!keep.every((k) => typeof k === 'string' && hexKey.test(k))) return null;
    const sorted = [...new Set(keep as string[])].sort();
    if (sorted.join() !== (keep as string[]).join()) return null;
    let trustees: Trustees | undefined;
    if (e.trustees !== undefined) {
      const t = e.trustees as { threshold?: unknown; ids?: unknown };
      if (!t || typeof t.threshold !== 'number' || !Array.isArray(t.ids) || t.ids.length > 50 || !t.ids.every((x) => typeof x === 'string' && hexKey.test(x))) return null;
      const ids = [...new Set(t.ids as string[])].sort();
      if (ids.join() !== (t.ids as string[]).join() || !Number.isInteger(t.threshold) || t.threshold < 1 || t.threshold > ids.length) return null;
      trustees = { threshold: t.threshold, ids };
    }
    const common = { v: 1 as const, id: e.id, seq: e.seq, prior: e.prior, key: e.key, next: e.next, keep: sorted, ...(trustees ? { trustees } : {}), at: e.at, sig: e.sig };
    if (e.t === 'rot') ev = { ...common, t: 'rot' };
    else {
      if (!Array.isArray(e.vouches) || e.vouches.length > 50) return null;
      const vouches: TrusteeVouch[] = [];
      for (const v of e.vouches as Record<string, unknown>[]) {
        if (!v || typeof v.id !== 'string' || !hexKey.test(v.id) || typeof v.key !== 'string' || !hexKey.test(v.key) || typeof v.sig !== 'string' || !hexSig.test(v.sig)) return null;
        vouches.push({ id: v.id, key: v.key, sig: v.sig });
      }
      ev = { ...common, t: 'trot', vouches };
      // Each trustee's signature is theirs (whether the key is their identity's is for resolve, with their log).
      const m = trusteeMessage({ ...common, t: 'trot' });
      if (!vouches.every((v) => crypto.verify(m, Buffer.from(v.sig, 'hex'), Buffer.from(v.key, 'hex')))) return null;
    }
  } else return null;
  const { sig, ...rest } = ev;
  const unsigned = ev.t === 'trot' ? (({ vouches: _v, ...r }) => r)(rest as Omit<TrusteeRotation, 'sig'>) : rest;
  return crypto.verify(Buffer.from(body(unsigned as Unsigned)), Buffer.from(sig, 'hex'), Buffer.from(ev.key, 'hex')) ? ev : null;
}

export interface IdentityState {
  id: string;
  /** The log, in order, as far as it is known without a gap. */
  events: KeyEvent[];
  /** The identity's key now. */
  current: string;
  /** Two different events at one place: nothing its keys sign counts. */
  disputed: boolean;
  /** Its trustees now, if it named any. */
  trustees: Trustees | null;
}

export interface ResolveOptions {
  /** A trustee's identity's key now (from their log, where it is known): what their signature on a trustee rotation must be by. */
  trusteeKey?: (id: string) => string | null;
  /** Take trustee rotations as they are (the person's own copy of their log, on their own computer). */
  trustTrots?: boolean;
}

/**
 * An identity's log from whatever events are known of it (any order, any
 * repeats, others' mixed in): followed from the inception as far as each next
 * event is known. `id`: which identity, if the events are of several; else the
 * one inception among them.
 */
export function resolve(events: KeyEvent[], id?: string, opts: ResolveOptions = {}): IdentityState | null {
  const icp = events.find((e): e is Inception => e.t === 'icp' && (!id || identityId(e) === id));
  if (!icp) return null;
  const which = identityId(icp);
  const chain: KeyEvent[] = [icp];
  const rotations = events.filter((e): e is Rotation | TrusteeRotation => e.t !== 'icp' && e.id === which);
  let trustees: Trustees | null = null;
  // A trustee rotation counts with as many signatures as the threshold, each by a trustee's identity's key now.
  const enough = (r: TrusteeRotation) => {
    if (opts.trustTrots) return true;
    if (!trustees || !opts.trusteeKey) return false;
    const by = new Set(r.vouches.filter((v) => trustees!.ids.includes(v.id) && opts.trusteeKey!(v.id) === v.key).map((v) => v.id));
    return by.size >= trustees.threshold;
  };
  for (;;) {
    const last = chain[chain.length - 1]!;
    const seq = last.t === 'icp' ? 1 : last.seq + 1;
    const prior = eventHash(last);
    const next = new Map<string, Rotation | TrusteeRotation>();
    for (const r of rotations) {
      if (r.seq !== seq || r.prior !== prior) continue;
      if (r.t === 'rot' ? nextDigest(r.key) === last.next : enough(r)) next.set(eventHash(r), r);
    }
    if (next.size > 1) return { id: which, events: chain, current: last.key, disputed: true, trustees };
    const r = [...next.values()][0];
    if (!r) return { id: which, events: chain, current: last.key, disputed: false, trustees };
    if (r.trustees) trustees = r.trustees;
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
