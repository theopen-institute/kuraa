// Membership as signed records, taken from every member, and commits signed for
// attribution (docs/decisions/0031-signed-membership.md, 0038-equal-peers.md).
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import crypto from 'hypercore-crypto';
import { Git } from '../src/git.js';
import { Identity, decodeLink } from '../src/peers/identity.js';
import { judge, readRecord, revokeKeyMessage, sign, signRecord, signsMessage, vouchMessage, type Standing } from '../src/peers/records.js';
import { askTrustees, completeTrustees, createPerson, exportPerson, importPerson, nameTrustees, readPerson, readRecoveryLine, readTrusteeAsk, recoverPerson, recoveryLine, recoverySaved, recoveryState, trusteesOf, vouchForAsk } from '../src/peers/person.js';
import { identityId, incept, rotate, type KeyEvent } from '../src/peers/kel.js';
import { commitSigned, commitSigner, sshPublicKey, writeAllowedSigners } from '../src/signing.js';

const WS = 'ab'.repeat(16);
const ada = crypto.keyPair();
const bo = crypto.keyPair();
const cy = crypto.keyPair();
const hex = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');

const standing = (over: Partial<Standing> = {}): Standing => ({
  workspace: WS, self: hex(ada), members: new Set([hex(bo), hex(cy)]), removed: new Set(), managers: null, ...over,
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

  it('that remove a device are taken only from an admin’s device, or one of the same person’s, once a policy says who (0066, 0068)', () => {
    const remove = signRecord({ kind: 'remove', workspace: WS, subject: hex(cy) }, bo);
    const secret = signRecord({ kind: 'secret', workspace: WS, subject: 'ee'.repeat(32) }, bo);
    const add = signRecord({ kind: 'add', workspace: WS, subject: hex(crypto.keyPair()), name: 'new' }, bo);
    // No policy yet: every member's word counts (0038).
    expect(judge(remove, standing())).toBe('take');
    // Bo's device is not an admin's: waiting (the policy that makes him one may come); Cy's is.
    expect(judge(remove, standing({ managers: new Set([hex(cy)]) }))).toBe('wait');
    expect(judge(add, standing({ managers: new Set([hex(cy)]) }))).toBe('take');
    expect(judge(remove, standing({ managers: new Set([hex(bo)]) }))).toBe('take');
    // A person removes their own computer, admin or not (0068): Bo's device removes Cy's only if both are the same person's.
    expect(judge(remove, standing({ managers: new Set(), persons: new Map([[hex(bo), 'p1'], [hex(cy), 'p1']]) }))).toBe('take');
    expect(judge(remove, standing({ managers: new Set(), persons: new Map([[hex(bo), 'p1'], [hex(cy), 'p2']]) }))).toBe('wait');
    // An admin's computer (Cy's): an admin removes it only as the owner (0070).
    expect(judge(remove, standing({ managers: new Set([hex(bo), hex(cy)]), adminDevices: new Set([hex(bo), hex(cy)]), assigners: new Set() }))).toBe('wait');
    expect(judge(remove, standing({ managers: new Set([hex(bo), hex(cy)]), adminDevices: new Set([hex(bo), hex(cy)]), assigners: new Set([hex(bo)]) }))).toBe('take');
    // The new secret that goes with a removal is any member's to make.
    expect(judge(secret, standing({ managers: new Set([hex(cy)]) }))).toBe('take');
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
    const boIdentity = identity();
    const mallory = crypto.keyPair();
    const signs = signRecord({ kind: 'signs', workspace: ws.id, subject: hex(boKey), proof: sign(signsMessage(hex(bo)), boKey) }, bo);
    // A device cannot claim a key it does not hold: the key's own signature is missing.
    expect(readRecord(signRecord({ kind: 'signs', workspace: ws.id, subject: hex(boKey), proof: sign(signsMessage(hex(bo)), mallory) }, bo))).toBeNull();
    const vouch = vouchFor(ws.id, boKey, boIdentity, 'Bo');
    // No one vouches for a key in another's name, nor claims another's key: both the identity and the key sign.
    expect(readRecord({ ...vouch, proof: sign(vouchMessage(hex(boKey), boIdentity.id, 'Bo'), mallory) })).toBeNull();
    expect(readRecord({ ...vouch, keyProof: undefined })).toBeNull();
    // Signed by a key that is not the identity's: on record, but it counts for nothing.
    const imposter = vouchFor(ws.id, boKey, { ...boIdentity, key: mallory }, 'Mallory');
    await id.takeRecords([...eventRecords(ws.id, boIdentity), signs, imposter]);
    expect(await id.personOf(hex(bo))).toBeNull();
    // Records from before identities had logs (no key named) are not records.
    expect(readRecord(signRecord({ kind: 'vouch', workspace: ws.id, subject: hex(boKey), person: hex(boIdentity.key), name: 'Bo', proof: sign(vouchMessage(hex(boKey), hex(boIdentity.key), 'Bo'), boIdentity.key), keyProof: sign(vouchMessage(hex(boKey), hex(boIdentity.key), 'Bo'), boKey) }, bo))).toBeNull();
    await id.takeRecords([vouch]);
    expect(await id.signingKeyOf(hex(bo))).toBe(hex(boKey));
    expect(await id.personOf(hex(bo))).toEqual({ key: boIdentity.id, name: 'Bo' });
    expect(await id.personOf(hex(boKey))).toEqual({ key: boIdentity.id, name: 'Bo' });
    expect(await id.people()).toEqual([{ key: boIdentity.id, name: 'Bo', keys: [hex(boKey)], devices: [hex(bo)] }]);
    // A later name, from the same identity: the latest counts.
    await id.takeRecords([vouchFor(ws.id, boKey, boIdentity, 'Bo B.', vouch.at + 1)]);
    expect((await id.personOf(hex(bo)))?.name).toBe('Bo B.');
    // Bo's computer is lost: his identity revokes its key. From when this device takes that, the key is no one's.
    const revoke = revokeFor(ws.id, boKey, boIdentity);
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
    const one = identity();
    const two = identity();
    await id.takeRecords([...eventRecords(ws.id, one), ...eventRecords(ws.id, two), vouchFor(ws.id, key, one, 'One')]);
    expect((await id.personOf(hex(key)))?.name).toBe('One');
    await id.takeRecords([vouchFor(ws.id, key, two, 'Two')]);
    expect(await id.personOf(hex(key))).toBeNull();
  });

  it('an identity recovered: its old key’s word counts only for the keys the recovery kept, on every device alike', async () => {
    const { id } = repo();
    const ws = await id.found();
    await id.addMember(hex(bo), 'bo');
    const bo1 = identity();
    const laptop = crypto.keyPair();
    const desk = crypto.keyPair();
    const thief = crypto.keyPair();
    await id.takeRecords([...eventRecords(ws.id, bo1), vouchFor(ws.id, laptop, bo1, 'Bo'), vouchFor(ws.id, desk, bo1, 'Bo')]);
    expect((await id.people())[0]!.keys.sort()).toEqual([hex(laptop), hex(desk)].sort());
    // Bo's identity key is stolen: the thief vouches for a key of their own, and renames him, dated far ahead.
    await id.takeRecords([vouchFor(ws.id, thief, bo1, 'Bo'), vouchFor(ws.id, laptop, bo1, 'Not Bo', Date.now() + 1e9)]);
    expect(await id.personOf(hex(thief))).toEqual({ key: bo1.id, name: 'Bo' });
    // Bo recovers it with his recovery key, keeping his laptop's key and his desk's.
    const next = crypto.keyPair();
    const rot = rotate(bo1.events, bo1.recovery, next, [hex(laptop), hex(desk)]);
    const bo2 = { id: bo1.id, key: bo1.recovery, recovery: next, events: [...bo1.events, rot] };
    // The thief cannot recover it: the recovery key is not theirs.
    expect(() => rotate(bo1.events, thief, crypto.keyPair(), [hex(thief)])).toThrow('not the recovery key');
    await id.takeRecords([...eventRecords(ws.id, bo2), vouchFor(ws.id, laptop, bo2, 'Bo')]);
    // The thief's key is no one's; Bo's keys stay his, and his own name (said with his key now) wins over the thief's.
    expect(await id.personOf(hex(thief))).toBeNull();
    expect(await id.personOf(hex(laptop))).toEqual({ key: bo1.id, name: 'Bo' });
    expect(await id.personOf(hex(desk))).toEqual({ key: bo1.id, name: 'Bo' });
    // What the old key says from now on counts for nothing it did not keep.
    const later = crypto.keyPair();
    await id.takeRecords([vouchFor(ws.id, later, bo1, 'Bo'), revokeFor(ws.id, desk, bo1)]);
    expect(await id.personOf(hex(later))).toBeNull();
    expect(await id.personOf(hex(desk))).toEqual({ key: bo1.id, name: 'Bo' });
    // His key now revokes, as before.
    await id.takeRecords([revokeFor(ws.id, desk, bo2)]);
    expect(await id.personOf(hex(desk))).toBeNull();
  });

  it('an identity: made, exported, imported on another computer, vouching there for that computer’s key', async () => {
    const one = join(mkdtempSync(join(tmpdir(), 'kuraa-person-')), 'person.json');
    const two = join(mkdtempSync(join(tmpdir(), 'kuraa-person-')), 'person.json');
    const made = await createPerson('Ada Lovelace', one);
    await expect(createPerson('Ada again', one)).rejects.toThrow('already');
    expect(exportPerson(made)).toMatch(/^kuraa-id:/);
    const there = await importPerson(exportPerson(made), two);
    // Only kuraa-id: lines.
    await expect(importPerson(exportPerson(made).replace(/^kuraa-id:/, 'kuraa-person:'), two)).rejects.toThrow('Not an identity');
    expect(there.publicKey.equals(made.publicKey)).toBe(true);
    expect(there.id).toBe(made.id);
    expect((await readPerson(two))?.name).toBe('Ada Lovelace');
    const { id } = repo();
    await id.found();
    const key = crypto.keyPair();
    await id.signsWith(key);
    await id.vouch(made, key);
    await id.vouch(made, key);
    const me = hex(await id.deviceKey());
    expect(await id.personOf(me)).toEqual({ key: made.id, name: 'Ada Lovelace' });
    expect((await id.records()).filter((r) => r.kind === 'vouch')).toHaveLength(1);
    expect((await id.records()).filter((r) => r.kind === 'key-event')).toHaveLength(1);
  });
});

