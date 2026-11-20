// Key pairs kept in files: a device's connection key, a person's signing key.
//
// A key is made only when its file does not exist, and written whole or not at
// all (a temporary file, linked into place), so two hosts starting at once agree
// on one key, and a file that cannot be read is never replaced: a key lost that
// way would be a device or a computer no one recognises.
import { randomBytes } from 'node:crypto';
import { chmod, link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import crypto from 'hypercore-crypto';

export interface KeyPair { publicKey: Buffer; secretKey: Buffer }

/** A key pair from its secret key (hex), or null if it is not one. */
export function keyFromSecret(secret: unknown): KeyPair | null {
  if (typeof secret !== 'string' || !/^[0-9a-f]{128}$/.test(secret)) return null;
  const secretKey = Buffer.from(secret, 'hex');
  return { secretKey, publicKey: secretKey.subarray(32) };
}

/** The key's file as kept: both halves, hex. */
export const keyJson = (k: KeyPair, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ ...extra, publicKey: k.publicKey.toString('hex'), secretKey: k.secretKey.toString('hex') });

/** Write `content` to `file` only if there is no such file yet, whole: false if there is one. Readable only by its owner. */
export async function createOnly(file: string, content: string): Promise<boolean> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(tmp, content, { mode: 0o600 });
  await chmod(tmp, 0o600);
  try {
    await link(tmp, file);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') return false;
    // A file system without hard links: created exclusively, at least.
    if (code !== 'EPERM' && code !== 'ENOTSUP' && code !== 'ENOSYS') throw e;
    try {
      await writeFile(file, content, { mode: 0o600, flag: 'wx' });
      return true;
    } catch (e2) {
      if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw e2;
    }
  } finally {
    await rm(tmp, { force: true });
  }
}

async function readKey(file: string): Promise<KeyPair | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read the key in ${file}: ${(e as Error).message}`, { cause: e });
  }
  let k: KeyPair | null = null;
  try {
    const v = JSON.parse(text) as { publicKey?: unknown; secretKey?: unknown };
    k = keyFromSecret(v.secretKey);
    if (k && v.publicKey !== undefined && v.publicKey !== k.publicKey.toString('hex')) k = null;
  } catch { /* damaged, below */ }
  if (!k) throw new Error(`The key in ${file} is damaged. It is left as it is; move it aside to make a new one (its device or computer will be a new one to the others).`);
  return k;
}

/** Keys being read or made: whoever asks meanwhile gets the same one. */
const reading = new Map<string, Promise<KeyPair>>();

/** The key pair kept in `file`, made the first time it is asked for. */
export function keptKey(file: string): Promise<KeyPair> {
  const path = resolve(file);
  let k = reading.get(path);
  if (!k) {
    k = (async () => {
      const now = await readKey(path);
      if (now) return now;
      const made = crypto.keyPair();
      if (await createOnly(path, keyJson(made))) return made;
      // Another host made it first: theirs.
      return (await readKey(path))!;
    })();
    reading.set(path, k);
    // Read again next time: the folder may be another by then (a workspace removed, and made again).
    void k.catch(() => undefined).finally(() => reading.delete(path));
  }
  return k;
}
