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
import { createPerson, exportPerson, importPerson, readPerson, readRecoveryLine, recoverPerson, recoveryLine, recoverySaved, recoveryState } from '../src/peers/person.js';
import { eventHash, identityId, incept, nextDigest, readEvent, resolve, rotate, type KeyEvent } from '../src/peers/kel.js';
import { makeOp, type PolicyOp } from '../src/peers/policy.js';
import { commitSigned, commitSigner, sshPublicKey, writeAllowedSigners } from '../src/signing.js';

const WS = 'ab'.repeat(16);
const ada = crypto.keyPair();
const bo = crypto.keyPair();
const cy = crypto.keyPair();
const hex = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');

const standing = (over: Partial<Standing> = {}): Standing => ({
  workspace: WS, self: hex(ada), members: new Set([hex(bo), hex(cy)]), removed: new Set(), managers: null, ...over,
});

describe('signed records', () => {
  it('are taken only as signed, for this workspace; those not signed in themselves, only from a device in it', () => {
    const r = signRecord({ kind: 'secret', workspace: WS, subject: 'ee'.repeat(32) }, bo);
    expect(readRecord(JSON.parse(JSON.stringify(r)))).toEqual(r);
    // Changed after signing: not a record.
    expect(readRecord({ ...r, subject: 'ff'.repeat(32) })).toBeNull();
    expect(judge(r, standing())).toBe('take');
    // Another workspace's, or from a device out: refused. From a device not known to be in yet: later.
    expect(judge(signRecord({ kind: 'secret', workspace: 'cd'.repeat(16), subject: 'ee'.repeat(32) }, bo), standing())).toBe('refuse');
    expect(judge(r, standing({ removed: new Set([hex(bo)]) }))).toBe('refuse');
    expect(judge(r, standing({ members: new Set() }))).toBe('wait');
    // Signed in itself (0072): a device's key, a person's word, the policy; taken from a device not known yet, which is how it comes to be known.
    const signs = signRecord({ kind: 'signs', workspace: WS, subject: hex(cy), proof: sign(signsMessage(hex(bo)), cy) }, bo);
    expect(judge(signs, standing({ members: new Set() }))).toBe('take');
  });

  it('that removed a device before (0072: none made now) are taken only from an admin’s device, or one of the same person’s (0066, 0068)', () => {
    const remove = signRecord({ kind: 'remove', workspace: WS, subject: hex(cy) }, bo);
    const secret = signRecord({ kind: 'secret', workspace: WS, subject: 'ee'.repeat(32) }, bo);
    // No policy yet: every member's word counts (0038).
    expect(judge(remove, standing())).toBe('take');
    // Bo's device is not an admin's: waiting (the policy that makes him one may come); Cy's is.
    expect(judge(remove, standing({ managers: new Set([hex(cy)]) }))).toBe('wait');
    expect(judge(remove, standing({ managers: new Set([hex(bo)]) }))).toBe('take');
    // A person removes their own computer, admin or not (0068): Bo's device removes Cy's only if both are the same person's.
    expect(judge(remove, standing({ managers: new Set(), persons: new Map([[hex(bo), 'p1'], [hex(cy), 'p1']]) }))).toBe('take');
    expect(judge(remove, standing({ managers: new Set(), persons: new Map([[hex(bo), 'p1'], [hex(cy), 'p2']]) }))).toBe('wait');
    // An admin's computer (Cy's): an admin removes it only as the owner (0070).
    expect(judge(remove, standing({ managers: new Set([hex(bo), hex(cy)]), adminDevices: new Set([hex(bo), hex(cy)]), assigners: new Set() }))).toBe('wait');
    expect(judge(remove, standing({ managers: new Set([hex(bo), hex(cy)]), adminDevices: new Set([hex(bo), hex(cy)]), assigners: new Set([hex(bo)]) }))).toBe('take');
    // The new secret that goes with a removal is any member's to make.
    expect(judge(secret, standing({ managers: new Set([hex(cy)]), persons: new Map([[hex(bo), 'p1']]) }))).toBe('take');
    // But a person's device's: not a server's, which is no one's (0099).
    expect(judge(secret, standing({ managers: new Set([hex(cy)]), persons: new Map([[hex(cy), 'p2']]) }))).toBe('refuse');
  });
});

