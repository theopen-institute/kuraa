// @kuraa/server (decision 0099): a server run from its folder, with its own key; a workspace brought
// onto it by its owner's link for a server, through the running server; listed, and taken in.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { connect, createServer } from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { personKeys, startHost, type RunningHost } from '@kuraa/host';
import { joinServer, listServer, readAddress, retireServerKey, serverKey, startAfresh, startServer, statusServer, type RunningServer } from '../src/index.js';

const SLOW = Number(process.env.KURAA_TEST_SLOW ?? 1) || 1;
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
let testnet: Testnet;
const dirs: string[] = [];
const running: { close(): Promise<void> }[] = [];

beforeAll(async () => {
  testnet = await createTestnet(3);
});
afterAll(async () => {
  await testnet.destroy();
});
afterEach(async () => {
  for (const r of running.splice(0)) await r.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tmp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `kuraa-server-${name}-`));
  dirs.push(d);
  return d;
};

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms * SLOW;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Ada's workspace, shared, on her host. */
async function owner(): Promise<RunningHost> {
  const dir = tmp('ada');
  git(dir, 'init', '-q', '-b', 'main');
  writeFileSync(join(dir, 'notes.md'), '# Notes\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.org', 'commit', '-q', '-m', 'Initial');
  const ada = await (await personKeys()).createPerson('Ada', join(tmp('person'), 'person.json'));
  const h = await startHost({ dir, invites: {}, timings: { flushMs: 100, idleCommitMs: 400, maxCommitMs: 3000 }, peers: { bootstrap: testnet.bootstrap as never, signing: crypto.keyPair(), person: ada } });
  running.push(h);
  await h.host.peersForInvites();
  return h;
}

async function server(data = tmp('data')): Promise<RunningServer> {
  // Any free ports: tests run side by side, and beside a server this computer may run on 5872.
  const s = await startServer({ data, port: 0, peerPort: 0, dhtPort: 0, bootstrap: testnet.bootstrap as never });
  running.push(s);
  return s;
}