describe('a workspace’s policy, on a device (0066)', () => {
  it('a workspace from before: written down with everyone it knows of an admin; the first admin change seals it', async () => {
    const { id } = repo();
    const ws = await id.found();
    await id.addMember(hex(bo), 'bo');
    const me = identity();
    const boId = identity();
    const myKey = crypto.keyPair();
    const boKey = crypto.keyPair();
    // Bo's device signs with his key, which his identity vouched for; this device with Ada's.
    await id.takeRecords([...eventRecords(ws.id, boId), signRecord({ kind: 'signs', workspace: ws.id, subject: hex(boKey), proof: sign(signsMessage(hex(bo)), boKey) }, bo), vouchFor(ws.id, boKey, boId, 'Bo')]);
    const ada = { name: 'Ada', ...me.key, id: me.id, events: me.events };
    await id.signsWith(myKey);
    await id.vouch(ada, myKey);
    expect((await id.policy()).founded).toBe(false);
    await id.ensureGenesis(me.id, myKey, false);
    await id.ensureGenesis(me.id, myKey, false);
    const policy = await id.policy();
    expect(await id.pin()).toBeNull();
    expect(policy.people().map((p) => p.role)).toEqual(['admin', 'admin']);
    expect(policy.isAdmin(boId.id)).toBe(true);
    expect(await id.mayManage(hex(bo))).toBe(true);
    // Ada makes Bo a member: the legacy geneses are sealed first, then Bo's role changes.
    await id.adminOp({ t: 'grant', group: 'workspace', who: boId.id, role: 'member' }, myKey);
    const after = await id.policy();
    expect(after.sealed).toBe(true);
    expect(after.role(boId.id)).toBe('member');
    expect(await id.mayManage(hex(bo))).toBe(false);
    // Bo's device's removals now wait for an admin's word.
    const removal = signRecord({ kind: 'remove', workspace: ws.id, subject: hex(cy) }, bo);
    expect(await id.takeRecords([removal])).toEqual([]);
  });
});