describe('records a device makes about itself', () => {
  it('signing keys: a device says which it signs with, with that key’s word; a person vouches for theirs, and revokes them', async () => {
    const { id } = repo();
    const ws = await id.found();
    await id.addRemote(hex(bo), 'bo');
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
    await id.addRemote(hex(bo), 'bo');
    const key = crypto.keyPair();
    const one = identity();
    const two = identity();
    await id.takeRecords([...eventRecords(ws.id, one), ...eventRecords(ws.id, two), vouchFor(ws.id, key, one, 'One')]);
    expect((await id.personOf(hex(key)))?.name).toBe('One');
    await id.takeRecords([vouchFor(ws.id, key, two, 'Two')]);
    expect(await id.personOf(hex(key))).toBeNull();
  });

  it('a key that signed a server’s join is no person’s, whatever vouches for it (0112)', async () => {
    const { id } = repo();
    const ws = await id.found();
    await id.addRemote(hex(bo), 'bo');
    const serverKey = crypto.keyPair();
    // Its join as a server, as the server signs it (whether it counts is the policy's to say).
    const join = makeOp(ws.id, { t: 'join', group: 'workspace', role: 'server', link: '0123456789abcdef', once: true, granter: hex(ada), grant: 'cd'.repeat(64), expires: 0, issuer: 'ee'.repeat(32) }, [], serverKey);
    await id.takeRecords([signRecord({ kind: 'policy', workspace: ws.id, subject: join.id, op: join.op, parents: join.parents, signer: join.signer, proof: join.proof }, bo)]);
    // An identity of the server's own making vouches for its key: still no one's.
    const made = identity();
    await id.takeRecords([...eventRecords(ws.id, made), vouchFor(ws.id, serverKey, made, 'Ana')]);
    expect(await id.personOf(hex(serverKey))).toBeNull();
    // A key that signed no such join, vouched for in the same way: that identity's.
    const other = crypto.keyPair();
    await id.takeRecords([vouchFor(ws.id, other, made, 'Ana')]);
    expect((await id.personOf(hex(other)))?.name).toBe('Ana');
  });

  it('an identity recovered: its old key’s word counts only for the keys the recovery kept, on every device alike', async () => {
    const { id } = repo();
    const ws = await id.found();
    await id.addRemote(hex(bo), 'bo');
    const bo1 = identity();
    const laptop = crypto.keyPair();
    const desk = crypto.keyPair();
    const thief = crypto.keyPair();
    // Bo's device signs with the laptop's key: what it says of Bo's keys (revocations) is Bo's (0071).
    await id.takeRecords([...eventRecords(ws.id, bo1), signsWith(ws.id, laptop), vouchFor(ws.id, laptop, bo1, 'Bo'), vouchFor(ws.id, desk, bo1, 'Bo')]);
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
  /**
   * A workspace from before 0066 on two devices, as a kuraa from before left it (0078): Ada's legacy
   * genesis naming Ada and Bo, sealed by Ada (so its owner), a rule, and Cy a member. Each device then
   * works it out the one last time (legacy-last.json).
   */
  async function legacyPair(sealed = true) {
    const a = repo();
    const ws = await a.id.found();
    const b = repo();
    await b.id.adopt(ws);
    const [adaP, boP, cyP] = [identity(), identity(), identity()];
    const [adaKey, boKey] = [crypto.keyPair(), crypto.keyPair()];
    const people = [...eventRecords(ws.id, adaP), ...eventRecords(ws.id, boP), ...eventRecords(ws.id, cyP), signsWith(ws.id, boKey), vouchFor(ws.id, boKey, boP, 'Bo')];
    await a.id.signsWith(adaKey);
    await a.id.vouch({ name: 'Ada', ...adaP.key, id: adaP.id, events: adaP.events }, adaKey);
    await a.id.addRemote(hex(bo), 'bo');
    await a.id.takeRecords(people);
    const ops: PolicyOp[] = [];
    const g = makeOp(ws.id, { t: 'genesis', admins: [adaP.id, boP.id].sort(), legacy: true }, [], adaKey);
    let last = g.id;
    const write = async (op: PolicyOp) => {
      const e = op.t === 'genesis' ? g : makeOp(ws.id, op, [last], adaKey);
      last = e.id;
      ops.push(op);
      await a.id.decide('policy', e.id, { op: e.op, parents: e.parents, signer: e.signer, proof: e.proof });
    };
    await write(g.op);
    if (sealed) await write({ t: 'seal', geneses: [g.id] });
    await write({ t: 'grant', group: 'workspace', who: cyP.id, role: 'member' });
    await write({ t: 'rule', path: 'secret/', by: ['admins'] });
    // Both devices hold the same records, and work the legacy policy out the one last time, as they start.
    await b.id.addRemote(hex(ada), 'ada');
    await b.id.takeRecords(await a.id.records());
    for (const d of [a, b]) rmSync(join(d.dir, '.git', 'kuraa', 'legacy-last.json'), { force: true });
    writeFileSync(join(a.dir, '.git', 'kuraa', 'legacy.json'), JSON.stringify({ geneses: [g.id], seal: null }));
    return { a, b, ws, adaP, boP, cyP, adaKey, boKey };
  }

  it('a workspace from before 0066 keeps to its last legacy policy, and changes nothing, until its owner founds it again; every device then pins to that (0078)', async () => {
    const { a, b, adaP, boP, cyP, adaKey, boKey } = await legacyPair();
    for (const d of [a, b]) {
      const p = await d.id.policy();
      expect(p.founded).toBe(true);
      expect(p.owner).toBe(adaP.id);
      expect(p.role(boP.id)).toBe('admin');
      expect(p.role(cyP.id)).toBe('member');
      expect(p.mayWrite(cyP.id, 'secret/x.md')).toBe(false);
      expect(await d.id.mayRefound(adaP.id)).toBe(true);
      expect(await d.id.mayRefound(boP.id)).toBe(false);
    }
    // The last working out kept; legacy.json gone.
    expect(existsAt(a.dir, 'legacy-last.json')).toBe(true);
    expect(existsAt(a.dir, 'legacy.json')).toBe(false);
    // Nothing about who is in or what they may do changes meanwhile.
    await expect(a.id.adminOp({ t: 'grant', group: 'workspace', who: cyP.id, role: 'admin' }, adaKey)).rejects.toThrow('found it again');
    await expect(a.id.createLink(1, true, { relays: [], tcp: [] }, { key: adaKey })).rejects.toThrow('found it again');
    // Bo, an admin but not the owner, may not found it again; one he makes anyway is taken by no device.
    await expect(b.id.refound(boP.id, boKey)).rejects.toThrow('owner');
    const rogue = makeOp((await a.id.workspace())!.id, { t: 'genesis', admins: [boP.id], legacy: false }, [], boKey);
    await a.id.takeRecords([signRecord({ kind: 'policy', workspace: (await a.id.workspace())!.id, subject: rogue.id, op: rogue.op, parents: [], signer: rogue.signer, proof: rogue.proof }, bo)]);
    expect(await a.id.pin()).toBeNull();
    // Ada founds it again: a pinned genesis naming her, everyone and every rule put back.
    const genesis = await a.id.refound(adaP.id, adaKey);
    expect(await a.id.pin()).toBe(genesis);
    await b.id.takeRecords(await a.id.records());
    expect(await b.id.pin()).toBe(genesis);
    for (const d of [a, b]) {
      const p = await d.id.policy();
      expect(p.geneses).toEqual([genesis]);
      expect(p.owner).toBe(adaP.id);
      expect(p.role(boP.id)).toBe('admin');
      expect(p.role(cyP.id)).toBe('member');
      expect(p.ruleFor('secret/x.md')?.by).toEqual(['admins']);
      expect(await d.id.legacySnapshot()).toBeNull();
    }
    // And now it changes as any workspace does.
    await a.id.adminOp({ t: 'grant', group: 'workspace', who: cyP.id, role: 'admin' }, adaKey);
    expect((await a.id.policy()).role(cyP.id)).toBe('admin');
  });

  it('a workspace from before with no owner (never sealed): any of its admins may found it again, and becomes its owner', async () => {
    const { a, b, boP, cyP, boKey } = await legacyPair(false);
    expect((await b.id.policy()).owner).toBeNull();
    expect(await b.id.mayRefound(boP.id)).toBe(true);
    expect(await b.id.mayRefound(cyP.id)).toBe(false);
    // Bo's device says who it is, then founds it again.
    await b.id.signsWith(boKey);
    await b.id.vouch({ name: 'Bo', ...boP.key, id: boP.id, events: boP.events }, boKey);
    const genesis = await b.id.refound(boP.id, boKey);
    await a.id.takeRecords(await b.id.records());
    expect(await a.id.pin()).toBe(genesis);
    expect((await a.id.policy()).owner).toBe(boP.id);
    expect((await a.id.policy()).role(cyP.id)).toBe('member');
  });
});

describe('clashes, on a device (0078)', () => {
  it('are said in words, and the one that lost is made again on purpose, after both', async () => {
    const { id } = repo();
    const { ws, me, myKey } = await founded(id);
    const b = inRecords(ws.id, bo, 'Bo');
    const c = inRecords(ws.id, cy, 'Cy');
    await id.takeRecords([...b.records, ...c.records]);
    await id.adminOp({ t: 'grant', group: 'workspace', who: b.person.id, role: 'admin' }, myKey);
    await id.adminOp({ t: 'grant', group: 'workspace', who: c.person.id, role: 'member' }, myKey);
    const base = (await id.policy()).heads;
    // Bo takes Cy out as Ada, on another computer of hers that had not heard of it, makes Cy an admin.
    const out = makeOp(ws.id, { t: 'revoke', group: 'workspace', who: c.person.id }, base, b.key);
    const up = makeOp(ws.id, { t: 'grant', group: 'workspace', who: c.person.id, role: 'admin' }, base, myKey);
    const record = (e: typeof out) => signRecord({ kind: 'policy', workspace: ws.id, subject: e.id, op: e.op, parents: e.parents, signer: e.signer, proof: e.proof }, bo);
    await id.takeRecords([record(out), record(up)]);
    const policy = await id.policy();
    expect(policy.role(c.person.id)).toBeNull();
    expect(policy.clashes).toEqual([{ lost: up.id, won: out.id, why: 'less' }]);
    const { clashWords } = await import('../src/peers/clashes.js');
    const names = new Map([[me.id, 'Ada'], [b.person.id, 'Bo'], [c.person.id, 'Cy']]);
    const [said] = await clashWords(policy, await id.policyEntries(), (k) => id.personOfKey(k), names, me.id, (k) => k);
    expect(said).toMatchObject({ lost: up.id, redo: true, words: 'You made Cy an admin while Bo took Cy out: Cy is out' });
    // Bo, an admin but not the owner, may not make Cy an admin again.
    expect((await clashWords(policy, await id.policyEntries(), (k) => id.personOfKey(k), names, b.person.id, (k) => k))[0]!.redo).toBe(false);
    await id.redo(up.id, myKey, []);
    expect((await id.policy()).role(c.person.id)).toBe('admin');
    await expect(id.redo('ab'.repeat(32), myKey, [])).rejects.toThrow('No such change');
  });
});

describe('records of kinds no longer made (0078)', () => {
  it('are refused cleanly: an attestation, a trustee rotation; a rotation from before naming trustees is read as it was signed', () => {
    // An attestation, as an older device would pass one on.
    const attestation = { v: 1, id: 'aa'.repeat(32), claim: 'email:bo@uni.edu', verifier: hex(cy), at: 1, expires: 2, sig: 'ab'.repeat(64) };
    const attest = signRecord({ kind: 'attest' as never, workspace: WS, subject: 'aa'.repeat(32), ...({ attestation } as object) }, bo);
    expect(readRecord(JSON.parse(JSON.stringify(attest)))).toBeNull();
    expect(judge(signRecord({ kind: 'secret', workspace: WS, subject: 'ee'.repeat(32) }, bo), standing())).toBe('take');
    // A trustee rotation: not an event.
    const p = identity();
    const next = crypto.keyPair();
    const trot = { ...rotate(p.events, p.recovery, next, []), t: 'trot', vouches: [] };
    expect(readEvent(trot)).toBeNull();
    // A rotation that named trustees (with the recovery key, before 0078): its signature covers them; read, and they say nothing.
    const r = rotate(p.events, p.recovery, next, []);
    const trustees = { threshold: 1, ids: ['bb'.repeat(32)] };
    const body = ['kuraa-identity', 1, 'rot', r.id, r.seq, r.prior, r.key, r.next, '', 'trustees', 1, trustees.ids.join(','), r.at].join('\0');
    const named = { ...r, trustees, sig: crypto.sign(Buffer.from(body), p.recovery.secretKey).toString('hex') };
    const read = readEvent(named);
    expect(read).not.toBeNull();
    const state = resolve([...p.events, read!]);
    expect(state?.current).toBe(hex(p.recovery));
    expect(state?.events.map(eventHash)).toEqual([...p.events, named].map((e) => eventHash(e as KeyEvent)));
    expect(nextDigest(hex(next))).toBe(state?.events[1]!.next);
  });
});

describe('cutoffs for keys no longer a person’s (0066, step 4)', () => {
  it('a key dropped when its identity was recovered is found, and once revoked with the commits seen, is cut there', async () => {
    const { id } = repo();
    const ws = await id.found();
    await id.addRemote(hex(bo), 'bo');
    const bo1 = identity();
    const laptop = crypto.keyPair();
    const stolen = crypto.keyPair();
    await id.takeRecords([...eventRecords(ws.id, bo1), signsWith(ws.id, laptop), vouchFor(ws.id, laptop, bo1, 'Bo'), vouchFor(ws.id, stolen, bo1, 'Bo')]);
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

/** Bo's device says it signs with this key. */
const signsWith = (ws: string, key: { publicKey: Buffer; secretKey: Buffer }) =>
  signRecord({ kind: 'signs', workspace: ws, subject: hex(key), proof: sign(signsMessage(hex(bo)), key) }, bo);

const revokeFor = (ws: string, key: { publicKey: Buffer }, p: TestIdentity) =>
  signRecord({ kind: 'revoke-key', workspace: ws, subject: hex(key), person: p.id, personKey: hex(p.key), proof: sign(revokeKeyMessage(hex(key)), p.key) }, bo);

const existsAt = (dir: string, file: string) => {
  try {
    statSync(join(dir, '.git', 'kuraa', file));
    return true;
  } catch {
    return false;
  }
};

function repo(): { dir: string; git: Git; id: Identity } {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-records-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  const git = new Git(dir);
  return { dir, git, id: new Identity(git, join(dir, '.git', 'kuraa')) };
}

/** A workspace this device made, with a policy: Ada (this device's person) its owner. */
async function founded(id: Identity) {
  const ws = await id.found();
  const me = identity();
  const myKey = crypto.keyPair();
  await id.signsWith(myKey);
  await id.vouch({ name: 'Ada', ...me.key, id: me.id, events: me.events }, myKey);
  await id.ensureGenesis(me.id, myKey, true);
  return { ws, me, myKey };
}

/** What makes a device in (0072): it signs with a key its person vouched for, and the person is in the policy. All signed in themselves, passed on by `device`. */
function inRecords(ws: string, device: typeof bo, name: string) {
  const p = identity();
  const key = crypto.keyPair();
  const m = vouchMessage(hex(key), p.id, name);
  return {
    person: p,
    key,
    records: [
      ...p.events.map((e) => signRecord({ kind: 'key-event', workspace: ws, subject: p.id, event: e }, device)),
      signRecord({ kind: 'signs', workspace: ws, subject: hex(key), proof: sign(signsMessage(hex(device)), key), name: name.toLowerCase() }, device),
      signRecord({ kind: 'vouch', workspace: ws, subject: hex(key), person: p.id, personKey: hex(p.key), name, proof: sign(m, p.key), keyProof: sign(m, key) }, device),
    ],
  };
}

describe('a device and its records', () => {
  it('has in it the devices whose people the policy has in it; a device dropped is out (0072)', async () => {
    const { id } = repo();
    const { ws, myKey } = await founded(id);
    const b = inRecords(ws.id, bo, 'Bo');
    await id.takeRecords(b.records);
    // Bo's device says who it is, but Bo is not in the workspace yet: neither in nor out.
    expect(await id.members()).toEqual([]);
    expect(await id.removed()).toEqual([]);
    await id.adminOp({ t: 'grant', group: 'workspace', who: b.person.id, role: 'member' }, myKey);
    expect((await id.members()).map((m) => [m.name, m.key])).toEqual([['bo', hex(bo)]]);
    // Bo's computer dropped (an admin's to do): out, and its remote gone.
    await id.dropKey(hex(b.key), [], myKey);
    expect(await id.members()).toEqual([]);
    expect(await id.removed()).toEqual([hex(bo)]);
    expect((await id.remotes()).map((m) => m.key)).toEqual([]);
    // Bo is still in the workspace: a computer of his that his identity vouches for is in.
    const desk = crypto.keyPair();
    const deskKey = crypto.keyPair();
    const m = vouchMessage(hex(deskKey), b.person.id, 'Bo');
    await id.takeRecords([
      signRecord({ kind: 'signs', workspace: ws.id, subject: hex(deskKey), proof: sign(signsMessage(hex(desk)), deskKey), name: 'desk' }, desk),
      signRecord({ kind: 'vouch', workspace: ws.id, subject: hex(deskKey), person: b.person.id, personKey: hex(b.person.key), name: 'Bo', proof: sign(m, b.person.key), keyProof: sign(m, deskKey) }, desk),
    ]);
    expect((await id.members()).map((x) => x.name)).toEqual(['desk']);
  });

  it('takes records in any order: one from a device, and those that show it to be in', async () => {
    const { id } = repo();
    const { ws, myKey } = await founded(id);
    const c = inRecords(ws.id, cy, 'Cy');
    await id.takeRecords(c.records);
    // Cy's link revoked, by Cy's device, arriving before Cy is in: waits, then taken once Cy is.
    const fromCy = signRecord({ kind: 'revoke-link', workspace: ws.id, subject: 'ab'.repeat(8) }, cy);
    expect(await id.takeRecords([fromCy])).toEqual([]);
    await id.adminOp({ t: 'grant', group: 'workspace', who: c.person.id, role: 'member' }, myKey);
    expect((await id.takeRecords([fromCy])).map((r) => r.kind)).toEqual(['revoke-link']);
    // Taken out of the workspace: Cy's devices are out with him, and nothing more is taken from them.
    await id.adminOp({ t: 'revoke', group: 'workspace', who: c.person.id }, myKey);
    expect(await id.removed()).toEqual([hex(cy)]);
    expect(await id.takeRecords([signRecord({ kind: 'secret', workspace: ws.id, subject: 'cd'.repeat(32) }, cy)])).toEqual([]);
  });

  it('makes the remotes what the records say, if git config was held by another writer, before its next change', async () => {
    const { dir, id } = repo();
    const { ws, myKey } = await founded(id);
    const b = inRecords(ws.id, bo, 'Bo');
    await id.takeRecords(b.records);
    // Another writer holds .git/config for longer than git.ts waits: Bo is in, but has no remote yet.
    writeFileSync(join(dir, '.git', 'config.lock'), '');
    await id.adminOp({ t: 'grant', group: 'workspace', who: b.person.id, role: 'member' }, myKey);
    expect(await id.members()).toEqual([]);
    // Let go of: the next change makes it first, though nothing in it is new.
    rmSync(join(dir, '.git', 'config.lock'));
    expect(await id.takeRecords(b.records)).toEqual([]);
    expect((await id.members()).map((m) => m.name)).toEqual(['bo']);
    // A removal from before, on record but not in the config (stopped in between), is applied when the device starts (reconcile).
    const remove = signRecord({ kind: 'remove', workspace: ws.id, subject: hex(bo) }, await id.deviceKey());
    const file = join(dir, '.git', 'kuraa', 'records.json');
    writeFileSync(file, JSON.stringify([...JSON.parse(readFileSync(file, 'utf8')), remove]));
    await id.reconcile();
    expect(await id.removed()).toEqual([hex(bo)]);
    expect(await id.members()).toEqual([]);
  }, 30_000);

  it('keeps what a key revoked signed of the policy before, and nothing after (0072)', async () => {
    const { id } = repo();
    const { ws, me, myKey } = await founded(id);
    const b = inRecords(ws.id, bo, 'Bo');
    await id.takeRecords(b.records);
    await id.adminOp({ t: 'grant', group: 'workspace', who: b.person.id, role: 'admin' }, myKey);
    // Ada's laptop (myKey) is lost: she revokes its key, with the policy as she has it.
    await id.revokeKey(me.id, hex(me.key), hex(myKey), sign(revokeKeyMessage(hex(myKey)), me.key));
    const policy = await id.policy();
    // What it signed before still counts: Bo is still an admin, Ada still the owner.
    expect(policy.role(b.person.id)).toBe('admin');
    expect(policy.owner).toBe(me.id);
    // Whoever has the laptop signs more: it counts for nothing.
    const thief = await id.makePolicy({ t: 'grant', group: 'workspace', who: identity().id, role: 'member' }, myKey);
    expect((await id.policy()).applied).not.toContain(thief);
  });

  it('tells a device joining which devices are in, from the records it is sent, under the genesis it holds (0072)', async () => {
    const { id } = repo();
    const { ws, myKey } = await founded(id);
    const b = inRecords(ws.id, bo, 'Bo');
    await id.takeRecords(b.records);
    await id.adminOp({ t: 'grant', group: 'workspace', who: b.person.id, role: 'member' }, myKey);
    const records = await id.records();
    // A device joining holds the genesis its link names, and nothing else.
    const joiner = repo().id;
    await joiner.setPin((await id.pin())!);
    const self = hex(await id.deviceKey());
    expect([...(await joiner.devicesIn(records, ws.id))].sort()).toEqual([hex(bo), self].sort());
    // Another genesis (another history of the workspace): no one.
    await joiner.setPin('ef'.repeat(32));
    expect([...(await joiner.devicesIn(records, ws.id))]).toEqual([]);
  });

  it('confirms a removal by the people whose devices acknowledge holding it (0072)', async () => {
    const { id } = repo();
    const { ws, myKey } = await founded(id);
    const b = inRecords(ws.id, bo, 'Bo');
    const c = inRecords(ws.id, cy, 'Cy');
    await id.takeRecords([...b.records, ...c.records]);
    await id.adminOp({ t: 'grant', group: 'workspace', who: b.person.id, role: 'member' }, myKey);
    await id.adminOp({ t: 'grant', group: 'workspace', who: c.person.id, role: 'member' }, myKey);
    // This device says how much of the policy it holds, once for each change.
    expect(await id.acknowledge()).toBe(true);
    expect(await id.acknowledge()).toBe(false);
    // Ada takes Bo out: no one but Ada holds it yet.
    await id.adminOp({ t: 'revoke', group: 'workspace', who: b.person.id }, myKey);
    expect(await id.confirmations()).toEqual([expect.objectContaining({ kind: 'person', who: b.person.id, confirmedBy: [] })]);
    // Cy's device acknowledges a policy that holds it: Cy confirms it.
    const ack = (heads: string[]) => signRecord({ kind: 'ack', workspace: ws.id, subject: 'ab'.repeat(32), policyHeads: heads }, cy);
    expect(readRecord(JSON.parse(JSON.stringify(ack((await id.policy()).heads))))).not.toBeNull();
    await id.takeRecords([ack((await id.policy()).heads)]);
    expect((await id.confirmations())[0]).toMatchObject({ confirmedBy: [c.person.id] });
    // An acknowledgement from a device not in the workspace (Bo's, out now) is not taken.
    expect(await id.takeRecords([signRecord({ kind: 'ack', workspace: ws.id, subject: 'cd'.repeat(32), policyHeads: (await id.policy()).heads }, bo)])).toEqual([]);
  });

  it('makes its secret anew on record, the latest counting, and keeps its records from other users of the computer', async () => {
    const { dir, git, id } = repo();
    const { ws, myKey } = await founded(id);
    const b = inRecords(ws.id, bo, 'Bo');
    await id.takeRecords(b.records);
    await id.adminOp({ t: 'grant', group: 'workspace', who: b.person.id, role: 'member' }, myKey);
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

describe('records read while they are written', () => {
  it('are never found half written: the policy stays founded while records are taken (0075)', { timeout: 60_000 }, async () => {
    const { id } = repo();
    const { ws } = await founded(id);
    const before = (await id.records()).length;
    const taking = Array.from({ length: 300 }, () => eventRecords(ws.id, identity())).flat();
    let reading = true;
    let least = Infinity;
    let unfounded = 0;
    const reader = (async () => {
      while (reading) {
        least = Math.min(least, (await id.records()).length);
        if (!(await id.policy()).founded) unfounded++;
        await new Promise((resolve) => setImmediate(resolve));
      }
    })();
    for (let i = 0; i < taking.length; i += 10) await id.takeRecords(taking.slice(i, i + 10));
    reading = false;
    await reader;
    expect(least).toBeGreaterThanOrEqual(before);
    expect(unfounded).toBe(0);
    expect((await id.records()).length).toBeGreaterThan(before);
  });
});
