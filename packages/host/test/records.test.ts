// Membership as signed records, whose work a device accepts, and commits signed
// with device keys (docs/decisions/0031-signed-membership.md, 0032-accepting-work.md).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import { Git } from '../src/git.js';
import { Identity, decodeInvitation, decodeLink, encodeInvitation } from '../src/peers/identity.js';
import { judge, readRecord, revokeKeyMessage, sign, signRecord, signsMessage, vouchMessage, type Standing } from '../src/peers/records.js';
import { acceptsBranch, acceptsPath, commitsRoom, decodeRules, encodeRules, readRules, ruleFor } from '../src/peers/accept.js';
import { createPerson, exportPerson, importPerson, readPerson } from '../src/peers/person.js';
import { commitSigned, commitSigner, sshPublicKey, writeAllowedSigners } from '../src/signing.js';

const WS = 'ab'.repeat(16);
const ada = crypto.keyPair();
const bo = crypto.keyPair();
const cy = crypto.keyPair();
const hex = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');

const standing = (over: Partial<Standing> = {}): Standing => ({
  workspace: WS, self: hex(ada), members: new Set([hex(bo), hex(cy)]), removed: new Set(), acceptsFrom: null, ...over,
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

  it('are taken only from the devices named, where the device names some; its own always', () => {
    const fromBo = signRecord({ kind: 'remove', workspace: WS, subject: hex(cy) }, bo);
    const fromCy = signRecord({ kind: 'remove', workspace: WS, subject: hex(bo) }, cy);
    const own = signRecord({ kind: 'remove', workspace: WS, subject: hex(cy) }, ada);
    expect(judge(fromBo, standing({ acceptsFrom: [hex(bo)] }))).toBe('take');
    expect(judge(fromCy, standing({ acceptsFrom: [hex(bo)] }))).toBe('refuse');
    // An integrator takes its own alone.
    expect(judge(fromBo, standing({ acceptsFrom: [hex(ada)] }))).toBe('refuse');
    expect(judge(own, standing({ acceptsFrom: [hex(ada)] }))).toBe('take');
  });
});

describe('whose work a device accepts', () => {
  const main = (path: string, ...from: string[]) => ({ branch: 'main', path, from });

  it('everyone’s by default; where a rule says, only those it names; the most specific rule counts', () => {
    const rules = [main('', hex(ada), hex(bo)), main('chapters/', hex(ada)), main('chapters/draft.md', hex(bo))];
    expect(acceptsBranch([], [hex(cy)], 'main')).toBe(true);
    expect(acceptsBranch(rules, [hex(cy)], 'main')).toBe(false);
    expect(acceptsBranch(rules, [hex(bo)], 'main')).toBe(true);
    expect(acceptsBranch(rules, [hex(cy)], 'draft')).toBe(true);
    expect(acceptsPath(rules, [hex(bo)], 'main', 'notes.md')).toBe(true);
    expect(acceptsPath(rules, [hex(bo)], 'main', 'chapters/one.md')).toBe(false);
    expect(acceptsPath(rules, [hex(ada)], 'main', 'chapters/one.md')).toBe(true);
    expect(acceptsPath(rules, [hex(bo)], 'main', 'chapters/draft.md')).toBe(true);
    expect(acceptsPath(rules, [hex(ada)], 'main', 'chapters/draft.md')).toBe(false);
    // A folder rule does not cover a file that only starts the same way.
    expect(ruleFor(rules, 'main', 'chapters-old.md')?.path).toBe('');
    // A device, or the person it acts for.
    expect(acceptsPath([main('chapters/', 'ef'.repeat(32))], [hex(bo), 'ef'.repeat(32)], 'main', 'chapters/one.md')).toBe(true);
  });

  it('decide who commits a shared room: one of those that accept each other, else only what was edited there', () => {
    const [low, high] = [hex(ada), hex(bo)].sort() as [string, string];
    const dev = (key: string, rules?: ReturnType<typeof main>[]) => ({ key, who: [key], rules });
    // No rules: the lowest key commits; the other does not.
    expect(commitsRoom(dev(low), [dev(high)], 'main', 'notes.md', true)).toBe(true);
    expect(commitsRoom(dev(high), [dev(low)], 'main', 'notes.md', true)).toBe(false);
    // An integrator takes only its own edits on main; the other takes its: no one takes both ways, so
    // each commits what was edited on it, and only that.
    const integrator = dev(high, [main('', high)]);
    const follower = dev(low, [main('', high)]);
    expect(commitsRoom(integrator, [follower], 'main', 'notes.md', true)).toBe(true);
    expect(commitsRoom(follower, [integrator], 'main', 'notes.md', false)).toBe(false);
    expect(commitsRoom(follower, [integrator], 'main', 'notes.md', true)).toBe(true);
    // Alone in the room: always.
    expect(commitsRoom(dev(high), [], 'main', 'notes.md', false)).toBe(true);
  });

  it('are read from untrusted JSON, and travel in invitations', () => {
    expect(readRules({ branches: { main: [hex(ada)] }, membership: null })).toEqual({ rules: [], membership: null });
    expect(readRules({ rules: [{ branch: 'main', path: './chapters//', from: [hex(ada), 'nonsense'] }] }).rules).toEqual([main('chapters/', hex(ada))]);
    const rules = { rules: [main('chapters/', hex(ada))], membership: [hex(ada)] };
    expect(decodeRules(encodeRules(rules))).toEqual(rules);
    const ws = { id: WS, secret: 'cd'.repeat(32), forkedFrom: null };
    const inv = encodeInvitation({ workspace: ws, inviter: { key: hex(ada), name: 'ada' }, token: 'ab'.repeat(16), rules });
    expect(decodeInvitation(inv).rules).toEqual(rules);
    // One without them is damaged.
    const bare = `kuraa-invite:${Buffer.from([ws.id, ws.secret, '', hex(ada), 'ada', 'ab'.repeat(16)].join('|')).toString('base64url')}`;
    expect(() => decodeInvitation(bare)).toThrow('damaged');
  });
});

