// Commits signed with the signing key of the person whose host made them
// (docs/decisions/0034-signatures-are-people.md, 0035-identities-and-signing-keys.md).
//
// A device syncing with others signs the commits it makes for people's edits,
// so any device can tell whose a change is, whoever passed it on. The
// signature is git's own SSH kind (`gpgsig` with an SSH signature, namespace
// "git"), so plain git checks it too: `git log --show-signature`, given the
// allowed-signers file the host keeps (writeAllowedSigners).
//
// Merge commits are not signed: every device must make the same merge commit for
// the same two commits (merging.ts), and a signature would differ by device.
// A device checks each merge it is brought by making it again (peers.ts).
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import crypto from 'hypercore-crypto';
import type { Git } from './git.js';
import type { KeyPair } from './keys.js';

const NAMESPACE = 'git';
const HASH = 'sha512';
const BEGIN = '-----BEGIN SSH SIGNATURE-----';
const END = '-----END SSH SIGNATURE-----';

/** An SSH wire-format string: its length (4 bytes), then its bytes. */
function sshString(b: Buffer | string): Buffer {
  const bytes = typeof b === 'string' ? Buffer.from(b) : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length);
  return Buffer.concat([len, bytes]);
}

function readString(b: Buffer, at: number): [Buffer, number] {
  if (at + 4 > b.length) throw new Error('truncated');
  const len = b.readUInt32BE(at);
  if (at + 4 + len > b.length) throw new Error('truncated');
  return [b.subarray(at + 4, at + 4 + len), at + 4 + len];
}

const publicKeyBlob = (pub: Buffer) => Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);

/** The key as an SSH public key line: `ssh-ed25519 AAAA…`, as GitHub and allowed-signers files take it. */
export function sshPublicKey(pub: Buffer): string {
  return `ssh-ed25519 ${publicKeyBlob(pub).toString('base64')}`;
}

/** What SSHSIG signs: the magic, namespace, reserved, hash name, and the message's hash. */
function signedData(message: Buffer): Buffer {
  const digest = createHash(HASH).update(message).digest();
  return Buffer.concat([Buffer.from('SSHSIG'), sshString(NAMESPACE), sshString(''), sshString(HASH), sshString(digest)]);
}

/** An armored SSH signature of `message` (as `ssh-keygen -Y sign -n git` makes). */
export function sshSign(message: Buffer, key: KeyPair): string {
  const sig = crypto.sign(signedData(message), key.secretKey);
  const version = Buffer.alloc(4);
  version.writeUInt32BE(1);
  const blob = Buffer.concat([
    Buffer.from('SSHSIG'), version, sshString(publicKeyBlob(key.publicKey)), sshString(NAMESPACE), sshString(''), sshString(HASH),
    sshString(Buffer.concat([sshString('ssh-ed25519'), sshString(sig)])),
  ]);
  const b64 = blob.toString('base64');
  const lines = [BEGIN];
  for (let i = 0; i < b64.length; i += 70) lines.push(b64.slice(i, i + 70));
  lines.push(END);
  return lines.join('\n');
}

/** The key (hex) that made an armored SSH signature of `message`, or null if it is not a good ed25519 one. */
export function sshSigner(message: Buffer, armored: string): string | null {
  try {
    const body = armored.trim().split('\n').filter((l) => l && !l.startsWith('-----')).join('');
    const b = Buffer.from(body, 'base64');
    if (b.subarray(0, 6).toString() !== 'SSHSIG' || b.readUInt32BE(6) !== 1) return null;
    const [pub, afterPub] = readString(b, 10);
    const [ns, afterNs] = readString(b, afterPub);
    const [, afterReserved] = readString(b, afterNs);
    const [hash, afterHash] = readString(b, afterReserved);
    const [sigBlob] = readString(b, afterHash);
    if (ns.toString() !== NAMESPACE || hash.toString() !== HASH) return null;
    const [keyType, afterType] = readString(pub, 0);
    const [raw] = readString(pub, afterType);
    const [sigType, afterSigType] = readString(sigBlob, 0);
    const [sig] = readString(sigBlob, afterSigType);
    if (keyType.toString() !== 'ssh-ed25519' || sigType.toString() !== 'ssh-ed25519' || raw.length !== 32) return null;
    return crypto.verify(signedData(message), sig, raw) ? raw.toString('hex') : null;
  } catch {
    return null;
  }
}

