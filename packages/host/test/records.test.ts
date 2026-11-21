// Membership as signed records, taken from every member, and commits signed for
// attribution (docs/decisions/0031-signed-membership.md, 0038-equal-peers.md).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import { Git } from '../src/git.js';
import { Identity, decodeLink } from '../src/peers/identity.js';
import { judge, readRecord, revokeKeyMessage, sign, signRecord, signsMessage, vouchMessage, type Standing } from '../src/peers/records.js';
import { createPerson, exportPerson, importPerson, readPerson } from '../src/peers/person.js';
import { commitSigned, commitSigner, sshPublicKey, writeAllowedSigners } from '../src/signing.js';

const WS = 'ab'.repeat(16);
const ada = crypto.keyPair();
const bo = crypto.keyPair();
const cy = crypto.keyPair();
const hex = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');

const standing = (over: Partial<Standing> = {}): Standing => ({
  workspace: WS, self: hex(ada), members: new Set([hex(bo), hex(cy)]), removed: new Set(), ...over,
});

describe('signed membership records', () => {
  it('are taken only as signed, for this workspace, from a member', () => {
    const r = signRecord({ kind: 'remove', workspace: WS, subject: hex(cy) }, bo);
    expect(readRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
    // Changed after signing: not a record.
    expect(readRecord({ ...r, subject: hex(ada) })).toBeNull();
    expect(judge(r, standing())).toBe('take');
    // Another workspace's, or from a removed device: refused. From a device not paired yet: later.
    expect(judge(signRecord({ kind: 'remove', workspace: 'cd'.repeat(16), subject: hex(cy) }, bo), standing())).toBe('refuse');
    expect(judge(r, standing({ removed: new Set([hex(bo)]) }))).toBe('refuse');
    expect(judge(r, standing({ members: new Set() }))).toBe('wait');
  });

  it('are taken from every member alike, the newest as the first', () => {
    // Cy removes Bo, and Bo removes Cy: each is a member, so each record is taken.
    expect(judge(signRecord({ kind: 'remove', workspace: WS, subject: hex(bo) }, cy), standing())).toBe('take');
    expect(judge(signRecord({ kind: 'remove', workspace: WS, subject: hex(cy) }, bo), standing())).toBe('take');
    expect(judge(signRecord({ kind: 'add', workspace: WS, subject: hex(crypto.keyPair()), name: 'new' }, cy), standing())).toBe('take');
  });
});

describe('records a device makes about itself', () => {
  it('signing keys: a device says which it signs with, with that key’s word; a person vouches for theirs, and revokes them', async () => {
    const { id } = repo();
    const ws = await id.found();
    await id.addMember(hex(bo), 'bo');
    const boKey = crypto.keyPair(); // the key Bo signs with on Bo's device
    const boIdentity = crypto.keyPair();
    const mallory = crypto.keyPair();
    const signs = signRecord({ kind: 'signs', workspace: ws.id, subject: hex(boKey), proof: sign(signsMessage(hex(bo)), boKey) }, bo);
    // A device cannot claim a key it does not hold: the key's own signature is missing.
    expect(readRecord(signRecord({ kind: 'signs', workspace: ws.id, subject: hex(boKey), proof: sign(signsMessage(hex(bo)), mallory) }, bo))).toBeNull();
    const vouchFor = (key: typeof boKey, identity: typeof boIdentity, name: string, keySigns = key, at?: number) => {
      const m = vouchMessage(hex(key), hex(identity), name);
      return signRecord({ kind: 'vouch', workspace: ws.id, subject: hex(key), person: hex(identity), name, proof: sign(m, identity), keyProof: sign(m, keySigns), at }, bo);
    };
    const vouch = vouchFor(boKey, boIdentity, 'Bo');
    // No one vouches for a key in another's name, nor claims another's key: both the identity and the key sign.
    expect(readRecord({ ...vouch, proof: sign(vouchMessage(hex(boKey), hex(boIdentity), 'Bo'), mallory) })).toBeNull();
    expect(readRecord(vouchFor(boKey, mallory, 'Mallory', mallory))).toBeNull();
    expect(readRecord({ ...vouch, keyProof: undefined })).toBeNull();
    await id.takeRecords([signs, vouch]);
    expect(await id.signingKeyOf(hex(bo))).toBe(hex(boKey));
    expect(await id.personOf(hex(bo))).toEqual({ key: hex(boIdentity), name: 'Bo' });
    expect(await id.personOf(hex(boKey))).toEqual({ key: hex(boIdentity), name: 'Bo' });
    expect(await id.people()).toEqual([{ key: hex(boIdentity), name: 'Bo', keys: [hex(boKey)], devices: [hex(bo)] }]);
    // A later name, from the same identity: the latest counts.
    await id.takeRecords([vouchFor(boKey, boIdentity, 'Bo B.', boKey, vouch.at + 1)]);
    expect((await id.personOf(hex(bo)))?.name).toBe('Bo B.');
    // Bo's computer is lost: his identity revokes its key. From when this device takes that, the key is no one's.
    const revoke = signRecord({ kind: 'revoke-key', workspace: ws.id, subject: hex(boKey), person: hex(boIdentity), proof: sign(revokeKeyMessage(hex(boKey)), boIdentity) }, bo);
    // Only Bo's identity revokes Bo's keys.
    expect(readRecord({ ...revoke, proof: sign(revokeKeyMessage(hex(boKey)), mallory) })).toBeNull();
    await id.takeRecords([revoke]);
    expect(await id.personOf(hex(boKey))).toBeNull();
    expect(await id.personOf(hex(bo))).toBeNull();
    expect(await id.people()).toEqual([]);
  });

  it('a key whose holder vouched for it in two names is no one’s', async () => {
    const { id } = repo();
    const ws = await id.found();
    await id.addMember(hex(bo), 'bo');
    const key = crypto.keyPair();
    const one = crypto.keyPair();
    const two = crypto.keyPair();
    const vouch = (identity: typeof one, name: string) => {
      const m = vouchMessage(hex(key), hex(identity), name);
      return signRecord({ kind: 'vouch', workspace: ws.id, subject: hex(key), person: hex(identity), name, proof: sign(m, identity), keyProof: sign(m, key) }, bo);
    };
    await id.takeRecords([vouch(one, 'One')]);
    expect((await id.personOf(hex(key)))?.name).toBe('One');
    await id.takeRecords([vouch(two, 'Two')]);
    expect(await id.personOf(hex(key))).toBeNull();
  });

  it('an identity: made, exported, imported on another computer, vouching there for that computer’s key', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kuraa-person-'));
    const made = await createPerson('Ada Lovelace', join(dir, 'one.json'));
    await expect(createPerson('Ada again', join(dir, 'one.json'))).rejects.toThrow('already');
    expect(exportPerson(made)).toMatch(/^kuraa-id:/);
    const there = await importPerson(exportPerson(made), join(dir, 'two.json'));
    // Only kuraa-id: lines.
    await expect(importPerson(exportPerson(made).replace(/^kuraa-id:/, 'kuraa-person:'), join(dir, 'three.json'))).rejects.toThrow('Not an identity');
    expect(there.publicKey.equals(made.publicKey)).toBe(true);
    expect((await readPerson(join(dir, 'two.json')))?.name).toBe('Ada Lovelace');
    const { id } = repo();
    await id.found();
    const key = crypto.keyPair();
    await id.signsWith(key);
    await id.vouch(made, key);
    await id.vouch(made, key);
    const me = hex(await id.deviceKey());
    expect(await id.personOf(me)).toEqual({ key: made.publicKey.toString('hex'), name: 'Ada Lovelace' });
    expect((await id.records()).filter((r) => r.kind === 'vouch')).toHaveLength(1);
  });
});

