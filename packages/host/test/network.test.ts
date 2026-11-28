// What the network review found, and how it is held to now (docs/decisions/0071-network-review.md):
// git served without what it hides, records compared by what they say, grants
// that sign their link's expiry, devices paired only as the admins let them be.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import { Git } from '../src/git.js';
import { Identity, decodeLink, linkProofFor } from '../src/peers/identity.js';
import { digestOf, uploadPackArgs, uploadPackEnv } from '../src/peers/node.js';
import { readHeads } from '../src/peers/link.js';
import { FUTURE_MS, judge, sign, signRecord, signsMessage, vouchMessage } from '../src/peers/records.js';
import { identityId, incept, type KeyEvent } from '../src/peers/kel.js';
import { grantMessage, makeOp } from '../src/peers/policy.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `kuraa-${name}-`));
  dirs.push(d);
  return d;
};
const hex = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');
const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

interface TestIdentity { id: string; key: ReturnType<typeof crypto.keyPair>; events: KeyEvent[] }
function identity(): TestIdentity {
  const key = crypto.keyPair();
  const icp = incept(key, crypto.keyPair());
  return { id: identityId(icp), key, events: [icp] };
}

describe('git, as a device serves it', () => {
  it('hides what a device may not read, even asked for by its commit under protocol v2', () => {
    const server = tmp('serve');
    git(server, 'init', '-q', '-b', 'main');
    git(server, 'config', 'user.name', 'T');
    git(server, 'config', 'user.email', 't@example.org');
    writeFileSync(join(server, 'open.txt'), 'everyone\n');
    git(server, 'add', '.');
    git(server, 'commit', '-q', '-m', 'open');
    // A space's commit, under refs/spaces/, unrelated to the branch.
    git(server, 'checkout', '-q', '--orphan', 'secret');
    writeFileSync(join(server, 'open.txt'), 'hidden\n');
    git(server, 'add', '.');
    git(server, 'commit', '-q', '-m', 'hidden');
    const hidden = git(server, 'rev-parse', 'HEAD');
    git(server, 'update-ref', 'refs/spaces/x/heads/main', hidden);
    git(server, 'checkout', '-q', 'main');
    git(server, 'branch', '-q', '-D', 'secret');
    // As node.ts runs it: those arguments, and no GIT_PROTOCOL (uploadPackEnv), whatever the fetching side asks for.
    const uploadPack = ['env -u GIT_PROTOCOL git', ...uploadPackArgs(['refs/spaces/']).map((a) => `'${a}'`), 'upload-pack'].join(' ');
    for (const version of ['0', '2']) {
      const client = tmp('fetch');
      git(client, 'init', '-q');
      // The commit, asked for by its id (a member may learn it from a cutoff): not sent.
      const r = spawnSync('git', ['-c', `protocol.version=${version}`, 'fetch', '-q', `--upload-pack=${uploadPack}`, `file://${server}`, hidden], { cwd: client, encoding: 'utf8' });
      expect(r.status).not.toBe(0);
      expect(spawnSync('git', ['cat-file', '-e', hidden], { cwd: client }).status).not.toBe(0);
      // The branches still come.
      git(client, '-c', `protocol.version=${version}`, 'fetch', '-q', `--upload-pack=${uploadPack}`, `file://${server}`, '+refs/heads/*:refs/remotes/s/*');
      expect(git(client, 'rev-parse', 'refs/remotes/s/main')).toBe(git(server, 'rev-parse', 'main'));
    }
  });

  it('runs upload-pack with no GIT_PROTOCOL, even one this process has', () => {
    process.env.GIT_PROTOCOL = 'version=2';
    try {
      expect(uploadPackEnv().GIT_PROTOCOL).toBeUndefined();
    } finally {
      delete process.env.GIT_PROTOCOL;
    }
  });

  it('takes branch names only as git allows them', () => {
    const oid = 'a'.repeat(40);
    expect(readHeads({ main: oid, 'feature/x': oid })).toEqual({ main: oid, 'feature/x': oid });
    for (const bad of ['a b', 'a\nb', 'a\u0000b', 'x..y', '-x', 'a:b', 'a~1', 'a^', 'a?', 'a*', 'a[', 'a\\b', '/a', 'a/', 'a//b', 'a.lock', 'a@{1}']) expect(readHeads({ [bad]: oid })).toBeNull();
  });
});

