// A person's keys (docs/decisions/0035-identities-and-signing-keys.md,
// 0066-permissions-without-a-centre.md).
//
// - Their identity: a stable ID (kel.ts: the hash of its first event) with a
//   key that may change. One per person, kept outside any workspace
//   (~/.kuraa/person.json, or KURAA_PERSON), with its log of events. It signs
//   no commits: it vouches for their signing keys, and revokes them. Taken to
//   another computer (export, import), that one can vouch for its own key.
// - Its recovery key: the key the identity committed to, the one that may
//   replace its key (lost, or stolen). Made beside it (recovery.json), to be
//   copied somewhere safe and then removed from this computer (recoverySaved):
//   while it is here, whoever takes the computer takes both.
// - Their signing key on each computer (below): what signs their commits there.
import { chmod, copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import crypto from 'hypercore-crypto';
import { revokeKeyMessage } from './records.js';
import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync } from 'node:crypto';
import { readAttestation, type Attestation } from './attest.js';
import { incept, nextDigest, readEvent, resolve, rotate, trusteeMessage, trusteeRequest, trusteeRotation, vouchFor, type KeyEvent, type TrusteeRotation, type TrusteeVouch, type Trustees } from './kel.js';
import { createOnly, keptKey, keyFromSecret, keyJson, type KeyPair } from '../keys.js';

export interface Person {
  name: string;
  /** The identity's key now: what it signs with. */
  publicKey: Buffer;
  secretKey: Buffer;
  /** The identity's ID: never changes. */
  id: string;
  /** Its log (kel.ts), as this computer knows it. */
  events: KeyEvent[];
}

/** Where this computer keeps its person's key. */
export function personFile(): string {
  return process.env.KURAA_PERSON || join(homedir(), '.kuraa', 'person.json');
}

/** Where this computer keeps the identity's recovery key until the person says it is saved elsewhere. */
export function recoveryFile(person = personFile()): string {
  return join(dirname(person), 'recovery.json');
}

/** A log, checked: its events, its ID, and that `key` is its key now. Null if not. */
function checkLog(list: unknown, key: KeyPair): { id: string; events: KeyEvent[] } | null {
  if (!Array.isArray(list)) return null;
  // The person's own copy of their log: a trustee rotation in it was made here, or copied from here (step 6).
  const state = resolve(list.map(readEvent).filter((e): e is KeyEvent => !!e), undefined, { trustTrots: true });
  if (!state || state.disputed || state.current !== key.publicKey.toString('hex')) return null;
  return { id: state.id, events: state.events };
}

export async function readPerson(file = personFile()): Promise<Person | null> {
  let p: { name?: unknown; secretKey?: unknown; events?: unknown };
  try {
    p = JSON.parse(await readFile(file, 'utf8')) as typeof p;
  } catch {
    return null;
  }
  const k = keyFromSecret(p.secretKey);
  if (typeof p.name !== 'string' || !k) return null;
  if (p.events === undefined) return upgrade(file, p.name, k);
  const log = checkLog(p.events, k);
  return log ? { name: p.name, ...k, ...log } : null;
}

/**
 * An identity kept before identities had logs: given one, from its key and a
 * recovery key made now. The same for every process upgrading it at once: the
 * recovery key is made once (keys.ts), and the first event is dated 0.
 */
async function upgrade(file: string, name: string, k: KeyPair): Promise<Person> {
  const recovery = await keptKey(recoveryFile(file));
  const events = [incept(k, recovery, 0)];
  const p: Person = { name, ...k, ...checkLog(events, k)! };
  await write(file, p);
  return p;
}

async function write(file: string, p: Person): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, keyJson(p, { name: p.name, id: p.id, events: p.events }), { mode: 0o600 });
  await chmod(file, 0o600);
}