describe('cutoffs for keys no longer a person’s (0066, step 4)', () => {
  it('a key dropped when its identity was recovered is found, and once revoked with the commits seen, is cut there', async () => {
    const { id } = repo();
    const ws = await id.found();
    await id.addMember(hex(bo), 'bo');
    const bo1 = identity();
    const laptop = crypto.keyPair();
    const stolen = crypto.keyPair();
    await id.takeRecords([...eventRecords(ws.id, bo1), vouchFor(ws.id, laptop, bo1, 'Bo'), vouchFor(ws.id, stolen, bo1, 'Bo')]);
    // Recovered, keeping only the laptop's key.
    const next = crypto.keyPair();
    const bo2 = { id: bo1.id, key: bo1.recovery, recovery: next, events: [...bo1.events, rotate(bo1.events, bo1.recovery, next, [hex(laptop)])] };
    await id.takeRecords(eventRecords(ws.id, bo2));
    expect(await id.droppedKeys(bo1.id)).toEqual([hex(stolen)]);
    expect((await id.cutKeys()).size).toBe(0);
    const heads = ['cd'.repeat(20)];
    await id.takeRecords([signRecord({ kind: 'revoke-key', workspace: ws.id, subject: hex(stolen), person: bo1.id, personKey: hex(bo2.key), proof: sign(revokeKeyMessage(hex(stolen)), bo2.key), heads }, bo)]);
    expect(await id.droppedKeys(bo1.id)).toEqual([]);
    expect(await id.cutKeys()).toEqual(new Map([[hex(stolen), { person: bo1.id, heads }]]));
    // A cutoff's heads are signed with the record: changed after, not a record.
    const r = (await id.records()).find((x) => x.kind === 'revoke-key')!;
    expect(readRecord({ ...r, heads: ['ef'.repeat(20)] })).toBeNull();
  });
});