describe('records a device makes about itself', () => {
  it('rules: taken from any member, whatever whose membership changes it takes; the latest counts', async () => {
    const { id } = repo();
    const ws = await id.found();
    await id.addMember(hex(bo), 'bo');
    await id.acceptMembershipFrom([hex(cy)]);
    const older = signRecord({ kind: 'rules', workspace: ws.id, subject: '', rules: JSON.stringify({ rules: [], membership: null }), at: 1 }, bo);
    const newer = signRecord({ kind: 'rules', workspace: ws.id, subject: '', rules: JSON.stringify({ rules: [{ branch: 'main', path: 'a/', from: [hex(bo)] }], membership: null }), at: 2 }, bo);
    await id.takeRecords([newer, older]);
    expect((await id.rulesOf(hex(bo)))?.rules).toEqual([{ branch: 'main', path: 'a/', from: [hex(bo)] }]);
    expect((await id.records()).filter((r) => r.kind === 'rules' && r.by === hex(bo))).toHaveLength(1);
    // Its own rules, published when they change.
    const me = hex(await id.deviceKey());
    await id.acceptOn('main', 'b/', [me]);
    expect((await id.records()).filter((r) => r.kind === 'rules' && r.by === me)).toHaveLength(1);
  });

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
    expect(await id.identitiesOf(hex(bo))).toEqual([hex(bo), hex(boKey), hex(boIdentity)]);
    expect(await id.identitiesOf(hex(boKey))).toEqual([hex(boKey), hex(boIdentity)]);
    expect(await id.people()).toEqual([{ key: hex(boIdentity), name: 'Bo', keys: [hex(boKey)], devices: [hex(bo)] }]);
    // A later name, from the same identity: the latest counts.
    await id.takeRecords([vouchFor(boKey, boIdentity, 'Bo B.', boKey, vouch.at + 1)]);
    expect((await id.personOf(hex(bo)))?.name).toBe('Bo B.');
    // Bo's computer is lost: his identity revokes its key. From when this device takes that, the key is only itself.
    const revoke = signRecord({ kind: 'revoke-key', workspace: ws.id, subject: hex(boKey), person: hex(boIdentity), proof: sign(revokeKeyMessage(hex(boKey)), boIdentity) }, bo);
    // Only Bo's identity revokes Bo's keys.
    expect(readRecord({ ...revoke, proof: sign(revokeKeyMessage(hex(boKey)), mallory) })).toBeNull();
    await id.takeRecords([revoke]);
    expect(await id.identitiesOf(hex(boKey))).toEqual([hex(boKey)]);
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
    expect(await id.identitiesOf(hex(key))).toEqual([hex(key)]);
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
  it('puts its changes on record, whatever its rules (others take them or not by theirs)', async () => {
    const { id } = repo();
    await id.found();
    const me = hex(await id.deviceKey());
    await id.addMember(hex(bo), 'bo');
    await id.addMember(hex(cy), 'cy');
    await id.acceptMembershipFrom([hex(cy)]);
    await id.removeMember(hex(bo));
    expect((await id.records()).filter((r) => r.kind !== 'rules').map((r) => [r.kind, r.subject, r.by])).toEqual([['remove', hex(bo), me]]);
    expect(await id.removed()).toEqual([hex(bo)]);
  });

  it('takes records from others in any order, from the devices it accepts them from', async () => {
    const { id } = repo();
    const ws = await id.found();
    await id.addMember(hex(bo), 'bo');
    // Cy's device is vouched for by Bo's, whose record arrives after Cy's own: both taken.
    const vouch = signRecord({ kind: 'add', workspace: ws.id, subject: hex(cy), name: 'cy' }, bo);
    const fromCy = signRecord({ kind: 'revoke-link', workspace: ws.id, subject: 'ab'.repeat(8) }, cy);
    expect((await id.takeRecords([fromCy, vouch])).map((r) => r.kind).sort()).toEqual(['add', 'revoke-link']);
    expect((await id.members()).map((m) => m.name).sort()).toEqual(['bo', 'cy']);
    // Taking membership changes from Bo's device alone: Cy's are left.
    await id.acceptMembershipFrom([hex(bo)]);
    expect(await id.takeRecords([signRecord({ kind: 'remove', workspace: ws.id, subject: hex(bo) }, cy)])).toEqual([]);
    expect((await id.members()).map((m) => m.name).sort()).toEqual(['bo', 'cy']);
  });

  it('keeps the sync remote it is given', async () => {
    const { dir, id } = repo();
    await id.found();
    execFileSync('git', ['remote', 'add', 'github', 'https://example.org/notes.git'], { cwd: dir });
    expect(await id.syncRemote()).toBeNull();
    await id.setSyncRemote('github');
    expect(await id.syncRemote()).toBe('github');
    await id.setSyncRemote(null);
    expect(await id.syncRemote()).toBeNull();
  });

  it('puts its rules in its invitations and links', async () => {
    const { id } = repo();
    await id.found();
    await id.acceptOn('main', '', [hex(await id.deviceKey())]);
    const rules = await id.rules();
    expect(rules.rules).toEqual([{ branch: 'main', path: '', from: [hex(await id.deviceKey())] }]);
    expect(decodeLink(await id.createLink(1)).rules).toEqual(rules);
    await id.acceptOn('main', '', null);
    expect((await id.rules()).rules).toEqual([]);
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