/** Move a file aside (`<file>.replaced-<time>`), keeping it: a key in it may be the only copy. */
async function aside(file: string): Promise<void> {
  try {
    await rename(file, `${file}.replaced-${Date.now()}`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** A new person's identity, kept at `file`, with its recovery key beside it; refused if there is one already (it would be lost). */
export async function createPerson(name: string, file = personFile()): Promise<Person> {
  if (!name.trim()) throw new Error('A person needs a name');
  if (await readPerson(file)) throw new Error(`There is a person's key already: ${file}`);
  const k = crypto.keyPair();
  const recovery = crypto.keyPair();
  const events = [incept(k, recovery)];
  const p: Person = { name: name.trim(), ...k, ...checkLog(events, k)! };
  if (!(await createOnly(file, keyJson(p, { name: p.name, id: p.id, events: p.events })))) throw new Error(`There is a person's key already: ${file}`);
  // Written only once the identity is this one's (two made at once: the other's is refused above).
  // A recovery key left by an identity no longer here: kept aside, never lost.
  await aside(recoveryFile(file));
  await createOnly(recoveryFile(file), keyJson(recovery));
  return p;
}

/** The identity as one line, to take to another computer: anyone who has it can act as this person (until they recover it). */
export function exportPerson(p: Person): string {
  return `kuraa-id:${Buffer.from(JSON.stringify({ name: p.name, secretKey: p.secretKey.toString('hex'), events: p.events })).toString('base64url')}`;
}

function decodeLine(code: string, prefix: string, what: string): { name: string; key: KeyPair; events: unknown } {
  const m = new RegExp(`^${prefix}:([A-Za-z0-9_-]+)$`).exec(code.trim());
  if (!m) throw new Error(`Not ${what} (it starts with ${prefix}:)`);
  let v: { name?: unknown; secretKey?: unknown; events?: unknown };
  try {
    v = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as typeof v;
  } catch {
    throw new Error(`This ${what.replace(/^an? /, '')} is damaged`);
  }
  const key = keyFromSecret(v.secretKey);
  if (typeof v.name !== 'string' || !key) throw new Error(`This ${what.replace(/^an? /, '')} is damaged`);
  return { name: v.name, key, events: v.events };
}

/**
 * Keep here an identity this person is replacing this computer's with (another's
 * from their other computer, or the same recovered): the one here, if another,
 * is kept aside (person.json.replaced-<time>), with its recovery key if not yet
 * saved, and this computer's signing key is made anew, for the new identity.
 */
async function replace(file: string, p: Person): Promise<void> {
  const now = await readPerson(file);
  if (now && now.id !== p.id) {
    await copyFile(file, `${file}.replaced-${Date.now()}`);
    await aside(recoveryFile(file));
    await rm(signingFile(file), { force: true });
  }
  await write(file, p);
}

/** Keep a person's identity exported on another computer here (exportPerson). */
export async function importPerson(code: string, file = personFile()): Promise<Person> {
  const { name, key, events } = decodeLine(code, 'kuraa-id', 'an identity');
  if (events === undefined) throw new Error('This identity was copied from an older kuraa: copy it again there');
  const log = checkLog(events, key);
  if (!log) throw new Error('This identity is damaged, or was recovered since it was copied: copy it again');
  const now = await readPerson(file);
  // The same identity, as this computer knows it already, or later: nothing older replaces it.
  if (now && now.id === log.id && now.events.length >= log.events.length) return now;
  // The same identity recovered elsewhere since: the recovery key here was the one used, and is its key now.
  if (now && now.id === log.id) await rm(recoveryFile(file), { force: true });
  const p: Person = { name, ...key, ...log };
  await replace(file, p);
  return p;
}

/** Whether the identity's recovery key is still on this computer ('here': to copy somewhere safe) or not ('saved'). */
export async function recoveryState(file = personFile()): Promise<'here' | 'saved'> {
  return (await recoveryKeyHere(file)) ? 'here' : 'saved';
}

/** The recovery key on this computer, if it is the one the identity committed to. */
async function recoveryKeyHere(file: string): Promise<KeyPair | null> {
  const p = await readPerson(file);
  if (!p) return null;
  try {
    const k = keyFromSecret((JSON.parse(await readFile(recoveryFile(file), 'utf8')) as { secretKey?: unknown }).secretKey);
    return k && nextDigest(k.publicKey.toString('hex')) === p.events[p.events.length - 1]!.next ? k : null;
  } catch {
    return null;
  }
}

/**
 * The recovery key as one line, to keep somewhere safe (printed, a password
 * manager): with it the identity's key can be replaced, on any computer. It
 * carries the identity's log, which is all a recovery needs: the log cannot
 * change without using this key. Null if it is no longer on this computer.
 */
export async function recoveryLine(file = personFile()): Promise<string | null> {
  const p = await readPerson(file);
  const k = await recoveryKeyHere(file);
  if (!p || !k) return null;
  return `kuraa-recovery:${Buffer.from(JSON.stringify({ name: p.name, secretKey: k.secretKey.toString('hex'), events: p.events })).toString('base64url')}`;
}

/** The person has kept the recovery key elsewhere: remove it from this computer. */
export async function recoverySaved(file = personFile()): Promise<void> {
  if (!(await recoveryKeyHere(file))) throw new Error('The recovery key is not on this computer');
  await rm(recoveryFile(file), { force: true });
}

/** Whose a recovery key is (recoveryLine), read without using it: refused if it is not one. */
export function readRecoveryLine(line: string): { id: string; name: string } {
  const { name, events } = decodeLine(line, 'kuraa-recovery', 'a recovery key');
  const state = Array.isArray(events) ? resolve((events as unknown[]).map(readEvent).filter((e): e is KeyEvent => !!e)) : null;
  if (!state) throw new Error('This recovery key is damaged');
  return { id: state.id, name };
}

/**
 * Recover an identity with its recovery key (recoveryLine), on any computer:
 * the recovery key becomes the identity's key, a new recovery key is made here
 * (to save, as the first), and `keep` lists the signing keys that are still
 * the person's (their other computers'; this computer's is vouched for anew).
 * What the old key vouched for and is not kept stops counting, on every device
 * alike. Replaces any other identity on this computer, as importing does.
 */
export async function recoverPerson(line: string, keep: string[], file = personFile(), trustees?: Trustees): Promise<Person> {
  const { name, key, events } = decodeLine(line, 'kuraa-recovery', 'a recovery key');
  if (!Array.isArray(events)) throw new Error('This recovery key is damaged');
  const known = (events as unknown[]).map(readEvent).filter((e): e is KeyEvent => !!e);
  const now = await readPerson(file);
  const state = resolve(now ? [...known, ...now.events] : known);
  if (!state) throw new Error('This recovery key is damaged');
  // Checked before anything here changes (a recovery key already used, or another identity's, is refused).
  const nextRecovery = crypto.keyPair();
  const log = [...state.events, rotate(state.events, key, nextRecovery, keep, Date.now(), trustees)];
  const p: Person = { name, ...key, ...checkLog(log, key)! };
  await replace(file, p);
  // A recovery key left here by another identity: kept aside (replace). This identity's was the key just used.
  await rm(recoveryFile(file), { force: true });
  await createOnly(recoveryFile(file), keyJson(nextRecovery));
  return p;
}

// This computer's signing key, for this person (0035) ---------------------------
//
// One per person per computer (per login): made on first use, beside the
// person's key, never copied anywhere. It signs the commits this person makes
// here; their identity (the person's key above) vouches for it, so their work
// counts as theirs from each of their computers, and a lost one can be revoked.

/** Where this computer keeps this person's signing key: beside their person's key. */
export function signingFile(person = personFile()): string {
  return join(dirname(person), 'signing.json');
}

/** This computer's signing key, made the first time it is asked for (keys.ts). */
export function signingKey(file = signingFile()): Promise<KeyPair> {
  return keptKey(file);
}

/** Signing keys this person has revoked (lost computers), with their signature, kept here and published to each workspace. */
export function revokedFile(): string {
  return join(dirname(personFile()), 'revoked.json');
}

export interface Revoked {
  key: string;
  proof: string;
  /** The identity's key that signed it; none: kept before identities had logs, signed by their first key. */
  by?: string;
}

export async function revokedKeys(file = revokedFile()): Promise<Revoked[]> {
  try {
    const list = JSON.parse(await readFile(file, 'utf8')) as Partial<Revoked>[];
    return list.filter((r): r is Revoked => !!r && typeof r.key === 'string' && typeof r.proof === 'string' && (r.by === undefined || typeof r.by === 'string'));
  } catch {
    return [];
  }
}

export async function keepRevoked(entry: Revoked, file = revokedFile()): Promise<void> {
  const list = await revokedKeys(file);
  if (list.some((r) => r.key === entry.key)) return;
  list.push(entry);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(list, null, 1), { mode: 0o600 });
}

/**
 * Revoke one of this person's signing keys (a lost computer's): what it signs
 * stops counting as theirs on each device as the revocation reaches it; what a
 * device already has stays theirs. Their identity's signature, kept here; each
 * workspace says so as it next syncs.
 */
export async function revokeKey(key: string, file = personFile()): Promise<void> {
  if (!/^[0-9a-f]{64}$/.test(key)) throw new Error('Not a key');
  const p = await readPerson(file);
  if (!p) throw new Error('Only your identity can revoke your keys, and it is not on this computer');
  if (key === (await signingKey()).publicKey.toString('hex')) throw new Error('That is this computer\'s key');
  await keepRevoked({ key, proof: crypto.sign(revokeKeyMessage(key), p.secretKey).toString('hex'), by: p.publicKey.toString('hex') });
}

/** You on this computer, as the app shows it: its signing key, your identity if here, and your keys `known` to workspaces. */
export async function personInfo(known: string[] = []): Promise<{
  signing: string;
  identity: { name: string; id: string; key: string; recovery: 'here' | 'saved'; trustees: Trustees | null; emails: { email: string; verifier: string; expires: number }[] } | null;
  keys: { key: string; thisComputer: boolean }[];
}> {
  const signing = (await signingKey()).publicKey.toString('hex');
  const p = await readPerson();
  const revoked = new Set((await revokedKeys()).map((r) => r.key));
  const keys = [...new Set([signing, ...(p ? known : [])])].filter((k) => !revoked.has(k));
  return {
    signing,
    identity: p && {
      name: p.name, id: p.id, key: p.publicKey.toString('hex'), recovery: await recoveryState(), trustees: trusteesOf(p),
      emails: (await attestations()).filter((a) => a.id === p.id).map((a) => ({ email: a.claim.slice(6), verifier: a.verifier, expires: a.expires })),
    },
    keys: keys.map((key) => ({ key, thisComputer: key === signing })),
  };
}

// Trustees (0066, step 6) ---------------------------------------------------------
//
// With both its keys lost, an identity's trustees (named by a rotation, with
// the recovery key: nameTrustees) may replace its key together: the person, on
// a computer of theirs, asks (askTrustees: a new key, kept here meanwhile, and
// what the change will say, as one line to send each trustee); each trustee, in
// their own app, vouches (vouchForAsk, with their identity: a line back); with
// as many as the threshold, the person completes it (completeTrustees).

/** Name an identity's trustees (any `threshold` of `ids`), with its recovery key: as recovering it does, keeping `keep`. */
export function nameTrustees(line: string, trustees: Trustees, keep: string[], file = personFile()): Promise<Person> {
  return recoverPerson(line, keep, file, trustees);
}

/** Where a request to trustees waits for their answers. */
const askFile = (person: string) => join(dirname(person), 'trustee-request.json');

const lineOf = (prefix: string, v: unknown) => `${prefix}:${Buffer.from(JSON.stringify(v)).toString('base64url')}`;

function parseLine<T>(line: string, prefix: string, what: string): T {
  const m = new RegExp(`^${prefix}:([A-Za-z0-9_-]+)$`).exec(line.trim());
  if (!m) throw new Error(`Not ${what} (it starts with ${prefix}:)`);
  try {
    return JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as T;
  } catch {
    throw new Error(`This ${what.replace(/^an? /, '')} is damaged`);
  }
}

/** A request's own hash: what a trustee's answer is for. */
const requestHash = (r: Omit<TrusteeRotation, 'sig' | 'vouches'>) => createHash('sha256').update(trusteeMessage(r)).digest('hex');

/**
 * Ask an identity's trustees to replace its key (both lost), from this
 * computer: a new key and recovery key are made and kept here until they
 * answer; the line to send each of them says whose and what. `log`: the
 * identity's log, as a workspace knows it; `keep`: signing keys still theirs.
 */
export async function askTrustees(log: KeyEvent[], name: string, keep: string[], file = personFile()): Promise<{ line: string; trustees: Trustees }> {
  const key = crypto.keyPair();
  const recovery = crypto.keyPair();
  const request = trusteeRequest(log, key, recovery, keep);
  const state = resolve(log, request.id, { trustTrots: true })!;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(askFile(file), JSON.stringify({ name, request, log: state.events, secretKey: key.secretKey.toString('hex'), recovery: recovery.secretKey.toString('hex') }), { mode: 0o600 });
  return { line: lineOf('kuraa-trustees-ask', { name, request, log: state.events }), trustees: state.trustees! };
}

/** What a request to trustees asks (read without answering): whose identity, and its trustees. */
export function readTrusteeAsk(line: string): { name: string; id: string; trustees: Trustees; request: Omit<TrusteeRotation, 'sig' | 'vouches'> } {
  const v = parseLine<{ name?: unknown; request?: unknown; log?: unknown }>(line, 'kuraa-trustees-ask', 'a request to trustees');
  const log = Array.isArray(v.log) ? (v.log as unknown[]).map(readEvent).filter((e): e is KeyEvent => !!e) : [];
  const state = resolve(log, undefined, { trustTrots: true });
  const r = v.request as Omit<TrusteeRotation, 'sig' | 'vouches'> | undefined;
  if (!state || !state.trustees || typeof v.name !== 'string' || !r || r.id !== state.id || r.t !== 'trot') throw new Error('This request to trustees is damaged');
  const last = state.events[state.events.length - 1]!;
  if (r.seq !== (last.t === 'icp' ? 1 : last.seq + 1)) throw new Error('This request is for an identity that has changed since: ask for a new one');
  return { name: v.name, id: state.id, trustees: state.trustees, request: r };
}

/**
 * Vouch, as a trustee, for a request to replace someone's key (with this
 * computer's identity): a line to send back. Only after making sure, in person
 * or by a call, that it is theirs: whoever has enough such lines has their identity.
 */
export async function vouchForAsk(line: string, file = personFile()): Promise<string> {
  const ask = readTrusteeAsk(line);
  const me = await readPerson(file);
  if (!me) throw new Error('Your identity is not on this computer');
  if (!ask.trustees.ids.includes(me.id)) throw new Error(`You are not one of ${ask.name}’s trustees`);
  return lineOf('kuraa-trustee-yes', { for: requestHash(ask.request), vouch: vouchFor(ask.request, me.id, me) });
}

/**
 * With trustees' answers (as many as the threshold): the identity, its key the
 * new one made when asking, a new recovery key to save, here; replacing any
 * other identity on this computer, as importing does. Other devices count the
 * change once they know the trustees' logs and the answers are by their keys.
 */
export async function completeTrustees(lines: string[], file = personFile()): Promise<Person> {
  let pending: { name: string; request: Omit<TrusteeRotation, 'sig' | 'vouches'>; log: unknown[]; secretKey: string; recovery: string };
  try {
    pending = JSON.parse(await readFile(askFile(file), 'utf8')) as typeof pending;
  } catch {
    throw new Error('No request to trustees is waiting on this computer');
  }
  const key = keyFromSecret(pending.secretKey);
  const recovery = keyFromSecret(pending.recovery);
  if (!key || !recovery) throw new Error('The request waiting here is damaged');
  const hash = requestHash(pending.request);
  const vouches: TrusteeVouch[] = [];
  for (const l of lines.map((x) => x.trim()).filter(Boolean)) {
    const v = parseLine<{ for?: unknown; vouch?: TrusteeVouch }>(l, 'kuraa-trustee-yes', 'a trustee’s answer');
    if (v.for !== hash) throw new Error('One of the answers is to another request');
    if (v.vouch) vouches.push(v.vouch);
  }
  const log = (pending.log).map(readEvent).filter((e): e is KeyEvent => !!e);
  const state = resolve(log, pending.request.id, { trustTrots: true });
  if (!state?.trustees) throw new Error('The request waiting here is damaged');
  const by = new Set(vouches.filter((v) => state.trustees!.ids.includes(v.id)).map((v) => v.id));
  if (by.size < state.trustees.threshold) throw new Error(`It takes ${state.trustees.threshold} of the trustees: ${by.size} answered`);
  const event = trusteeRotation(pending.request, key, vouches);
  const next = checkLog([...state.events, event], key);
  if (!next) throw new Error('The answers do not make a change to this identity');
  const p: Person = { name: pending.name, ...key, ...next };
  await replace(file, p);
  await rm(recoveryFile(file), { force: true });
  await createOnly(recoveryFile(file), keyJson(recovery));
  await rm(askFile(file), { force: true });
  return p;
}

/** An identity's trustees now, from its log here; null if it named none. */
export function trusteesOf(p: Person): Trustees | null {
  return resolve(p.events, p.id, { trustTrots: true })?.trustees ?? null;
}

// Attestations of this person (0066, step 6) -------------------------------------
//
// Kept beside their identity (attestations.json), and put on record by each of
// their workspaces as it next syncs (node.ts): a workspace counts those by the
// verifiers its policy names.

/** Where this computer keeps the attestations of its person. */
export function attestationsFile(person = personFile()): string {
  return join(dirname(person), 'attestations.json');
}

export async function attestations(file = attestationsFile()): Promise<Attestation[]> {
  try {
    return (JSON.parse(await readFile(file, 'utf8')) as unknown[]).map(readAttestation).filter((a): a is Attestation => !!a);
  } catch {
    return [];
  }
}

/** Keep an attestation of this person (one of the same claim by the same verifier is replaced). */
export async function keepAttestation(a: Attestation, file = attestationsFile()): Promise<void> {
  const list = (await attestations(file)).filter((x) => !(x.claim === a.claim && x.verifier === a.verifier));
  list.push(a);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(list, null, 1), { mode: 0o600 });
}

// A recovery key locked with a passphrase (0066, step 6): what a verifier keeps
// in escrow, never able to read it. scrypt makes guessing the passphrase slow;
// AES-GCM says if it was the wrong one.

export function sealRecovery(line: string, passphrase: string): string {
  if (passphrase.length < 8) throw new Error('A passphrase of 8 characters at least: it is all that guards the key');
  const salt = randomBytes(16);
  const key = scryptSync(passphrase.normalize('NFC'), salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([c.update(line, 'utf8'), c.final()]);
  return Buffer.from(JSON.stringify({ v: 1, salt: salt.toString('hex'), iv: iv.toString('hex'), tag: c.getAuthTag().toString('hex'), data: data.toString('base64') })).toString('base64url');
}

/** The recovery key a sealed one holds; null if the passphrase is not its. */
export function openRecovery(blob: string, passphrase: string): string | null {
  try {
    const v = JSON.parse(Buffer.from(blob, 'base64url').toString('utf8')) as { salt: string; iv: string; tag: string; data: string };
    const key = scryptSync(passphrase.normalize('NFC'), Buffer.from(v.salt, 'hex'), 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
    const d = createDecipheriv('aes-256-gcm', key, Buffer.from(v.iv, 'hex'));
    d.setAuthTag(Buffer.from(v.tag, 'hex'));
    return Buffer.concat([d.update(Buffer.from(v.data, 'base64')), d.final()]).toString('utf8');
  } catch {
    return null;
  }
}