describe('trustees (0066, step 6)', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'kuraa-person-')), 'person.json');

  it('replace a lost identity’s key together, as many as it takes; a workspace counts it by their keys', async () => {
    const [boFile, adaFile, cyFile, deeFile, newFile] = [file(), file(), file(), file(), file()];
    const boP = await createPerson('Bo', boFile);
    const adaP = await createPerson('Ada', adaFile);
    const cyP = await createPerson('Cy', cyFile);
    await createPerson('Dee', deeFile);
    // Bo names Ada and Cy, any two of them (with his recovery key, as a recovery does).
    const named = await nameTrustees((await recoveryLine(boFile))!, { threshold: 2, ids: [adaP.id, cyP.id] }, [], boFile);
    expect(trusteesOf(named)).toEqual({ threshold: 2, ids: [adaP.id, cyP.id].sort() });
    // Both his keys are lost. On a new computer, he asks them.
    const { line, trustees } = await askTrustees(named.events, 'Bo', [], newFile);
    expect(trustees.threshold).toBe(2);
    expect(readTrusteeAsk(line)).toMatchObject({ name: 'Bo', id: boP.id });
    const fromAda = await vouchForAsk(line, adaFile);
    await expect(vouchForAsk(line, deeFile)).rejects.toThrow('not one of Bo’s trustees');
    await expect(completeTrustees([fromAda], newFile)).rejects.toThrow('It takes 2');
    const fromCy = await vouchForAsk(line, cyFile);
    const back = await completeTrustees([fromAda, fromCy], newFile);
    expect(back.id).toBe(boP.id);
    expect(await recoveryState(newFile)).toBe('here');
    // A workspace that knows Ada's and Cy's logs counts it; one that knew of other keys for them would not.
    const { id } = repo();
    const ws = await id.found();
    await id.addMember(hex(bo), 'bo');
    const events = (p: { id: string; events: KeyEvent[] }) => p.events.map((e) => signRecord({ kind: 'key-event', workspace: ws.id, subject: p.id, event: e }, bo));
    await id.takeRecords([...events(adaP), ...events(cyP), ...events(back)]);
    expect((await id.identityState(boP.id))!.current).toBe(back.publicKey.toString('hex'));
    const { id: other } = repo();
    const ws2 = await other.found();
    await other.addMember(hex(bo), 'bo');
    await other.takeRecords(back.events.map((e) => signRecord({ kind: 'key-event', workspace: ws2.id, subject: boP.id, event: e }, bo)));
    // Without the trustees' logs, the trustee rotation waits: Bo's key there is the one he named trustees with.
    expect((await other.identityState(boP.id))!.current).toBe(named.publicKey.toString('hex'));
  });
});