function repo(): { dir: string; git: Git; id: Identity } {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-records-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const git = new Git(dir);
  return { dir, git, id: new Identity(git, join(dir, '.git', 'kuraa')) };
}

describe('a device and its records', () => {
  it('puts its changes on record, to pass on', async () => {
    const { id } = repo();
    await id.found();
    const me = hex(await id.deviceKey());
    await id.addMember(hex(bo), 'bo');
    await id.addMember(hex(cy), 'cy');
    await id.removeMember(hex(bo));
    expect((await id.records()).map((r) => [r.kind, r.subject, r.by])).toEqual([['remove', hex(bo), me]]);
    expect(await id.removed()).toEqual([hex(bo)]);
  });

  it('takes records from any member, in any order', async () => {
    const { id } = repo();
    const ws = await id.found();
    await id.addMember(hex(bo), 'bo');
    // Cy's device is vouched for by Bo's, whose record arrives after Cy's own: both taken.
    const vouch = signRecord({ kind: 'add', workspace: ws.id, subject: hex(cy), name: 'cy' }, bo);
    const fromCy = signRecord({ kind: 'revoke-link', workspace: ws.id, subject: 'ab'.repeat(8) }, cy);
    expect((await id.takeRecords([fromCy, vouch])).map((r) => r.kind).sort()).toEqual(['add', 'revoke-link']);
    expect((await id.members()).map((m) => m.name).sort()).toEqual(['bo', 'cy']);
    // Cy, the newest, removes Bo, who paired Cy: taken like any member's.
    expect((await id.takeRecords([signRecord({ kind: 'remove', workspace: ws.id, subject: hex(bo) }, cy)])).map((r) => r.kind)).toEqual(['remove']);
    expect((await id.members()).map((m) => m.name)).toEqual(['cy']);
  });

  it('applies a record it kept but could not apply (git config held by another writer), before its next change', async () => {
    const { dir, id } = repo();
    const ws = await id.found();
    await id.addMember(hex(bo), 'bo');
    // Another writer holds .git/config for longer than git.ts waits: Bo's pairing of Cy is kept, not applied.
    writeFileSync(join(dir, '.git', 'config.lock'), '');
    const add = signRecord({ kind: 'add', workspace: ws.id, subject: hex(cy), name: 'cy' }, bo);
    expect((await id.takeRecords([add])).map((r) => r.kind)).toEqual(['add']);
    expect((await id.members()).map((m) => m.name)).toEqual(['bo']);
    // Let go of: the next change applies it first, though the record is not new to this device.
    rmSync(join(dir, '.git', 'config.lock'));
    expect(await id.takeRecords([add])).toEqual([]);
    expect((await id.members()).map((m) => m.name).sort()).toEqual(['bo', 'cy']);
    // A removal on record but not in the config (stopped in between) is applied when the device starts (reconcile).
    const remove = signRecord({ kind: 'remove', workspace: ws.id, subject: hex(bo) }, cy);
    const file = join(dir, '.git', 'kuraa', 'records.json');
    writeFileSync(file, JSON.stringify([...JSON.parse(readFileSync(file, 'utf8')), remove]));
    await id.reconcile();
    expect(await id.removed()).toEqual([hex(bo)]);
    expect((await id.members()).map((m) => m.name)).toEqual(['cy']);
  }, 30_000);

  it('makes its secret anew on record, the latest counting, and keeps its records from other users of the computer', async () => {
    const { dir, git, id } = repo();
    const ws = await id.found();
    await id.addMember(hex(bo), 'bo');
    const mine = await id.newSecret();
    expect((await id.workspace())!.secret).toBe(mine);
    expect(mine).not.toBe(ws.secret);
    // Bo's, made later, counts here too; an older one does not.
    const later = signRecord({ kind: 'secret', workspace: ws.id, subject: 'cd'.repeat(32), at: Date.now() + 1000 }, bo);
    const older = signRecord({ kind: 'secret', workspace: ws.id, subject: 'ef'.repeat(32), at: Date.now() - 60_000 }, bo);
    await id.takeRecords([later, older]);
    expect((await git.out(['config', 'kuraa.secret']))).toBe('cd'.repeat(32));
    if (process.platform !== 'win32') expect(statSync(join(dir, '.git', 'kuraa', 'records.json')).mode & 0o077).toBe(0);
  });

  it('puts the links it makes on record, with their topic, announced while they let people in', async () => {
    const { id } = repo();
    await id.found();
    const day = decodeLink(await id.createLink(24, false));
    const gone = decodeLink(await id.createLink(-1, false));
    const revoked = decodeLink(await id.createLink(null, true));
    await id.revokeLink(revoked.id);
    const { topics, next } = await id.linkTopics();
    expect(topics).toEqual([day.topic]);
    expect(next).toBe(day.expires);
    expect(gone.topic).not.toBe(day.topic);
  });

  it('makes invite links for one person or anyone, and knows those used up', async () => {
    const { id } = repo();
    await id.found();
    const once = decodeLink(await id.createLink(24, true));
    const anyone = decodeLink(await id.createLink(null, false));
    expect([once.once, anyone.once, anyone.expires]).toEqual([true, false, 0]);
    expect((await id.links()).map((l) => l.once)).toEqual([true, false]);
    await id.useLink(once.id);
    await id.revokeLink(anyone.id);
    expect((await id.revokedLinks()).sort()).toEqual([once.id, anyone.id].sort());
    expect(await id.usedLinks()).toEqual([once.id]);
  });
});

