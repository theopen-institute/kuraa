// A server in a workspace, on a local DHT (decision 0099): it joins by the owner's invite link for a
// server, as no person; holds the members' work and passes it on while they are never online at once;
// changes nothing (what it signs is kept out everywhere); and is taken out by the owner.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { createPerson, type Person } from '../src/peers/person.js';
import { joinWorkspace, startHost, type RunningHost } from '../src/index.js';

const NOTES = '# Notes\n\nThe tide was out.\n';
const FAST = { flushMs: 100, idleCommitMs: 400, maxCommitMs: 3000, dropMs: 300 };
const SLOW = Number(process.env.KURAA_TEST_SLOW ?? 1) || 1;
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

let testnet: Testnet;
const dirs: string[] = [];
const hosts: RunningHost[] = [];

beforeAll(async () => {
  testnet = await createTestnet(3);
});
afterAll(async () => {
  await testnet.destroy();
});
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms * SLOW;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `kuraa-srv-${name}-`));
  dirs.push(d);
  return d;
};

function repo(): string {
  const dir = tmp('ada');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.org');
  writeFileSync(join(dir, 'notes.md'), NOTES);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  return dir;
}

const person = async (name: string) => createPerson(name, join(tmp('person'), 'person.json'));
const log = (who: string) => (process.env.PEER_LOG ? (m: string) => console.log(`[${who}] ${m}`) : undefined);

/** A device's host: a person's (`person`), or a server's (null: no person). Each with its computer's signing key. */
async function start(dir: string, who: Person | null, signing: { publicKey: Buffer; secretKey: Buffer }, said?: string[], net?: { computer: string; direct?: (key: string) => boolean; tunnelAfterMs?: number }): Promise<RunningHost> {
  const shown = log(dir.slice(-6));
  const h = await startHost({ dir, timings: FAST, invites: {}, peers: { bootstrap: testnet.bootstrap as never, signing, person: who, ...(net ?? {}) }, log: (m) => { said?.push(m); shown?.(m); } });
  hosts.push(h);
  return h;
}

async function stop(h: RunningHost): Promise<void> {
  await h.close();
  hosts.splice(hosts.indexOf(h), 1);
}

/** Join into a new folder: as a person, or as a server (null). */
async function join_(invitation: string, who: Person | null, signing: { publicKey: Buffer; secretKey: Buffer }, name: string, deviceKey?: { publicKey: Buffer; secretKey: Buffer }): Promise<string> {
  const dir = join(tmp(name), 'notes');
  await joinWorkspace({ dir, invitation, name, person: who, signing, bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, log: log(`join ${name}`), ...(deviceKey ? { deviceKey } : {}) });
  return dir;
}

/** A device key whose hex starts with `prefix`: to say which of two keys is the lower. */
function keyStarting(prefix: string): { publicKey: Buffer; secretKey: Buffer } {
  for (;;) {
    const k = crypto.keyPair();
    if (k.publicKey.toString('hex').startsWith(prefix)) return k;
  }
}

