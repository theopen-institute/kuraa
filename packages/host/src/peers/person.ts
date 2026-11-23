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
import { incept, nextDigest, readEvent, resolve, rotate, type KeyEvent } from './kel.js';
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
  const state = resolve(list.map(readEvent).filter((e): e is KeyEvent => !!e));
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
export async function recoverPerson(line: string, keep: string[], file = personFile()): Promise<Person> {
  const { name, key, events } = decodeLine(line, 'kuraa-recovery', 'a recovery key');
  if (!Array.isArray(events)) throw new Error('This recovery key is damaged');
  const known = (events as unknown[]).map(readEvent).filter((e): e is KeyEvent => !!e);
  const now = await readPerson(file);
  const state = resolve(now ? [...known, ...now.events] : known);
  if (!state) throw new Error('This recovery key is damaged');
  // Checked before anything here changes (a recovery key already used, or another identity's, is refused).
  const nextRecovery = crypto.keyPair();
  const log = [...state.events, rotate(state.events, key, nextRecovery, keep, Date.now())];
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
  identity: { name: string; id: string; key: string; recovery: 'here' | 'saved' } | null;
  keys: { key: string; thisComputer: boolean }[];
}> {
  const signing = (await signingKey()).publicKey.toString('hex');
  const p = await readPerson();
  const revoked = new Set((await revokedKeys()).map((r) => r.key));
  const keys = [...new Set([signing, ...(p ? known : [])])].filter((k) => !revoked.has(k));
  return {
    signing,
    identity: p && { name: p.name, id: p.id, key: p.publicKey.toString('hex'), recovery: await recoveryState() },
    keys: keys.map((key) => ({ key, thisComputer: key === signing })),
  };
}