/** A commit object with a signature added, as git adds it: a `gpgsig` header at the end of the headers. */
export function signCommitObject(raw: Buffer, key: KeyPair): Buffer {
  const end = raw.indexOf('\n\n');
  if (end < 0) throw new Error('Not a commit object');
  const armored = sshSign(raw, key);
  const header = Buffer.from(`gpgsig ${armored.split('\n').join('\n ')}\n`);
  return Buffer.concat([raw.subarray(0, end + 1), header, raw.subarray(end + 1)]);
}

/** A commit object's signature and the payload it signs (the object without it), or null if unsigned. */
export function splitSignature(raw: Buffer): { payload: Buffer; armored: string } | null {
  const end = raw.indexOf('\n\n');
  const headers = (end < 0 ? raw : raw.subarray(0, end + 1)).toString('latin1');
  const start = headers.search(/^gpgsig /m);
  if (start < 0) return null;
  // The header runs on over lines that start with a space.
  let stop = headers.indexOf('\n', start);
  while (stop >= 0 && headers[stop + 1] === ' ') stop = headers.indexOf('\n', stop + 1);
  if (stop < 0) return null;
  const armored = headers.slice(start + 'gpgsig '.length, stop).split('\n ').join('\n');
  const payload = Buffer.concat([raw.subarray(0, start), raw.subarray(stop + 1)]);
  return { payload, armored };
}

/**
 * Commit `paths` as they are in the working tree, signed, as `git commit -- <paths>`
 * would (the rest as HEAD has it; the index updated for those paths). The
 * commit is signed before the branch points at it, so no other device can fetch
 * it unsigned. Git's hooks do not run, as for merges. Returns the commit.
 */
export async function commitSigned(git: Git, paths: string[], message: string, key: KeyPair, tmpDir: string): Promise<string> {
  const head = await git.head();
  await mkdir(tmpDir, { recursive: true });
  const env = { GIT_INDEX_FILE: join(tmpDir, `sign-index-${process.pid}-${randomBytes(4).toString('hex')}`) };
  try {
    await git.run(head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
    await git.run(['add', '-A', '--', ...paths], { env });
    const tree = await git.out(['write-tree'], { env });
    const text = `${message.trimEnd()}\n`;
    const unsigned = await git.out(['commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'], { input: text });
    const raw = (await git.run(['cat-file', 'commit', unsigned])).bytes;
    const signed = await git.out(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: signCommitObject(raw, key) });
    await git.run(['update-ref', '-m', `commit: ${text.split('\n')[0]}`, 'HEAD', signed, head ?? '']);
    // The index, as `git commit -- <paths>` leaves it.
    await git.run(['add', '-A', '--', ...paths]);
    return signed;
  } finally {
    await rm(env.GIT_INDEX_FILE, { force: true });
  }
}

/** The key (hex) that signed a commit, or null if it is unsigned or not signed this way. */
export async function commitSigner(git: Git, commit: string): Promise<string | null> {
  const r = await git.run(['cat-file', 'commit', commit], { allowFail: true });
  if (r.code !== 0) return null;
  const parts = splitSignature(r.bytes);
  return parts ? sshSigner(parts.payload, parts.armored) : null;
}

/**
 * Write the devices' keys as an allowed-signers file and point this repository's
 * git at it, so `git log --show-signature` names the device that signed.
 */
export async function writeAllowedSigners(git: Git, file: string, devices: { name: string; key: string }[]): Promise<void> {
  const lines = devices.map((d) => `${d.name.replace(/\s/g, '-')} namespaces="git" ${sshPublicKey(Buffer.from(d.key, 'hex'))}`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${lines.join('\n')}\n`);
  // Written once: the config is not rewritten on every change to the members.
  const now = await git.run(['config', '--get', 'gpg.ssh.allowedSignersFile'], { allowFail: true });
  if (now.stdout.trim() !== file) await git.run(['config', 'gpg.ssh.allowedSignersFile', file]);
}
