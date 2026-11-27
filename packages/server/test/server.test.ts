// @kuraa/server (decision 0099): a server run from its folder, with its own key; a workspace brought
// onto it by its owner's link for a server, through the running server; listed, and taken in.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { personKeys, startHost, type RunningHost } from '@kuraa/host';
import { joinServer, listServer, readAddress, serverKey, startServer, type RunningServer } from '../src/index.js';

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
  const s = await startServer({ data, port: 0, bootstrap: testnet.bootstrap as never });
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

  it('makes no workspace of its own', async () => {
    const data = tmp('data');
    const s = await server(data);
    const res = await fetch(`${s.hub.url}/hub/api/workspaces`, { method: 'POST', headers: { authorization: `Bearer ${s.hub.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'new', name: 'Mine' }) });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toMatch(/makes none of its own/);
  });
});