describe('signed commits', () => {
  it('name the device that made them, for this code and for git itself', async () => {
    const { dir, git } = repo();
    execFileSync('git', ['config', 'user.name', 'Ada'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'ada@example.org'], { cwd: dir });
    writeFileSync(join(dir, 'notes.md'), '# Ünïcode notes\n');
    writeFileSync(join(dir, 'other.md'), 'not this one\n');
    const tmp = join(dir, '.git', 'kuraa', 'tmp');
    const first = await commitSigned(git, ['notes.md'], 'First\n\nCo-authored-by: Bo <bo@example.org>\n', ada, tmp);
    expect(await git.out(['rev-parse', 'HEAD'])).toBe(first);
    expect(await commitSigner(git, first)).toBe(hex(ada));
    // Only the paths given, as `git commit -- <paths>`; the index agrees, and the other file waits.
    expect(await git.out(['ls-tree', '--name-only', 'HEAD'])).toBe('notes.md');
    expect(await git.out(['status', '--porcelain'])).toBe('?? other.md');
    expect(await git.out(['log', '-1', '--format=%an%n%B'])).toBe('Ada\nFirst\n\nCo-authored-by: Bo <bo@example.org>');
    writeFileSync(join(dir, 'notes.md'), '# Ünïcode notes, again\n');
    const signed = await commitSigned(git, ['notes.md'], 'Second', ada, tmp);
    expect(await git.out(['rev-parse', 'HEAD^'])).toBe(first);
    expect(sshPublicKey(ada.publicKey)).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA/);
    await writeAllowedSigners(git, join(dir, '.git', 'kuraa', 'allowed_signers'), [{ name: 'ada-laptop', key: hex(ada) }]);
    const v = await git.run(['verify-commit', signed], { allowFail: true });
    expect(v.code).toBe(0);
    expect(v.stderr).toContain('Good "git" signature for ada-laptop');
  });

  it('are not taken for another device’s', async () => {
    const { dir, git } = repo();
    execFileSync('git', ['config', 'user.name', 'A'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'a@b'], { cwd: dir });
    writeFileSync(join(dir, 'x.md'), 'x\n');
    const signed = await commitSigned(git, ['x.md'], 'x', bo, join(dir, '.git', 'kuraa', 'tmp'));
    expect(await commitSigner(git, signed)).toBe(hex(bo));
    expect(await commitSigner(git, signed)).not.toBe(hex(ada));
    const unsigned = await git.out(['commit-tree', `${signed}^{tree}`, '-m', 'y'], { env: { GIT_AUTHOR_NAME: 'A', GIT_AUTHOR_EMAIL: 'a@b', GIT_COMMITTER_NAME: 'A', GIT_COMMITTER_EMAIL: 'a@b' } });
    expect(await commitSigner(git, unsigned)).toBeNull();
  });
});
