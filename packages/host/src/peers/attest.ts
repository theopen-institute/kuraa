// Attestations (docs/decisions/0066-permissions-without-a-centre.md, step 6): signed
// statements about an identity, such as "it controls bo@uni.edu", made by a
// verifier (a kuraa server that checked, with a code sent there: verifier.ts).
//
// No verifier counts everywhere: a workspace counts an attestation only if its
// policy names the verifier (policy.ts, `verifier`), and only until it expires.
// They name people (a person's verified email, not a name anyone can type), and
// let groups, rules and audiences name someone by email before they have an
// identity (`email:bo@uni.edu`), which applies once an attestation of it does.
// Losing the email never loses the identity, which was never the email.
import crypto from 'hypercore-crypto';
import type { KeyPair } from '../keys.js';

export interface Attestation {
  v: 1;
  /** The identity it is about. */
  id: string;
  /** What it says of it: `email:<address>`, the address in lower case. */
  claim: string;
  /** The verifier's key that signed it. */
  verifier: string;
  /** When it was made, and when it stops counting (ms since 1970). */
  at: number;
  expires: number;
  sig: string;
}

const hexKey = /^[0-9a-f]{64}$/;

/** An email address as attestations and entries say it: trimmed, in lower case; null if it is not one. */
export function emailOf(s: string): string | null {
  const e = s.trim().toLowerCase();
  return /^[^\s@,]{1,64}@[^\s@,]{1,190}\.[^\s@,.]{2,63}$/.test(e) ? e : null;
}

const message = (a: Omit<Attestation, 'sig'>) => Buffer.from(['kuraa-attestation', a.v, a.id, a.claim, a.verifier, a.at, a.expires].join('\0'));

/** An attestation, signed by a verifier's key. */
export function attest(key: KeyPair, id: string, claim: string, ttlMs = 365 * 24 * 3600_000, at = Date.now()): Attestation {
  const a = { v: 1 as const, id, claim, verifier: key.publicKey.toString('hex'), at, expires: at + ttlMs };
  return { ...a, sig: crypto.sign(message(a), key.secretKey).toString('hex') };
}

/** An attestation from elsewhere, checked for shape and signature (not whether its verifier counts); null if it is not one. */
export function readAttestation(v: unknown): Attestation | null {
  if (!v || typeof v !== 'object') return null;
  const a = v as Record<string, unknown>;
  if (a.v !== 1 || typeof a.id !== 'string' || !hexKey.test(a.id) || typeof a.claim !== 'string' || !/^email:/.test(a.claim) || emailOf(a.claim.slice(6)) !== a.claim.slice(6)
    || typeof a.verifier !== 'string' || !hexKey.test(a.verifier) || typeof a.at !== 'number' || typeof a.expires !== 'number' || typeof a.sig !== 'string' || !/^[0-9a-f]{128}$/.test(a.sig)) return null;
  const out: Attestation = { v: 1, id: a.id, claim: a.claim, verifier: a.verifier, at: a.at, expires: a.expires, sig: a.sig };
  const { sig, ...rest } = out;
  return crypto.verify(message(rest), Buffer.from(sig, 'hex'), Buffer.from(out.verifier, 'hex')) ? out : null;
}

/** What an identity's key signs to ask a verifier to check one of its claims (verifier.ts). */
export const askMessage = (what: string, id: string, claim: string) => Buffer.from(`kuraa-verify\0${what}\0${id}\0${claim}`);