describe('a server, run from its folder (0099)', () => {
  it('keeps a key of its own there, one for all its workspaces, and says where it is reached', async () => {
    const data = tmp('data');
    const s = await server(data);
    expect(s.key).toBe((await serverKey(data)).publicKey.toString('hex'));
    const a = await readAddress(data);
    expect(a).toMatchObject({ url: s.hub.url, token: s.hub.token, key: s.key, pid: process.pid });
    // Readable only by whoever runs it.
    expect(statSync(join(data, 'server.json')).mode & 0o077).toBe(0);
    expect(statSync(join(data, 'signing.json')).mode & 0o077).toBe(0);
    await s.close();
    running.splice(running.indexOf(s), 1);
    expect(existsSync(join(data, 'server.json'))).toBe(false);
    await expect(listServer(data)).rejects.toThrow('No server is running');
    // The same key the next time.
    const again = await server(data);
    expect(again.key).toBe(s.key);
  });

  it('brings a workspace on by its owner’s link for a server, holds it, and is taken in', async () => {
    const a = await owner();
    const data = tmp('data');
    const s = await server(data);
    const link = await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' });
    const w = await joinServer(link, data);
    expect(readFileSync(join(w.path, 'notes.md'), 'utf8')).toBe('# Notes\n');
    await until(async () => (await listServer(data)).some((x) => x.id === w.id && x.in), 20_000, 'the server taken in');
    expect((await a.host.peers!.people()).servers).toMatchObject([{ key: s.key }]);
    // A person's link is refused, and leaves nothing behind.
    const personLink = await a.host.peers!.inviteLink({ hours: 24, once: true });
    await expect(joinServer(personLink, data)).rejects.toThrow('A server joins by an invite link for a server');
    expect((await listServer(data)).length).toBe(1);
  });

  it('says how it stands: since when it runs, how it updates, each workspace’s members, latest work and size (0112)', async () => {
    const a = await owner();
    const data = tmp('data');
    const s = await server(data);
    const w = await joinServer(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), data);
    await until(async () => (await statusServer(data)).workspaces.some((x) => x.id === w.id && x.in && x.online === 1), 20_000, 'the server in, its owner online');
    const st = await statusServer(data);
    expect(st).toMatchObject({ key: s.key, pid: process.pid, version: null, updates: 'off' });
    expect(Date.now() - st.started).toBeLessThan(120_000);
    expect(st.workspaces).toMatchObject([{ id: w.id, in: true, online: 1, devices: 1 }]);
    expect(st.workspaces[0]!.bytes).toBeGreaterThan(0);
    // Work brought in from a member, said when.
    writeFileSync(join(a.host.dir, 'more.md'), '# More\n');
    await a.host.serial(() => a.host.commitPaths(['more.md'], 'More'));
    await until(async () => !!(await statusServer(data)).workspaces[0]!.lastBrought, 20_000, 'work brought in, on record');
    // And to its members (0115): how it stands, as it says, on its device in their status.
    await until(async () => (await a.host.peers!.status()).devices.some((d) => d.server && d.health && d.health.freeBytes !== null && d.health.lowOnSpace === false), 20_000, 'its health, said to its owner');
  });

  it('gives up its key for a new one: blocked by itself in every workspace, then started afresh, holding nothing (0112)', async () => {
    const a = await owner();
    const data = tmp('data');
    const s = await server(data);
    const w = await joinServer(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), data);
    await until(async () => (await listServer(data)).some((x) => x.id === w.id && x.in), 20_000, 'the server taken in');
    // Not before it has given up its key, while it runs (unless forced).
    await s.close();
    running.splice(running.indexOf(s), 1);
    await expect(startAfresh(data)).rejects.toThrow('has not given up its key');
    const again = await server(data);
    await until(async () => (await listServer(data)).some((x) => x.id === w.id && x.in), 20_000, 'the server in again after its restart');
    // Running: its own key blocked in the workspace, as its owner's device hears.
    const done = await retireServerKey(data);
    expect(done).toMatchObject([{ id: w.id, dropped: true }]);
    await until(async () => !(await a.host.peers!.people()).servers.length, 20_000, 'the server out on its owner’s device');
    expect((await a.host.peers!.people()).removals[0]).toMatchObject({ kind: 'server' });
    // Stopped: the old key put aside, every copy gone; the next start, a new key.
    await again.close();
    running.splice(running.indexOf(again), 1);
    expect(await startAfresh(data)).toEqual([w.name]);
    expect(readdirSync(join(data, 'keys-retired'))).toHaveLength(1);
    expect(existsSync(w.path)).toBe(false);
    const fresh = await server(data);
    expect(fresh.key).not.toBe(s.key);
    expect(await listServer(data)).toEqual([]);
  });

  it('deletes its copy of a workspace once its owner takes it out, as it holds every space (0112)', async () => {
    const a = await owner();
    const data = tmp('data');
    const s = await server(data);
    const w = await joinServer(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), data);
    await until(async () => (await listServer(data)).some((x) => x.id === w.id && x.in), 20_000, 'the server taken in');
    await a.host.peers!.removeServer(s.key);
    // Listed as out, once it hears; then let go of (looked at each minute; here, at once).
    await until(async () => (await listServer(data)).some((x) => x.id === w.id && x.out === 'removed'), 20_000, 'the server hearing it is out');
    // Kept a week first (0115: a removal undone, or made by mistake, finds its copy there); then, still out, deleted.
    await s.hub.hub.sweepRemoved();
    expect(existsSync(w.path)).toBe(true);
    await s.hub.hub.sweepRemoved(Date.now() + 6 * 24 * 3600_000);
    expect(existsSync(w.path)).toBe(true);
    await s.hub.hub.sweepRemoved(Date.now() + 8 * 24 * 3600_000);
    expect(await listServer(data)).toEqual([]);
    expect(existsSync(w.path)).toBe(false);
  });

  it('stays the owner’s to block once removed: its key then never let back, its copy gone when the week is out (0115)', async () => {
    const a = await owner();
    const data = tmp('data');
    const s = await server(data);
    const w = await joinServer(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), data);
    await until(async () => (await listServer(data)).some((x) => x.id === w.id && x.in), 20_000, 'the server taken in');
    await a.host.peers!.removeServer(s.key);
    await until(async () => (await listServer(data)).some((x) => x.id === w.id && x.out === 'removed'), 20_000, 'the server hearing it is out');
    await s.hub.hub.sweepRemoved();
    // Listed among the removed servers, and blocked from there: dropped for good, no longer listed.
    expect((await a.host.peers!.people()).formerServers).toMatchObject([{ key: s.key }]);
    await a.host.peers!.removeServer(s.key, { forGood: true });
    const { policy } = await a.host.peers!.node.policy();
    expect(policy.dropped.has(s.key)).toBe(true);
    expect((await a.host.peers!.people()).formerServers).toEqual([]);
    // The server, no longer connected, does not hear it; its copy goes as a removed one's does.
    await s.hub.hub.sweepRemoved(Date.now() + 8 * 24 * 3600_000);
    expect(existsSync(w.path)).toBe(false);
  });

  it('gives its metrics to a monitor with its access code, by workspace ID, never by name (0115)', async () => {
    const a = await owner();
    const data = tmp('data');
    const s = await server(data);
    const w = await joinServer(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), data);
    await until(async () => (await statusServer(data)).workspaces.some((x) => x.id === w.id && x.in && x.online === 1), 20_000, 'the server in, its owner online');
    const url = `${s.hub.url}/hub/api/server/metrics`;
    expect((await fetch(url)).status).toBe(401);
    const res = await fetch(url, { headers: { authorization: `Bearer ${s.hub.token}` } });
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    const text = await res.text();
    expect(text).toContain(`kuraa_server_workspace_in{workspace="${w.id}"} 1`);
    expect(text).toContain(`kuraa_server_members_online{workspace="${w.id}"} 1`);
    expect(text).toMatch(/^kuraa_server_disk_free_bytes \d+$/m);
    expect(text).not.toContain(w.name);
  });

  it('starts afresh only where a member heard its key was given up (0115)', async () => {
    const a = await owner();
    const data = tmp('data');
    const s = await server(data);
    const w = await joinServer(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), data);
    await until(async () => (await listServer(data)).some((x) => x.id === w.id && x.in), 20_000, 'the server taken in');
    // Its owner's device gone: no member to hear the drop.
    await a.close();
    running.splice(running.indexOf(a), 1);
    expect(await retireServerKey(data)).toMatchObject([{ id: w.id, dropped: true, heardBy: 0 }]);
    await s.close();
    running.splice(running.indexOf(s), 1);
    await expect(startAfresh(data)).rejects.toThrow('No member was online');
    // Nothing was deleted, and the key is where it was.
    expect(existsSync(w.path)).toBe(true);
    expect(existsSync(join(data, 'keys-retired'))).toBe(false);
  });

  it('takes members’ connections on its port from the first workspace it joins, not only after a restart (its own process)', async () => {
    const a = await owner();
    const data = tmp('data');
    // A free port: the test's own, and this computer may run a server on 5872.
    const port = await new Promise<number>((done) => {
      const probe = createServer().listen(0, '127.0.0.1', () => {
        const p = (probe.address() as { port: number }).port;
        probe.close(() => done(p));
      });
    });
    const bootstrap = (testnet.bootstrap as { host: string; port: number }[]).map((b) => `${b.host}:${b.port}`);
    const child = spawn(join(import.meta.dirname, '../../../node_modules/.bin/tsx'), ['packages/server/src/main.ts', '--data', data, '--port', '0', '--peer-port', String(port), '--dht-port', '0', ...bootstrap.flatMap((b) => ['--bootstrap', b])], {
      cwd: join(import.meta.dirname, '../../..'), stdio: 'ignore',
    });
    running.push({ close: () => new Promise<void>((done) => { child.once('exit', () => done()); child.kill('SIGTERM'); }) });
    await until(() => existsSync(join(data, 'server.json')), 20_000, 'the server started');
    await joinServer(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), data);
    const listening = () => new Promise<boolean>((done) => {
      const sock = connect(port, '127.0.0.1');
      sock.once('connect', () => { sock.destroy(); done(true); });
      sock.once('error', () => done(false));
    });
    await until(listening, 20_000, `the server listening on ${port}`);
  });

  it('waits for a server that is starting (just restarted), rather than saying none is running', async () => {
    const data = tmp('data');
    const asked = listServer(data);
    await new Promise((r) => setTimeout(r, 1500));
    await server(data);
    expect(await asked).toEqual([]);
  });

  it('runs one to a folder: a second is refused while the first runs; a lock left by a process gone is taken over', async () => {
    const data = tmp('data');
    const first = await server(data);
    await expect(startServer({ data, port: 0, peerPort: 0, dhtPort: 0, bootstrap: testnet.bootstrap as never })).rejects.toThrow('Another server is running');
    await first.close();
    running.splice(running.indexOf(first), 1);
    // A server stopped hard: its lock names a process that has gone.
    writeFileSync(join(data, 'server.lock'), '999999\n');
    await server(data);
  });

  it('takes up a join cut short after its copy, takes away one cut short before, and lets go of git’s locks', async () => {
    const a = await owner();
    const data = tmp('data');
    const s = await server(data);
    const w = await joinServer(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), data);
    await until(async () => (await listServer(data)).some((x) => x.id === w.id && x.in), 20_000, 'in');
    await s.close();
    running.splice(running.indexOf(s), 1);
    // As if stopped hard: the list without it (the join had not got to listing it), a half-made folder beside it,
    // and a lock git left in it.
    writeFileSync(join(data, 'workspaces', '.kuraa-workspaces.json'), '[]');
    mkdirSync(join(data, 'workspaces', 'shared-workspace-9', '.git'), { recursive: true });
    writeFileSync(join(w.path, '.git', 'index.lock'), '');
    await server(data);
    await until(async () => (await listServer(data)).some((x) => x.id === w.id && x.in), 20_000, 'taken up, and in');
    expect(existsSync(join(data, 'workspaces', 'shared-workspace-9'))).toBe(false);
    expect(existsSync(join(w.path, '.git', 'index.lock'))).toBe(false);
  });

  it('holds a workspace once: joined again, by a new link, it is the one held, the same device', async () => {
    const a = await owner();
    const data = tmp('data');
    await server(data);
    const w = await joinServer(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), data);
    await until(async () => (await listServer(data)).some((x) => x.id === w.id && x.in), 20_000, 'in');
    const again = await joinServer(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), data);
    expect(again.id).toBe(w.id);
    expect((await listServer(data)).length).toBe(1);
    // One device of the server, as the owner sees it.
    const devices = (await a.host.peers!.people()).servers[0]!.devices;
    expect(devices.length).toBe(1);
  });

  it('makes no workspace of its own', async () => {
    const data = tmp('data');
    const s = await server(data);
    const res = await fetch(`${s.hub.url}/hub/api/workspaces`, { method: 'POST', headers: { authorization: `Bearer ${s.hub.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'new', name: 'Mine' }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/makes none of its own/);
  });

  it('is headless: no app, nothing of what it holds over HTTP but its list, no rooms; its workspaces’ hosts not reachable with its code', async () => {
    const a = await owner();
    const data = tmp('data');
    const s = await server(data);
    const w = await joinServer(await a.host.peers!.inviteLink({ hours: 24, once: true, role: 'server' }), data);
    const get = (path: string, token: string | null = s.hub.token) => fetch(s.hub.url + path, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    // Its list, with its code; nothing without it.
    expect((await get('/hub/api/server')).status).toBe(200);
    expect((await get('/hub/api/server', null)).status).toBe(401);
    // No app, no workspace's API (files, people), no hub's listing, settings or folders: not even with its code.
    for (const path of ['/', '/index.html', `/w/${w.id}/`, `/w/${w.id}/api/peers`, `/w/${w.id}/api/files?path=notes.md`, '/hub/api/workspaces', '/hub/api/settings', '/hub/api/folders']) {
      const res = await get(path);
      expect(res.status, path).toBe(404);
      expect(await res.text(), path).toMatch(/serves no app/);
    }
    // No rooms: a WebSocket to a workspace is closed at once.
    const closed = await new Promise<boolean>((done) => {
      const ws = new WebSocket(`${s.hub.url.replace(/^http/, 'ws')}/w/${w.id}/collab?token=${s.hub.token}`);
      ws.onopen = () => done(false);
      ws.onerror = () => done(true);
      ws.onclose = () => done(true);
    });
    expect(closed).toBe(true);
    // Its workspace's own host, on this computer, takes not the server's access code.
    const inner = s.hub.hub.hostOf(w.id)!;
    expect(inner.token).not.toBe(s.hub.token);
    expect((await fetch(`${inner.url}/api/peers`, { headers: { authorization: `Bearer ${s.hub.token}` } })).status).toBe(401);
  });
});