describe('records, as devices compare them', () => {
  it('one event passed on by two devices is the same records, so neither asks the other for it again and again', () => {
    const p = identity();
    const ws = 'ab'.repeat(16);
    const one = signRecord({ kind: 'key-event', workspace: ws, subject: p.id, event: p.events[0]! }, crypto.keyPair());
    const two = signRecord({ kind: 'key-event', workspace: ws, subject: p.id, event: p.events[0]! }, crypto.keyPair());
    expect(one.sig).not.toBe(two.sig);
    expect(digestOf([one])).toBe(digestOf([two]));
    // Other records, by their signature.
    const a = signRecord({ kind: 'remove', workspace: ws, subject: 'cd'.repeat(32) }, crypto.keyPair());
    expect(digestOf([one, a])).not.toBe(digestOf([one]));
  });

  it('dated far ahead of this device’s clock, waits until it no longer is', () => {
    const by = crypto.keyPair();
    const ws = 'ab'.repeat(16);
    const r = signRecord({ kind: 'secret', workspace: ws, subject: 'ee'.repeat(32), at: Date.now() + 365 * 86_400_000 }, by);
    const standing = { workspace: ws, self: 'ff'.repeat(32), members: new Set([hex(by)]), removed: new Set<string>(), managers: null };
    expect(judge(r, standing)).toBe('wait');
    expect(judge(r, { ...standing, now: r.at - FUTURE_MS + 1 })).toBe('take');
    expect(judge(signRecord({ kind: 'secret', workspace: ws, subject: 'ee'.repeat(32), at: Date.now() + 60_000 }, by), standing)).toBe('take');
  });
});

