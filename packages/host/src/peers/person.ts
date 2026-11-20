// A person's keys (docs/decisions/0035-identities-and-signing-keys.md).
//
// - Their identity (the person's key): one per person, kept outside any
//   workspace (~/.kuraa/person.json, or KURAA_PERSON). It signs no commits: it
//   vouches for their signing keys, and revokes them. It may be on one computer
//   only; taken to another (export, import), that one can vouch for its own key.
// - Their signing key on each computer (below): what signs their commits there.
import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import crypto from 'hypercore-crypto';
import { revokeKeyMessage } from './records.js';
import { createOnly, keptKey, keyFromSecret, keyJson, type KeyPair } from '../keys.js';

export interface Person { name: string; publicKey: Buffer; secretKey: Buffer }

/** Where this computer keeps its person's key. */
export function personFile(): string {
  return process.env.KURAA_PERSON || join(homedir(), '.kuraa', 'person.json');
}

export async function readPerson(file = personFile()): Promise<Person | null> {
  try {
    const p = JSON.parse(await readFile(file, 'utf8')) as { name?: unknown; secretKey?: unknown };
    const k = keyFromSecret(p.secretKey);
    return typeof p.name === 'string' && k ? { name: p.name, ...k } : null;
  } catch {
    return null;
  }
}

async function write(file: string, p: Person): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, keyJson(p, { name: p.name }), { mode: 0o600 });
  await chmod(file, 0o600);
}

/** A new person's key, kept at `file`; refused if there is one already (it would be lost). */
export async function createPerson(name: string, file = personFile()): Promise<Person> {
  if (!name.trim()) throw new Error('A person needs a name');
  const k = crypto.keyPair();
  const p = { name: name.trim(), publicKey: k.publicKey, secretKey: k.secretKey };
  if (!(await createOnly(file, keyJson(p, { name: p.name })))) throw new Error(`There is a person's key already: ${file}`);
  return p;
}

/** The key as one line, to take to another computer: anyone who has it can act as this person. */
export function exportPerson(p: Person): string {
  return `kuraa-id:${Buffer.from(JSON.stringify({ name: p.name, secretKey: p.secretKey.toString('hex') })).toString('base64url')}`;
}

/**
 * Keep a person's key exported on another computer here. One already here (made
 * for this computer on its own, 0038) is replaced, kept beside it as
 * person.json.replaced-<time>, and so is this computer's signing key, which
 * the old identity vouched for: a new one is made, for the new identity.
 */
export async function importPerson(code: string, file = personFile()): Promise<Person> {
  const m = /^kuraa-id:([A-Za-z0-9_-]+)$/.exec(code.trim());
  if (!m) throw new Error('Not an identity (it starts with kuraa-id:)');
  let v: { name?: unknown; secretKey?: unknown };
  try {
    v = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as typeof v;
  } catch {
    throw new Error('This person\'s key is damaged');
  }
  const k = keyFromSecret(v.secretKey);
  if (typeof v.name !== 'string' || !k) throw new Error('This person\'s key is damaged');
  const p = { name: v.name, ...k };
  const now = await readPerson(file);
  if (now && !now.publicKey.equals(p.publicKey)) {
    await copyFile(file, `${file}.replaced-${Date.now()}`);
    await rm(signingFile(file), { force: true });
  }
  await write(file, p);
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

export interface Revoked { key: string; proof: string }

export async function revokedKeys(file = revokedFile()): Promise<Revoked[]> {
  try {
    const list = JSON.parse(await readFile(file, 'utf8')) as Partial<Revoked>[];
    return list.filter((r): r is Revoked => !!r && typeof r.key === 'string' && typeof r.proof === 'string');
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
  await keepRevoked({ key, proof: crypto.sign(revokeKeyMessage(key), p.secretKey).toString('hex') });
}

/** You on this computer, as the app shows it: its signing key, your identity if here, and your keys `known` to workspaces. */
export async function personInfo(known: string[] = []): Promise<{ signing: string; identity: { name: string; key: string } | null; keys: { key: string; thisComputer: boolean }[] }> {
  const signing = (await signingKey()).publicKey.toString('hex');
  const p = await readPerson();
  const revoked = new Set((await revokedKeys()).map((r) => r.key));
  const keys = [...new Set([signing, ...(p ? known : [])])].filter((k) => !revoked.has(k));
  return { signing, identity: p && { name: p.name, key: p.publicKey.toString('hex') }, keys: keys.map((key) => ({ key, thisComputer: key === signing })) };
}