describe('recovering an identity', () => {
  const file = () => join(mkdtempSync(join(tmpdir(), 'kuraa-person-')), 'person.json');

  it('keeps the recovery key beside the identity until it is saved elsewhere, then removes it', async () => {
    const f = file();
    await createPerson('Ada', f);
    expect(await recoveryState(f)).toBe('here');
    const line = await recoveryLine(f);
    expect(line).toMatch(/^kuraa-recovery:/);
    expect(readRecoveryLine(line!)).toEqual({ id: (await readPerson(f))!.id, name: 'Ada' });
    await recoverySaved(f);
    expect(await recoveryState(f)).toBe('saved');
    expect(await recoveryLine(f)).toBeNull();
    await expect(recoverySaved(f)).rejects.toThrow('not on this computer');
  });

  it('on another computer: the same identity, its recovery key its key now, a new recovery key made; once only', async () => {
    const first = file();
    const made = await createPerson('Ada', first);
    const line = (await recoveryLine(first))!;
    // The first computer is lost. On a new one, with an identity of its own made for it:
    const second = file();
    const own = await createPerson('Ada (new laptop)', second);
    const kept = '11'.repeat(32);
    const p = await recoverPerson(line, [kept], second);
    expect(p.id).toBe(made.id);
    expect(p.name).toBe('Ada');
    expect(p.events).toHaveLength(2);
    expect(p.events[1]).toMatchObject({ t: 'rot', keep: [kept] });
    expect((await readPerson(second))?.id).toBe(made.id);
    // The identity made for it, and its unsaved recovery key, are kept aside, not lost.
    const aside = readdirSync(dirname(second));
    expect(aside.some((n) => n.startsWith('person.json.replaced-'))).toBe(true);
    expect(aside.some((n) => n.startsWith('recovery.json.replaced-'))).toBe(true);
    void own;
    // A new recovery key, to save.
    expect(await recoveryState(second)).toBe('here');
    expect(readRecoveryLine((await recoveryLine(second))!).id).toBe(made.id);
    // The old recovery key was used: it recovers nothing again.
    await expect(recoverPerson(line, [], second)).rejects.toThrow('not the recovery key');
    // The first computer's copy, found again, is older: copying the new one there replaces it.
    const back = await importPerson(exportPerson(p), first);
    expect(back.publicKey.equals(p.publicKey)).toBe(true);
    expect(await importPerson(exportPerson(made), first)).toMatchObject({ id: made.id, events: p.events });
  });

  it('gives an identity kept before logs one, the same for every process upgrading it at once', async () => {
    const f = file();
    const k = crypto.keyPair();
    writeFileSync(f, JSON.stringify({ name: 'Old', publicKey: hex(k), secretKey: k.secretKey.toString('hex') }));
    const [a, b] = await Promise.all([readPerson(f), readPerson(f)]);
    expect(a!.id).toBe(b!.id);
    expect(a!.publicKey.equals(k.publicKey)).toBe(true);
    expect((await readPerson(f))!.id).toBe(a!.id);
    expect(await recoveryState(f)).toBe('here');
    // Lines copied by an older kuraa (no log) are refused, to be copied again.
    const old = `kuraa-id:${Buffer.from(JSON.stringify({ name: 'Old', secretKey: k.secretKey.toString('hex') })).toString('base64url')}`;
    await expect(importPerson(old, file())).rejects.toThrow('older kuraa');
  });
});