const api = (h: RunningHost, path: string, init: RequestInit = {}) =>
  fetch(h.url + path, { ...init, headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' } });

const read = (dir: string, path: string) => {
  try {
    return readFileSync(join(dir, path), 'utf8');
  } catch {
    return null;
  }
};

/** Ada's workspace, with a server in it (its host started), and the keys of each. */
async function withServer() {
  const ada = await person('Ada');
  const adaKey = crypto.keyPair();
  const serverKey = crypto.keyPair();
  const dirA = repo();
  const a = await start(dirA, ada, adaKey);
  const link = await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' });
  const dirS = await join_(link, null, serverKey, 'srv');
  const s = await start(dirS, null, serverKey);
  const sk = serverKey.publicKey.toString('hex');
  await until(async () => (await a.host.peers!.people()).servers.some((x) => x.key === sk), 20_000, 'the server in Ada’s policy');
  return { ada, adaKey, dirA, a, serverKey, sk, dirS, s };
}

describe('a server in a workspace (0099)', () => {
  it('joins by the owner’s link for a server, as no person; is listed as a server, and reads all but changes nothing', async () => {
    const { a, s, sk, dirS } = await withServer();
    expect(read(dirS, 'notes.md')).toBe(NOTES);
    const people = await a.host.peers!.people();
    expect(people.servers).toMatchObject([{ key: sk, name: 'srv', you: false }]);
    expect(people.managesServers).toBe(true);
    expect(people.people.map((p) => p.name)).toEqual(['Ada']);
    await until(async () => (await a.host.peers!.status()).devices.some((d) => d.server && d.online), 15_000, 'the server online, as a server');
    // On the server: it is the server, and reads only.
    const own = await s.host.peers!.people();
    expect(own.servers).toMatchObject([{ key: sk, you: true }]);
    expect((await s.host.peers!.access('notes.md')).canWrite).toBe(false);
    // Its device never leads a room, nor are its edits taken in one: it may change no document.
    expect(a.host.peers!.node.mayWrite(s.host.peers!.node.myKey, 'notes.md')).toBe(false);
    expect(a.host.peers!.node.mayWrite(a.host.peers!.node.myKey, 'notes.md')).toBe(true);
    // No identity was made for it.
    expect((await s.host.peers!.status()).device.person).toBeNull();
  });

  it('holds the members’ work and passes it on while they are never online at once', async () => {
    const { a, dirA, s, dirS } = await withServer();
    const bo = await person('Bo');
    const boKey = crypto.keyPair();
    const dirB = await join_(await a.host.peers!.inviteLink({ hours: 24, once: true }), bo, boKey, 'bee');
    let b = await start(dirB, bo, boKey);
    await until(async () => (await s.host.peers!.status()).devices.filter((d) => d.online).length === 2, 20_000, 'both members online to the server');
    // Bo goes away; Ada writes; it reaches the server.
    await stop(b);
    await api(a, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'from-ada.md', content: '# From Ada\n' }) });
    await until(() => read(dirS, 'from-ada.md') === '# From Ada\n', 20_000, 'Ada’s file on the server');
    // Ada goes away; Bo comes back, and has it from the server alone.
    await stop(a);
    b = await start(dirB, bo, boKey);
    await until(() => read(dirB, 'from-ada.md') === '# From Ada\n', 20_000, 'Ada’s file on Bo’s device, from the server');
    // Bo writes; it waits on the server for Ada.
    await api(b, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'from-bo.md', content: '# From Bo\n' }) });
    await until(() => read(dirS, 'from-bo.md') === '# From Bo\n', 20_000, 'Bo’s file on the server');
    expect(read(dirA, 'from-bo.md')).toBeNull();
  });

  it('merges work done apart, so each member takes one history from it', async () => {
    const { a, dirA, s, dirS } = await withServer();
    const bo = await person('Bo');
    const boKey = crypto.keyPair();
    const dirB = await join_(await a.host.peers!.inviteLink({ hours: 24, once: true }), bo, boKey, 'bee');
    const b = await start(dirB, bo, boKey);
    await until(async () => (await s.host.peers!.status()).devices.filter((d) => d.online).length === 2, 20_000, 'both members online to the server');
    // Each works apart, the other away.
    await stop(b);
    await api(a, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'a.md', content: '# A\n' }) });
    await until(() => read(dirS, 'a.md') !== null, 20_000, 'Ada’s work on the server');
    await stop(a);
    writeFileSync(join(dirB, 'b.md'), '# B\n');
    git(dirB, 'add', '-A');
    git(dirB, '-c', 'user.name=Bo', '-c', 'user.email=bo@example.org', 'commit', '-q', '-m', 'B, apart');
    await start(dirB, bo, boKey);
    // Bo's copy and the server's come to one history with both.
    await until(() => read(dirB, 'a.md') !== null && read(dirS, 'b.md') !== null, 20_000, 'both works on both');
    await until(() => git(dirB, 'rev-parse', 'HEAD') === git(dirS, 'rev-parse', 'HEAD'), 20_000, 'one history');
    expect(read(dirA, 'b.md')).toBeNull();
  });

  it('makes the merge itself, though a member’s key is the lower: it brings work made apart together (0099)', async () => {
    const ada = await person('Ada');
    const adaKey = crypto.keyPair();
    const dirA = repo();
    const a = await start(dirA, ada, adaKey);
    const serverKey = crypto.keyPair();
    const dirS = await join_(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), null, serverKey, 'srv', keyStarting('f'));
    const onServer: string[] = [];
    const s = await start(dirS, null, serverKey, onServer);
    const bo = await person('Bo');
    const boKey = crypto.keyPair();
    const dirB = await join_(await a.host.peers!.inviteLink({ hours: 24, once: true }), bo, boKey, 'bee', keyStarting('0'));
    let b = await start(dirB, bo, boKey);
    await until(async () => (await s.host.peers!.status()).devices.filter((d) => d.online).length === 2, 20_000, 'both members online to the server');
    // Work made apart: Ada's reaches the server while Bo is away; Bo's is made while he is away.
    await stop(b);
    await api(a, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'a.md', content: '# A\n' }) });
    await until(() => read(dirS, 'a.md') !== null, 20_000, 'Ada’s work on the server');
    await stop(a);
    writeFileSync(join(dirB, 'b.md'), '# B\n');
    git(dirB, 'add', '-A');
    git(dirB, '-c', 'user.name=Bo', '-c', 'user.email=bo@example.org', 'commit', '-q', '-m', 'B, apart');
    const onBo: string[] = [];
    b = await start(dirB, bo, boKey, onBo);
    await until(() => read(dirS, 'b.md') !== null && read(dirB, 'a.md') !== null, 20_000, 'both works on both');
    // The merge is the server's, though Bo's key is the lower (he would have made it, by the rule between two devices):
    // the server merged; Bo's device only moved to it.
    expect(git(dirS, 'log', '-1', '--merges', '--format=%H')).not.toBe('');
    expect(onServer.some((m) => /^merged /.test(m))).toBe(true);
    expect(onBo.some((m) => /^merged /.test(m))).toBe(false);
    void b;
  });

  it('has members who reach each other only through it sync through it, the tunnel for their live rooms (0099)', async () => {
    const ada = await person('Ada');
    const adaKey = crypto.keyPair();
    const dirA = repo();
    const blocked = new Set<string>();
    const onAda: string[] = [];
    const a = await start(dirA, ada, adaKey, onAda, { computer: 'a', direct: (k) => !blocked.has(k), tunnelAfterMs: 300 });
    const serverKey = crypto.keyPair();
    const dirS = await join_(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), null, serverKey, 'srv');
    const s = await start(dirS, null, serverKey, undefined, { computer: 's' });
    const bo = await person('Bo');
    const boKey = crypto.keyPair();
    const boDevice = crypto.keyPair();
    blocked.add(boDevice.publicKey.toString('hex'));
    const dirB = await join_(await a.host.peers!.inviteLink({ hours: 24, once: true }), bo, boKey, 'bee', boDevice);
    const b = await start(dirB, bo, boKey, undefined, { computer: 'b', direct: (k) => k !== a.host.peers!.node.myKey, tunnelAfterMs: 300 });
    await until(async () => (await a.host.peers!.status()).devices.some((d) => d.name === 'bee' && d.via === 'tunnel'), 20_000, 'Bo reached through the server');
    // Bo's work reaches Ada, through the server's copy: Ada never fetches from Bo through the tunnel.
    onAda.length = 0;
    await api(b, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'from-bo.md', content: '# From Bo\n' }) });
    await until(() => read(dirA, 'from-bo.md') === '# From Bo\n', 20_000, 'Bo’s file on Ada’s device');
    expect(onAda.some((m) => /brought in main from bee/.test(m))).toBe(false);
    void s;
  });

  it('changes nothing: what the server’s key signs is kept out on the members’ devices', async () => {
    const { a, dirA, s, dirS } = await withServer();
    await until(async () => (await a.host.peers!.status()).devices.some((d) => d.server && d.online), 15_000, 'the server online');
    // Whoever runs the server writes a file through its host: committed there, signed by the server's key.
    expect((await api(s, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'planted.md', content: '# Planted\n' }) })).status).toBe(201);
    await until(() => git(dirS, 'log', '-1', '--format=%s').length > 0 && read(dirS, 'planted.md') !== null, 10_000, 'the server’s commit');
    // It reaches Ada's device and is kept out, the merge saying so.
    await until(() => /Kept planted\.md as it was/.test(git(dirA, 'log', '-1', '--merges', '--format=%B')), 20_000, 'the server’s change kept out');
    expect(existsSync(join(dirA, 'planted.md'))).toBe(false);
    // Ada's own work still flows to the server.
    await api(a, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'mine.md', content: '# Mine\n' }) });
    await until(() => read(dirS, 'mine.md') === '# Mine\n', 20_000, 'Ada’s file on the server');
  });

  it('is taken out by the owner; an admin may not, nor invite a server', async () => {
    const { a, s, sk } = await withServer();
    const bo = await person('Bo');
    const boKey = crypto.keyPair();
    const dirB = await join_(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'admin' }), bo, boKey, 'bee');
    const b = await start(dirB, bo, boKey);
    await until(async () => (await b.host.peers!.people()).servers.some((x) => x.key === sk) && (await b.host.peers!.people()).admin, 20_000, 'Bo an admin, seeing the server');
    expect((await b.host.peers!.people()).managesServers).toBe(false);
    await expect(b.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' })).rejects.toThrow('Only the workspace’s owner invites a server');
    await expect(b.host.peers!.removeServer(sk)).rejects.toThrow('Only the workspace’s owner removes a server');
    // Ada removes it: gone from the list everywhere, and the server's device is out.
    expect((await api(a, `/api/peers/servers/${sk}`, { method: 'DELETE' })).status).toBe(200);
    expect((await a.host.peers!.people()).servers).toEqual([]);
    await until(async () => !(await b.host.peers!.people()).servers.length, 20_000, 'the server gone on Bo’s device');
    await until(async () => (await s.host.peers!.status()).removed, 20_000, 'the server told it is out');
    expect((await a.host.peers!.people()).removals[0]).toMatchObject({ kind: 'server-out', who: 'srv', by: 'Ada' });
  });

  it('comes back when the owner invites it again, the same key in a new folder; not once its key is removed for good', async () => {
    const { a, s, sk, serverKey } = await withServer();
    await until(async () => (await a.host.peers!.status()).devices.some((d) => d.server && d.online), 15_000, 'the server online');
    expect((await api(a, `/api/peers/servers/${sk}`, { method: 'DELETE' })).status).toBe(200);
    await until(async () => (await s.host.peers!.status()).removed, 20_000, 'the server told it is out');
    await stop(s);
    // Invited back: the same server (its key), joining anew, as kuraa-server join does after a failed or removed one.
    const back = await join_(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), null, serverKey, 'srv');
    expect(read(back, 'notes.md')).toBe(NOTES);
    await until(async () => (await a.host.peers!.people()).servers.some((x) => x.key === sk), 20_000, 'the server in again');
    // Its key removed for good: no link lets it in again, and the join says why.
    expect((await api(a, `/api/peers/servers/${sk}?for-good=1`, { method: 'DELETE' })).status).toBe(200);
    expect((await a.host.peers!.people()).removals[0]).toMatchObject({ kind: 'server', who: 'srv', by: 'Ada' });
    await expect(join_(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), null, serverKey, 'srv')).rejects.toThrow('removed from the workspace for good');
  });

  it('lets people in while every member is away: by their links, their joins counting (0099)', async () => {
    const { a, s, sk } = await withServer();
    await until(async () => (await a.host.peers!.status()).devices.some((d) => d.server && d.online), 15_000, 'the server online');
    const link = await a.host.peers!.inviteLink({ hours: 24, once: true });
    // The link on record at the server, then Ada away.
    await until(async () => (await s.host.peers!.status()).devices.some((d) => d.online), 15_000, 'Ada online to the server');
    await new Promise((r) => setTimeout(r, 1000));
    await stop(a);
    const bo = await person('Bo');
    const boKey = crypto.keyPair();
    const dirB = await join_(link, bo, boKey, 'bee');
    expect(read(dirB, 'notes.md')).toBe(NOTES);
    // Bo is in: his join counts, on the server's word that it let him in.
    await until(async () => (await s.host.peers!.people()).people.some((p) => p.name === 'Bo'), 20_000, 'Bo in, as the server sees it');
    void sk;
  });

  it('is not joined through where the copy it offers holds a change no one who may made', async () => {
    const { a, s, dirS } = await withServer();
    await until(async () => (await a.host.peers!.status()).devices.some((d) => d.server && d.online), 15_000, 'the server online');
    const link = await a.host.peers!.inviteLink({ hours: 24, once: true });
    await new Promise((r) => setTimeout(r, 1000));
    await stop(a);
    // Whoever runs the server plants a change, unsigned, in its copy.
    writeFileSync(join(dirS, 'notes.md'), '# Notes\n\nPlanted.\n');
    git(dirS, 'add', '-A');
    git(dirS, '-c', 'user.name=x', '-c', 'user.email=x@example.org', 'commit', '-q', '-m', 'Planted');
    const bo = await person('Bo');
    await expect(join_(link, bo, crypto.keyPair(), 'bee')).rejects.toThrow(/a change no one who may made/);
    void s;
  });

  it('refuses a link for a server to anyone with an identity', async () => {
    const { a } = await withServer();
    const link = await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' });
    const cy = await person('Cy');
    await expect(join_(link, cy, crypto.keyPair(), 'cee')).rejects.toThrow('This invite link is for a server');
  });
});