describe('invites and pairing, under a policy', () => {
  async function workspace() {
    const dir = tmp('net');
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const id = new Identity(new Git(dir), join(dir, '.git', 'kuraa'));
    const ws = await id.found();
    const ada = identity();
    const adaKey = crypto.keyPair();
    await id.signsWith(adaKey);
    await id.vouch({ name: 'Ada', ...ada.key, id: ada.id, events: ada.events }, adaKey);
    await id.ensureGenesis(ada.id, adaKey, true);
    return { id, ws, ada, adaKey };
  }

  /** A device's records of itself and its person: its key events, the key it signs with, and that key vouched for. */
  function deviceOf(ws: string, person: TestIdentity, name: string) {
    const device = crypto.keyPair();
    const signing = crypto.keyPair();
    const m = vouchMessage(hex(signing), person.id, name);
    return {
      device,
      signing,
      records: [
        ...person.events.map((e) => signRecord({ kind: 'key-event', workspace: ws, subject: person.id, event: e }, device)),
        signRecord({ kind: 'signs', workspace: ws, subject: hex(signing), proof: sign(signsMessage(hex(device)), signing) }, device),
        signRecord({ kind: 'vouch', workspace: ws, subject: hex(signing), person: person.id, personKey: hex(person.key), name, proof: sign(m, person.key), keyProof: sign(m, signing) }, device),
      ],
    };
  }

  it('a link’s grant signs when it stops letting people in and who made it: changed after, it lets no one in', async () => {
    const { id, adaKey } = await workspace();
    const l = decodeLink(await id.createLink(1, false, { relays: [], tcp: [] }, { key: adaKey }));
    expect(await id.refuseGrant(l)).toBeNull();
    // Made never to expire, or by another device: the grant no longer holds.
    expect(await id.refuseGrant({ ...l, expires: 0 })).toBe('the link is not signed by the person it names');
    expect(await id.refuseGrant({ ...l, issuer: { key: 'cd'.repeat(32), name: 'x' } })).toBe('the link is not signed by the person it names');
    // A grant from before, which signed neither: ask for a new link.
    const g = l.grant!;
    // (A link from before had no key of its own either: 0121.)
    const { linkKey: _key, ...before } = g;
    void _key;
    const old = { ...l, grant: { ...before, signature: crypto.sign(grantMessage(l.workspace.id, g.genesis, l.id, g.group, g.role, l.once), adaKey.secretKey).toString('hex') } };
    expect(await id.refuseGrant(old)).toMatch(/older kuraa/);
  });

  it('a device is in once its person came in by an admin’s grant; a member’s pairing record says nothing (0072)', async () => {
    const { id, ws, adaKey } = await workspace();
    // Bo: a member, not an admin.
    const boId = identity();
    const bo = deviceOf(ws.id, boId, 'Bo');
    await id.addRemote(hex(bo.device), 'bo');
    await id.takeRecords(bo.records);
    await id.adminOp({ t: 'grant', group: 'workspace', who: boId.id, role: 'member' }, adaKey);
    expect((await id.policy()).role(boId.id)).toBe('member');
    // Bo's device pairs a device of someone the admins never let in (a record from before 0072): it is not in.
    const mallory = deviceOf(ws.id, identity(), 'Mallory');
    const pairs = (d: typeof mallory) => signRecord({ kind: 'add', workspace: ws.id, subject: hex(d.device), name: 'new' }, bo.device);
    await id.takeRecords([pairs(mallory), ...mallory.records]);
    expect((await id.members()).map((m) => m.key)).not.toContain(hex(mallory.device));
    // Dee came in by Ada's link (her join, with its grant, signed with her key), a device in having let her in by it: her device is in.
    const deeId = identity();
    const dee = deviceOf(ws.id, deeId, 'Dee');
    const l = decodeLink(await id.createLink(1, true, { relays: [], tcp: [] }, { key: adaKey }));
    const g = l.grant!;
    // With the link's key's word that Dee's signing key is its holder's (0121).
    const joinOp = { t: 'join' as const, group: g.group, role: g.role, link: l.id, once: l.once, granter: g.granter, grant: g.signature, expires: l.expires, issuer: l.issuer.key, linkKey: g.linkKey!, linkProof: linkProofFor(l, hex(dee.signing))! };
    const record = (e: ReturnType<typeof makeOp>) => signRecord({ kind: 'policy', workspace: ws.id, subject: e.id, op: e.op, parents: e.parents, signer: e.signer, proof: e.proof }, dee.device);
    // Not let in by anyone yet: her join, with the grant alone, does not count.
    const early = makeOp(ws.id, joinOp, (await id.policy()).heads, dee.signing);
    await id.takeRecords([pairs(dee), ...dee.records, record(early)]);
    expect((await id.policy()).role(deeId.id)).toBeNull();
    await id.admit(l.id, hex(dee.signing), adaKey);
    const join = makeOp(ws.id, joinOp, (await id.policy()).heads, dee.signing);
    await id.takeRecords([record(join)]);
    expect((await id.members()).map((m) => m.key)).toContain(hex(dee.device));
    expect((await id.policy()).role(deeId.id)).toBe('member');
  });

  it('a new secret is dated after the latest on record, whatever this computer’s clock says', async () => {
    const { id } = await workspace();
    const ahead = Date.now() + 5 * 60_000;
    await id.takeRecords([]);
    await id.decide('secret', 'ee'.repeat(32), { at: ahead });
    const secret = await id.newSecret();
    expect((await id.workspace())!.secret).toBe(secret);
    expect((await id.records()).find((r) => r.kind === 'secret' && r.subject === secret)!.at).toBeGreaterThan(ahead);
  });
});