interface TestIdentity { id: string; key: ReturnType<typeof crypto.keyPair>; recovery: ReturnType<typeof crypto.keyPair>; events: KeyEvent[] }

function identity(): TestIdentity {
  const key = crypto.keyPair();
  const recovery = crypto.keyPair();
  const icp = incept(key, recovery);
  return { id: identityId(icp), key, recovery, events: [icp] };
}

/** An identity's events on record, as Bo's device passes them on. */
const eventRecords = (ws: string, p: TestIdentity) => p.events.map((e) => signRecord({ kind: 'key-event', workspace: ws, subject: p.id, event: e }, bo));

function vouchFor(ws: string, key: { publicKey: Buffer; secretKey: Buffer }, p: Pick<TestIdentity, 'id' | 'key'>, name: string, at?: number) {
  const m = vouchMessage(hex(key), p.id, name);
  return signRecord({ kind: 'vouch', workspace: ws, subject: hex(key), person: p.id, personKey: hex(p.key), name, proof: sign(m, p.key), keyProof: sign(m, key), at }, bo);
}

const revokeFor = (ws: string, key: { publicKey: Buffer }, p: TestIdentity) =>
  signRecord({ kind: 'revoke-key', workspace: ws, subject: hex(key), person: p.id, personKey: hex(p.key), proof: sign(revokeKeyMessage(hex(key)), p.key) }, bo);

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

  it('commit a file moved into a folder, though the index has already let go of where it was', async () => {
    // A move as the host makes one: the file renamed, both paths staged, then committed (signed when syncing).
    const { dir, git } = repo();
    execFileSync('git', ['config', 'user.name', 'Ada'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'ada@example.org'], { cwd: dir });
    const tmp = join(dir, '.git', 'kuraa', 'tmp');
    writeFileSync(join(dir, 'name.md'), '# Name\n');
    await commitSigned(git, ['name.md'], 'Create name.md', ada, tmp);
    mkdirSync(join(dir, 'sub'));
    renameSync(join(dir, 'name.md'), join(dir, 'sub', 'name.md'));
    await git.stage(['name.md', 'sub/name.md']);
    await commitSigned(git, ['name.md', 'sub/name.md'], 'Move name.md to sub/', ada, tmp);
    expect(await git.out(['ls-tree', '-r', '--name-only', 'HEAD'])).toBe('sub/name.md');
    expect(await git.out(['status', '--porcelain'])).toBe('');
    // A file staged but never committed, moved away: nothing of it is left behind.
    writeFileSync(join(dir, 'draft.md'), 'draft\n');
    await git.run(['add', '--', 'draft.md']);
    renameSync(join(dir, 'draft.md'), join(dir, 'sub', 'draft.md'));
    await git.stage(['draft.md', 'sub/draft.md']);
    await commitSigned(git, ['draft.md', 'sub/draft.md'], 'Move draft.md to sub/', ada, tmp);
    expect((await git.out(['ls-tree', '-r', '--name-only', 'HEAD'])).split('\n')).toEqual(['sub/draft.md', 'sub/name.md']);
    expect(await git.out(['status', '--porcelain'])).toBe('');
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
