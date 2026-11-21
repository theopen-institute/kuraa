// Devices of one workspace, on a local DHT: joining by invite link, git between
// them both ways, work done apart merged the same way on each, people on two
// devices editing one document live, and every member with the same say (0038).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import { Transform } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { standardTypes } from '@kuraa/formats';
import { mergeLines, type DocumentType } from '@kuraa/kernel';
import { connectHeadless, type HeadlessClient } from '@kuraa/session/testing';
import { commitSigner } from '../src/signing.js';
import { createPerson, type Person } from '../src/peers/person.js';
import { joinWorkspace, startHost, type RunningHost } from '../src/index.js';
import type { PeerOptions } from '../src/peers/peers.js';
import { Git } from '../src/git.js';
import { Identity, decodeLink, topicsFor } from '../src/peers/identity.js';
import type { PeerNode } from '../src/peers/node.js';
import type { JoinProgress } from '../src/peers/join.js';

const NOTES = '---\ntitle: Field notes\n---\n\n# Day one\n\nThe tide was out.\n\nWe counted crabs.\n\n# Day two\n\nIt rained.\n';
const FAST = { flushMs: 100, idleCommitMs: 400, maxCommitMs: 3000, dropMs: 300 };
const ADA = { name: 'Ada', email: 'ada@example.org', color: '#d33' };
const BO = { name: 'Bo', email: 'bo@example.org', color: '#33d' };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

let testnet: Testnet;
const dirs: string[] = [];
const hosts: RunningHost[] = [];
const clients: HeadlessClient[] = [];

beforeAll(async () => {
  testnet = await createTestnet(3);
});
afterAll(async () => {
  await testnet.destroy();
});
afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  for (const h of hosts.splice(0)) await h.close().catch(() => undefined);
  // No fetch outlives its host: git's helper exits once the host closes its connection.
  const left = (d: string[]) => execFileSync('ps', ['-eo', 'command'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes('git-remote-kuraa.mjs') && d.some((x) => l.includes(x)));
  const these = [...dirs];
  await until(() => left(these).length === 0, 5000, 'no helper left running').catch(() => expect(left(these)).toEqual([]));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-peer-a-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.org');
  writeFileSync(join(dir, 'notes.md'), NOTES);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  return dir;
}

/** Each device's signing key: as if each were someone on a computer of their own (0035). */
const signingKeys = new Map<string, { publicKey: Buffer; secretKey: Buffer }>();

type Net = Pick<PeerOptions, 'direct' | 'computer' | 'tunnelAfterMs' | 'lan' | 'peerPort' | 'publicAddress' | 'dhtPort'>;

async function start(dir: string, extra: { types?: DocumentType[]; person?: Person; invites?: object; node?: PeerNode; dialMs?: number; lookupsMs?: number[]; bootstrap?: unknown[]; net?: Net } = {}): Promise<RunningHost> {
  const { person, node, dialMs, lookupsMs, bootstrap, net, ...rest } = extra;
  if (!signingKeys.has(dir)) signingKeys.set(dir, crypto.keyPair());
  const h = await startHost({ ...rest, dir, timings: FAST, peers: { bootstrap: (bootstrap ?? testnet.bootstrap) as never, signing: signingKeys.get(dir), person: person ?? null, node, dialMs, lookupsMs, ...net }, log: process.env.PEER_LOG ? (m) => console.log(`[${dir.slice(-6)}] ${m}`) : undefined });
  hosts.push(h);
  return h;
}

/** An invite link for one person, made on a host's device. */
const inviteFrom = (h: RunningHost) => h.host.peers!.inviteLink({ hours: 24, once: true });

/** Two paired devices: Ada's (the first) and Bo's (joined by an invite link). */
async function pair(): Promise<{ a: RunningHost; b: RunningHost; dirA: string; dirB: string }> {
  const dirA = repo();
  const a = await start(dirA);
  const invitation = await inviteFrom(a);
  const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
  dirs.push(parent);
  const dirB = join(parent, 'notes');
  await joinWorkspace({ dir: dirB, invitation, name: 'bee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, log: process.env.PEER_LOG ? (m) => console.log(`[join] ${m}`) : undefined });
  if (process.env.PEER_LOG) console.log('[join] config', git(dirB, 'config', '--list', '--local'));
  git(dirB, 'config', 'user.name', 'Bo');
  git(dirB, 'config', 'user.email', 'bo@example.org');
  const b = await start(dirB);
  await until(async () => (await a.host.peers!.status()).devices.some((d) => d.online) && (await b.host.peers!.status()).devices.some((d) => d.online), 15_000, 'both online');
  return { a, b, dirA, dirB };
}

const api = (h: RunningHost, path: string, init: RequestInit = {}) =>
  fetch(h.url + path, { ...init, headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' } });

async function connect(h: RunningHost, user = ADA): Promise<HeadlessClient> {
  const { room } = (await (await api(h, '/api/rooms?path=notes.md')).json()) as { room: string };
  const c = connectHeadless({ url: h.url.replace(/^http/, 'ws') + '/collab', room, token: h.token, user, schema: pandocMarkdown.schema });
  clients.push(c);
  await c.ready;
  return c;
}

function insertAt(doc: PMNode, anchor: string, text: string): PMNode {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isTextblock && node.textContent.includes(anchor)) pos = p + 1 + node.textContent.indexOf(anchor);
    return pos < 0;
  });
  return new Transform(doc).insert(pos, pandocMarkdown.schema.text(text)).doc;
}

const head = (dir: string) => git(dir, 'rev-parse', 'HEAD');
const file = (dir: string) => readFileSync(join(dir, 'notes.md'), 'utf8');

describe('devices of one workspace', () => {
  it('pair by invite link, and bring each other’s commits in', async () => {
    const { a, b, dirA, dirB } = await pair();
    // The joined copy has the workspace, and each knows the other as a remote.
    expect(file(dirB)).toBe(NOTES);
    expect(git(dirB, 'remote', 'get-url', git(dirB, 'remote'))).toMatch(/^kuraa:\/\/[0-9a-f]{64}$/);
    expect(git(dirA, 'config', 'kuraa.workspace')).toBe(git(dirB, 'config', 'kuraa.workspace'));
    const status = await (await api(a, '/api/peers')).json();
    expect(status).toMatchObject({ enabled: true, devices: [{ name: 'bee', online: true }] });

    // A file made on one appears on the other, both ways.
    await api(a, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'from-ada.md', content: '# From Ada\n' }) });
    await until(() => { try { return readFileSync(join(dirB, 'from-ada.md'), 'utf8') === '# From Ada\n'; } catch { return false; } }, 15_000, 'Ada’s file on Bo’s device');
    await api(b, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'from-bo.md', content: '# From Bo\n' }) });
    await until(() => { try { return readFileSync(join(dirA, 'from-bo.md'), 'utf8') === '# From Bo\n'; } catch { return false; } }, 15_000, 'Bo’s file on Ada’s device');
    await until(() => head(dirA) === head(dirB), 15_000, 'the same commit on both');
    // Each was signed with the key of whoever made it, on that computer, and the other device can tell whose (attribution only).
    const made = (path: string) => git(dirB, 'log', '-1', '--format=%H', '--', path);
    expect(await commitSigner(b.host.git, made('from-ada.md'))).toBe(signingKeys.get(dirA)!.publicKey.toString('hex'));
    expect(await commitSigner(b.host.git, made('from-bo.md'))).toBe(signingKeys.get(dirB)!.publicKey.toString('hex'));
    // Pulling only: neither device wrote to the other's repository.
    expect(git(dirA, 'status', '--porcelain')).toBe('');
    expect(git(dirB, 'status', '--porcelain')).toBe('');
  });

  it('merge work done apart the same way on both devices', async () => {
    const { b, dirA, dirB } = await pair();
    await b.close();
    hosts.splice(hosts.indexOf(b), 1);
    // Apart: each changes a different paragraph, and both change one sentence differently.
    writeFileSync(join(dirA, 'notes.md'), NOTES.replace('The tide was out.', 'The tide was far out.').replace('It rained.', 'It rained all day.'));
    git(dirA, 'commit', '-q', '-am', 'Ada, apart');
    writeFileSync(join(dirB, 'notes.md'), NOTES.replace('We counted crabs.', 'We counted 41 crabs.').replace('It rained.', 'It poured.'));
    git(dirB, 'commit', '-q', '-am', 'Bo, apart');
    await start(dirB);
    await until(() => head(dirA) === head(dirB) && git(dirA, 'log', '-1', '--format=%an') === 'Kuraa', 20_000, 'one merge, on both');
    const merged = file(dirA);
    expect(file(dirB)).toBe(merged);
    expect(merged).toContain('The tide was far out.');
    expect(merged).toContain('We counted 41 crabs.');
    expect(merged).toContain(':::: {.conflict}');
    expect(merged).toMatch(/It rained all day\.[\s\S]*It poured\.|It poured\.[\s\S]*It rained all day\./);
  });

  it('make one history with a device that merges differently (another version), the lower key merging', async () => {
    const { a, b, dirA, dirB } = await pair();
    await b.close();
    hosts.splice(hosts.indexOf(b), 1);
    writeFileSync(join(dirA, 'notes.md'), NOTES.replace('The tide was out.', 'The tide was far out.'));
    git(dirA, 'commit', '-q', '-am', 'Ada, apart');
    writeFileSync(join(dirB, 'notes.md'), NOTES.replace('It rained.', 'It poured.'));
    git(dirB, 'commit', '-q', '-am', 'Bo, apart');
    // Bo's device now has a type of its own that merges: it merges differently.
    const text = standardTypes.find((t) => t.id === 'text')!;
    const odd: DocumentType = { ...text, id: 'odd', match: (p) => p.endsWith('.odd'), merge: (base, x, y, sides) => mergeLines(base, x, y, sides) };
    const b2 = await start(dirB, { types: [...standardTypes, odd] });
    await until(() => head(dirA) === head(dirB), 20_000, 'the same commit on both');
    expect(git(dirA, 'rev-list', '--merges', '--count', 'HEAD')).toBe('1');
    expect(file(dirA)).toContain('The tide was far out.');
    expect(file(dirA)).toContain('It poured.');
    expect((await a.host.peers!.status()).devices[0]).toMatchObject({ name: 'bee', otherVersion: true });
    expect((await b2.host.peers!.status()).devices[0]).toMatchObject({ otherVersion: true });
  });

  it('let people on two devices edit one document live, with one device committing', async () => {
    const { a, b, dirA, dirB } = await pair();
    const ada = await connect(a, ADA);
    const bo = await connect(b, BO);
    ada.write(insertAt(ada.read(), 'The tide', 'Ada: '));
    bo.write(insertAt(bo.read(), 'It rained', 'Bo: '));
    await until(() => ada.read().textContent.includes('Bo: ') && bo.read().textContent.includes('Ada: '), 15_000, 'each sees the other’s edit');
    expect(ada.read().eq(bo.read())).toBe(true);
    // No text twice: the rooms started from the same blob.
    expect(ada.read().textContent.match(/The tide/g)).toHaveLength(1);
    // People on the other device are in the room.
    await until(() => ada.peers().some((p) => p.name === 'Bo') && bo.peers().some((p) => p.name === 'Ada'), 15_000, 'presence across devices');
    // Both files and both branches end the same, from commits one device made.
    const expected = NOTES.replace('The tide', 'Ada: The tide').replace('It rained', 'Bo: It rained');
    await until(() => file(dirA) === expected && file(dirB) === expected && head(dirA) === head(dirB) && git(dirA, 'status', '--porcelain') === '' && git(dirB, 'status', '--porcelain') === '', 20_000, 'committed and the same on both');
    // One device committed the edits of both, crediting both.
    const authors = git(dirA, 'log', '--format=%an', 'HEAD~1..HEAD');
    const body = git(dirA, 'log', '-1', '--format=%B');
    expect(['Ada', 'Bo']).toContain(authors);
    expect(body).toMatch(/^Edit Field notes: Day one, Day two \((Ada, Bo|Bo, Ada)\)/);
    expect(body).toContain('Co-authored-by: Ada <ada@example.org>');
    expect(body).toContain('Co-authored-by: Bo <bo@example.org>');
    expect(body).toContain('Kuraa-Kind: autosave');
  });
});

describe('joining, and staying connected', () => {
  it('go on with the connection the join made: the device that let it in sees it once, and it is online at once', async () => {
    const dirA = repo();
    const a = await start(dirA);
    const invitation = await inviteFrom(a);
    // Each time Ada's device lets a device in, it is a new connection.
    const events = a.host.peers!.node.events;
    const was = events.accepted!;
    const accepted: string[] = [];
    events.accepted = (link) => {
      accepted.push(link.key);
      was(link);
    };
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
    dirs.push(parent);
    const dirB = join(parent, 'notes');
    const steps: JoinProgress['step'][] = [];
    const joined = await joinWorkspace({ dir: dirB, invitation, name: 'bee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, keep: true, progress: (p) => steps.push(p.step) });
    expect(steps[0]).toBe('looking');
    expect(steps.at(-1)).toBe('copying');
    const node = joined.node!;
    // Still connected, as the join left it.
    expect([...node.links.values()].some((l) => l.accepted && !l.closed)).toBe(true);
    git(dirB, 'config', 'user.name', 'Bo');
    git(dirB, 'config', 'user.email', 'bo@example.org');
    const b = await start(dirB, { node });
    expect(b.host.peers!.node).toBe(node);
    expect((await b.host.peers!.status()).devices.find((d) => d.key === a.host.peers!.node.myKey)?.online).toBe(true);
    // It now says how it merges (the join's hello did not), so neither takes the other for another version.
    await until(() => !a.host.peers!.node.mergesDiffer(node.myKey), 5000, 'Ada’s device knows how bee merges');
    // A full device: its work reaches Ada's, and Ada's reaches it.
    await api(b, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'from-bee.md', content: '# Bee\n' }) });
    await until(() => existsSync(join(dirA, 'from-bee.md')), 15_000, 'bee’s work on Ada’s device');
    await api(a, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'from-ada.md', content: '# Ada\n' }) });
    await until(() => existsSync(join(dirB, 'from-ada.md')), 15_000, 'Ada’s work on bee');
    // Let in once, on one connection, never connected anew.
    expect(accepted.filter((k) => k === node.myKey)).toHaveLength(1);
  });

  /** Ada's device, and bee's joined to it, both online. */
  async function joinedPair(o: { dialMs?: number; lookupsMs?: number[] } = {}) {
    const dirA = repo();
    const a = await start(dirA, o);
    const invitation = await inviteFrom(a);
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
    dirs.push(parent);
    const joined = await joinWorkspace({ dir: join(parent, 'notes'), invitation, name: 'bee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, keep: true });
    const b = await start(join(parent, 'notes'), { node: joined.node });
    await until(async () => (await a.host.peers!.status()).devices.some((d) => d.name === 'bee' && d.online), 10_000, 'bee online on Ada’s device');
    return { a, b };
  }

  /** A device key above (or below) this one's: which of two dials the other depends on it. */
  function keyAbove(than: string, above = true): string {
    for (;;) {
      const k = crypto.keyPair().publicKey.toString('hex');
      if (above ? k > than : k < than) return k;
    }
  }

  /** Watch a node's swarm: whom it dials, and lets be. */
  function watchSwarm(node: PeerNode) {
    const swarm = (node as unknown as { swarm: { joinPeer(key: Buffer): void; leavePeer(key: Buffer): void } }).swarm;
    const dial = swarm.joinPeer.bind(swarm);
    const leave = swarm.leavePeer.bind(swarm);
    const seen = { dialled: [] as string[], left: [] as string[] };
    swarm.joinPeer = (key) => {
      seen.dialled.push(key.toString('hex'));
      dial(key);
    };
    swarm.leavePeer = (key) => {
      seen.left.push(key.toString('hex'));
      leave(key);
    };
    return seen;
  }

  it('tell each other whom they are connected to: a device reached through another is online through it, and of two, the lower key dials', async () => {
    const { a, b } = await joinedPair({ dialMs: 300 });
    const node = a.host.peers!.node;
    const bee = b.host.peers!.node.myKey;
    // Two members Ada's device cannot reach: one with a key above its own, one below.
    const above = keyAbove(node.myKey);
    const below = keyAbove(node.myKey, false);
    // (Ada's host may be writing .git/config at the same moment: git.ts waits its turn.)
    await node.identity.addMember(above, 'above');
    await node.identity.addMember(below, 'below');
    const seen = watchSwarm(node);
    // Bee says it is connected to both.
    await new Promise((r) => setTimeout(r, 400));
    b.host.peers!.node.links.get(node.myKey)!.send({ type: 'present', keys: [above, below] });
    await until(async () => (await a.host.peers!.status()).devices.find((d) => d.name === 'above')?.through.length === 1, 5000, 'above online through bee');
    const devices = (await a.host.peers!.status()).devices;
    expect(devices.find((d) => d.name === 'above')).toMatchObject({ online: false, through: [bee] });
    expect(devices.find((d) => d.name === 'below')).toMatchObject({ online: false, through: [bee] });
    expect(devices.find((d) => d.name === 'bee')).toMatchObject({ online: true, through: [] });
    // Ada's device dials the one above it, for a while, then lets it be; the one below dials Ada's.
    expect(seen.dialled).toContain(above);
    expect(seen.dialled).not.toContain(below);
    await until(() => seen.left.includes(above), 3000, 'above let be');
    // Bee no longer connected to them: no longer online through it.
    b.host.peers!.node.links.get(node.myKey)!.send({ type: 'present', keys: [] });
    await until(async () => (await a.host.peers!.status()).devices.find((d) => d.name === 'above')?.through.length === 0, 5000, 'above offline');
  });

  it('look the workspace up again while a device is missing, less and less often, and not while every device is here', async () => {
    const { a, b } = await joinedPair({ lookupsMs: [50, 100, 200] });
    const node = a.host.peers!.node;
    // Each lookup looks up every topic it is on as a client: this week's and last week's.
    const topics = [...(node as unknown as { discoveries: Map<string, { d: { refresh(): Promise<void> }; client: boolean }> }).discoveries.values()].filter((t) => t.client);
    expect(topics).toHaveLength(2);
    let refreshes = 0;
    for (const { d } of topics) {
      const refresh = d.refresh.bind(d);
      d.refresh = () => {
        refreshes++;
        return refresh();
      };
    }
    const lookups = () => refreshes / topics.length;
    // Everyone here: the schedule starts (as after a network change) and finds nothing to look for.
    (node as unknown as { lookAgain(): void }).lookAgain();
    await new Promise((r) => setTimeout(r, 600));
    expect(lookups()).toBe(0);
    // Bee goes: looked up three times, as the schedule says, and then no more.
    await b.close();
    hosts.splice(hosts.indexOf(b), 1);
    await until(() => lookups() === 3, 5000, 'three lookups');
    await new Promise((r) => setTimeout(r, 600));
    expect(lookups()).toBe(3);
  });
});

describe('equal members, and forks', () => {
  it('take any member’s work, and name it by the person whose it is', async () => {
    const people = mkdtempSync(join(tmpdir(), 'kuraa-people-'));
    dirs.push(people);
    const bo = await createPerson('Bo', join(people, 'bo.json'));
    const dirA = repo();
    const a = await start(dirA);
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
    dirs.push(parent);
    const dirB = join(parent, 'notes');
    await joinWorkspace({ dir: dirB, invitation: await inviteFrom(a), name: 'bee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000 });
    const b = await start(dirB, { person: bo });
    // A member that joined last has the same say as the first: its work comes in, with no rule to pass.
    expect((await api(b, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'chapters/bo.md', content: '# Bo’s\n' }) })).status).toBe(201);
    await until(() => existsSync(join(dirA, 'chapters', 'bo.md')), 15_000, 'Bo’s work on Ada’s device');
    // Signed with Bo's key on his computer, which his identity vouched for: Ada's device names him.
    const signer = await commitSigner(a.host.git, git(dirA, 'log', '-1', '--format=%H', '--', 'chapters/bo.md'));
    expect(signer).toBe(signingKeys.get(dirB)!.publicKey.toString('hex'));
    await until(async () => (await a.host.peers!.status()).devices[0]?.person === 'Bo', 15_000, 'Bo named on Ada’s device');
    expect(await a.host.peers!.node.identity.personOf(signer!)).toEqual({ key: bo.publicKey.toString('hex'), name: 'Bo' });
  });

  it('spread a new member through the others, and let any member remove another, the first among them', async () => {
    const { a, b, dirA, dirB } = await pair();
    // A third device joins by Bo's link (not the first device's); Ada's learns of it from Bo's.
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-c-'));
    dirs.push(parent);
    const dirC = join(parent, 'notes');
    await joinWorkspace({ dir: dirC, invitation: await inviteFrom(b), name: 'cee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000 });
    const c = await start(dirC, { invites: {} });
    await until(() => git(dirA, 'remote').split('\n').includes('cee'), 15_000, 'Ada’s device pairs with cee through bee');
    await until(async () => (await c.host.peers!.status()).devices.filter((d) => d.online).length === 2, 15_000, 'cee meets both');
    // The newest member renames itself and removes the first device, from the app: Bo's learns it, and Ada's is turned away.
    expect((await api(c, '/api/peers/name', { method: 'POST', body: JSON.stringify({ name: 'Cy’s laptop' }) })).status).toBe(200);
    expect((await c.host.peers!.status()).device.name).toBe('cy-s-laptop');
    const adaKey = (await a.host.peers!.status()).device.key;
    expect((await api(c, `/api/peers/devices/${adaKey}`, { method: 'DELETE' })).status).toBe(200);
    await until(() => !git(dirB, 'remote').split('\n').some((r) => git(dirB, 'remote', 'get-url', r) === `kuraa://${adaKey}`), 20_000, 'Bo’s device forgets Ada’s');
    await until(async () => !(await a.host.peers!.status()).devices.some((d) => d.online), 20_000, 'Ada’s device is turned away');
    expect(git(dirB, 'config', '--get-all', 'kuraa.removed')).toBe(adaKey);
    // It keeps its copy.
    expect(file(dirA)).toBe(NOTES);
    // Removing a device that is not a member, or this one, is refused.
    expect((await api(c, `/api/peers/devices/${'0'.repeat(64)}`, { method: 'DELETE' })).status).toBe(404);
    expect((await api(c, `/api/peers/devices/${(await c.host.peers!.status()).device.key}`, { method: 'DELETE' })).status).toBe(404);
  });

  it('let a fork and its origin fetch from each other, but never merge on their own', async () => {
    const { a, b, dirA, dirB } = await pair();
    await b.close();
    hosts.splice(hosts.indexOf(b), 1);
    const origin = git(dirA, 'config', 'kuraa.workspace');
    execFileSync('npx', ['tsx', join(import.meta.dirname, '../src/cli.ts'), 'fork', '--dir', dirB], { encoding: 'utf8' });
    expect(git(dirB, 'config', 'kuraa.forkedfrom')).toBe(`${origin}@${head(dirB)}`);
    const b2 = await start(dirB);
    await until(async () => (await b2.host.peers!.status()).devices.some((d) => d.online && d.related), 15_000, 'the fork meets its origin');
    await api(a, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'origin-only.md', content: '# Origin\n' }) });
    // Fetched into the fork's remote branch, but not merged.
    // Until it is fetched, git says it has no such commit: a probe, so its complaint is not shown.
    const fetched = () => execFileSync('git', ['branch', '-r', '--contains', head(dirA)], { cwd: dirB, encoding: 'utf8', stdio: 'pipe' }).trim() !== '';
    await until(() => { try { return fetched(); } catch { return false; } }, 15_000, 'the fork fetches the origin');
    expect(() => readFileSync(join(dirB, 'origin-only.md'))).toThrow();
    expect(head(dirB)).not.toBe(head(dirA));
  });

  it('join two devices that had the same document open apart, without losing or doubling text', async () => {
    const { a, b, dirA, dirB } = await pair();
    await b.close();
    hosts.splice(hosts.indexOf(b), 1);
    writeFileSync(join(dirA, 'notes.md'), NOTES.replace('The tide was out.', 'The tide was far out.'));
    git(dirA, 'commit', '-q', '-am', 'Ada, apart');
    writeFileSync(join(dirB, 'notes.md'), NOTES.replace('It rained.', 'It poured.'));
    git(dirB, 'commit', '-q', '-am', 'Bo, apart');
    const ada = await connect(a, ADA);
    ada.write(insertAt(ada.read(), 'We counted', 'Live: '));
    const b2 = await start(dirB);
    const want = (t: string) => t.includes('The tide was far out.') && t.includes('It poured.') && t.includes('Live: We counted');
    // Either room may be replaced by the other's: follow it, as the app does.
    const follow = async (c: HeadlessClient, h: RunningHost, user: typeof ADA) => {
      if (!c.messages.some((m) => m.type === 'reseeded')) return c;
      c.destroy();
      return connect(h, user);
    };
    let one = ada;
    let two = await connect(b2, BO);
    await until(async () => {
      one = await follow(one, a, ADA);
      two = await follow(two, b2, BO);
      return want(one.read().textContent) && want(two.read().textContent) && one.read().eq(two.read());
    }, 25_000, 'both rooms hold everything').catch((e: Error) => {
      if (process.env.PEER_LOG) console.log('ADA ROOM', pandocMarkdown.serialize(one.read()), '\nBO ROOM', pandocMarkdown.serialize(two.read()), '\nFILE A', file(dirA), '\nFILE B', file(dirB));
      throw e;
    });
    expect(one.read().textContent.match(/We counted/g)).toHaveLength(1);
    await until(() => file(dirA) === file(dirB) && head(dirA) === head(dirB) && git(dirA, 'status', '--porcelain') === '' && git(dirB, 'status', '--porcelain') === '', 25_000, 'files and branches the same');
    expect(want(file(dirA))).toBe(true);
  });
});

describe('a shared room and a third device', () => {
  it('takes a commit from a device not in the room into the room once', async () => {
    const { a, b, dirA, dirB } = await pair();
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-c-'));
    dirs.push(parent);
    const dirC = join(parent, 'notes');
    await joinWorkspace({ dir: dirC, invitation: await inviteFrom(a), name: 'cee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000 });
    git(dirC, 'config', 'user.name', 'Cy');
    git(dirC, 'config', 'user.email', 'cy@example.org');
    // Cee edits apart (its host not running); Ada and Bo have the document open together.
    writeFileSync(join(dirC, 'notes.md'), NOTES.replace('We counted crabs.', 'We counted many crabs.'));
    git(dirC, 'commit', '-q', '-am', 'Cy, apart');
    const ada = await connect(a, ADA);
    const bo = await connect(b, BO);
    ada.write(insertAt(ada.read(), 'It rained', 'Ada: '));
    await until(() => bo.read().textContent.includes('Ada: '), 15_000, 'the shared room');
    await start(dirC);
    const want = (t: string) => t.includes('We counted many crabs.') && t.includes('Ada: It rained');
    await until(() => want(ada.read().textContent) && want(bo.read().textContent), 25_000, 'Cy’s edit in the room');
    expect(ada.read().textContent.match(/many/g)).toHaveLength(1);
    expect(ada.read().eq(bo.read())).toBe(true);
    await until(() => want(file(dirA)) && file(dirA) === file(dirB) && file(dirB) === file(dirC) && head(dirA) === head(dirB) && head(dirB) === head(dirC), 25_000, 'all three the same');
    expect(file(dirA).match(/many/g)).toHaveLength(1);
  });
});

describe('invite links', () => {
  async function joinBy(link: string, name: string, timeoutMs = 20_000): Promise<string> {
    const parent = mkdtempSync(join(tmpdir(), `kuraa-peer-${name}-`));
    dirs.push(parent);
    const dir = join(parent, 'notes');
    await joinWorkspace({ dir, invitation: link, name, bootstrap: testnet.bootstrap as never, timeoutMs });
    git(dir, 'config', 'user.name', name);
    git(dir, 'config', 'user.email', `${name}@example.org`);
    return dir;
  }

  it('for anyone: let several people join as full devices, through any device, with the one that made it away', async () => {
    const dirA = repo();
    const a = await start(dirA);
    const link = await a.host.peers!.inviteLink({ hours: 24, once: false });
    // Used once while Ada's device is there…
    const dirB = await joinBy(link, 'bee');
    expect(file(dirB)).toBe(NOTES);
    const b = await start(dirB);
    await until(async () => (await a.host.peers!.status()).devices.some((d) => d.name === 'bee' && d.online), 15_000, 'bee paired');
    // …and again with it gone: Bo's device lets the next one in.
    await a.close();
    hosts.splice(hosts.indexOf(a), 1);
    const dirC = await joinBy(link, 'cee');
    expect(file(dirC)).toBe(NOTES);
    const c = await start(dirC);
    // A full device: its work reaches the others, and theirs reaches it.
    await api(c, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'from-cee.md', content: '# Cee\n' }) });
    await until(() => { try { return readFileSync(join(dirB, 'from-cee.md'), 'utf8') === '# Cee\n'; } catch { return false; } }, 15_000, 'cee’s work on bee');
    // Ada's device, back, takes cee in too (cee shows its link; bee vouches for it).
    const a2 = await start(dirA);
    await until(() => git(dirA, 'remote').split('\n').includes('cee'), 20_000, 'Ada’s device pairs with cee');
    await until(() => { try { return readFileSync(join(dirA, 'from-cee.md'), 'utf8') === '# Cee\n'; } catch { return false; } }, 20_000, 'cee’s work on Ada’s device');
    void b;
    void a2;
  });

  it('let a device join only through one the link’s maker vouches for, not through anyone who knows the workspace’s secret', async () => {
    const dirA = repo();
    const a = await start(dirA);
    const link = await a.host.peers!.inviteLink({ hours: 24, once: false });
    const l = decodeLink(link);
    await a.close();
    hosts.splice(hosts.indexOf(a), 1);
    // Mallory has the workspace's secret (an old link, say) and a copy, and a device that takes the link.
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-m-'));
    dirs.push(parent);
    const dirM = join(parent, 'notes');
    execFileSync('git', ['clone', '-q', dirA, dirM]);
    const mallory = new Identity(new Git(dirM), join(dirM, '.git', 'kuraa'));
    await mallory.adopt({ id: l.workspace.id, secret: git(dirA, 'config', 'kuraa.secret'), forkedFrom: null });
    await mallory.addMember(l.issuer.key, l.issuer.name);
    await start(dirM);
    // The device joining hears from her, but does not join through her.
    await expect(joinBy(link, 'late', 6000)).rejects.toThrow('Could not reach');
  });

  it('for one person: let one device in, then no one else, wherever they try', async () => {
    const dirA = repo();
    const a = await start(dirA);
    const link = await inviteFrom(a);
    expect(decodeLink(link).once).toBe(true);
    const dirB = await joinBy(link, 'bee');
    const b = await start(dirB);
    await until(async () => (await b.host.peers!.status()).devices.some((d) => d.online), 15_000, 'bee paired');
    expect((await a.host.peers!.links()).map((l) => l.state)).toEqual(['used']);
    // Used up on every device: Bo's device learns it too, and lets no one else in by it.
    await until(async () => (await b.host.peers!.node.identity.revokedLinks()).includes(decodeLink(link).id), 15_000, 'Bo’s device learns it was used');
    await expect(joinBy(link, 'late', 20_000)).rejects.toThrow('Could not join: the link was used, or revoked');
  });

  it('stop working once revoked (on every device) or expired, whichever member made them', async () => {
    const dirA = repo();
    const a = await start(dirA);
    const link = await a.host.peers!.inviteLink({ hours: 24, once: false });
    const dirB = await joinBy(link, 'bee');
    const b = await start(dirB);
    await until(async () => (await b.host.peers!.status()).devices.some((d) => d.online), 15_000, 'bee paired');
    // Revoked on Ada's device: Bo's device learns it, and no one gets in by it, there or here.
    const { id } = decodeLink(link);
    await a.host.peers!.revokeLink(id);
    await until(() => { try { return git(dirB, 'config', '--get-all', 'kuraa.revokedlinks') === id; } catch { return false; } }, 15_000, 'Bo’s device learns of the revocation');
    expect((await a.host.peers!.links()).map((l) => l.state)).toEqual(['revoked']);
    await expect(joinBy(link, 'late', 20_000)).rejects.toThrow('Could not join: the link was revoked');
    // Expired: refused before looking.
    const expired = await a.host.peers!.inviteLink({ hours: -1, once: false });
    await expect(joinBy(expired, 'later', 4000)).rejects.toThrow('This invite link has expired');
    // A link the member that joined last made lets people in like any other.
    const fromBo = await b.host.peers!.inviteLink({ hours: 24, once: false });
    expect(file(await joinBy(fromBo, 'welcome'))).toBe(NOTES);
  });
});

describe('finding each other, and what it costs (0050)', () => {
  /** DHT bootstrap servers that answer nothing: no internet, as far as the DHT goes. */
  const nowhere = [{ host: '127.0.0.1', port: 9 }];

  it('find each other on the local network with no DHT to reach: join, and sync', async () => {
    const dirA = repo();
    const a = await start(dirA, { bootstrap: nowhere });
    const invitation = await inviteFrom(a);
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-lan-'));
    dirs.push(parent);
    const dirB = join(parent, 'notes');
    await joinWorkspace({ dir: dirB, invitation, name: 'bee', bootstrap: nowhere as never, timeoutMs: 20_000 });
    expect(file(dirB)).toBe(NOTES);
    const b = await start(dirB, { bootstrap: nowhere });
    await until(async () => (await a.host.peers!.status()).devices.some((d) => d.online) && (await b.host.peers!.status()).devices.some((d) => d.online), 15_000, 'both online');
    await api(a, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'from-ada.md', content: '# From Ada\n' }) });
    await until(() => { try { return readFileSync(join(dirB, 'from-ada.md'), 'utf8') === '# From Ada\n'; } catch { return false; } }, 15_000, 'Ada’s file on Bo’s device');
  });

  it('carry no secret in a link: members announce its topic while it lets people in, and not after', async () => {
    const dirA = repo();
    const a = await start(dirA);
    const link = await a.host.peers!.inviteLink({ hours: 24, once: false });
    const l = decodeLink(link);
    const secret = git(dirA, 'config', 'kuraa.secret');
    expect(l.workspace.secret).toBeNull();
    expect(Buffer.from(link.slice('kuraa-invite:'.length), 'base64url').toString()).not.toContain(secret);
    const on = () => [...(a.host.peers!.node as unknown as { discoveries: Map<string, unknown> }).discoveries.keys()];
    expect(on()).toContain(l.topic);
    // The device joining gets the secret from the device that lets it in.
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
    dirs.push(parent);
    await joinWorkspace({ dir: join(parent, 'notes'), invitation: link, name: 'bee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000 });
    expect(git(join(parent, 'notes'), 'config', 'kuraa.secret')).toBe(secret);
    await a.host.peers!.revokeLink(l.id);
    expect(on()).not.toContain(l.topic);
  });

  it('make the secret anew when a device is removed: the members get it, the removed device does not', async () => {
    const { a, b, dirA, dirB } = await pair();
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-c-'));
    dirs.push(parent);
    const dirC = join(parent, 'notes');
    await joinWorkspace({ dir: dirC, invitation: await inviteFrom(a), name: 'cee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000 });
    const c = await start(dirC);
    await until(async () => (await c.host.peers!.status()).devices.filter((d) => d.online).length === 2, 15_000, 'cee online with both');
    const old = git(dirA, 'config', 'kuraa.secret');
    await a.host.peers!.removeDevice(c.host.peers!.node.myKey);
    const now = git(dirA, 'config', 'kuraa.secret');
    expect(now).not.toBe(old);
    await until(() => git(dirB, 'config', 'kuraa.secret') === now, 15_000, 'Bo’s device has the new secret');
    // Cee learned it was removed, and nothing of the new secret.
    await until(() => { try { return git(dirC, 'config', '--get-all', 'kuraa.removed').includes(c.host.peers!.node.myKey) || !existsSync(join(dirC, '.git', 'kuraa', 'peer.json')); } catch { return !existsSync(join(dirC, '.git', 'kuraa', 'peer.json')); } }, 15_000, 'cee told it was removed');
    expect(git(dirC, 'config', 'kuraa.secret')).toBe(old);
    expect(readFileSync(join(dirC, '.git', 'kuraa', 'records.json'), 'utf8')).not.toContain(now);
    // And Bo's device finds Ada's by the new secret's topics.
    const topics = (h: RunningHost) => [...(h.host.peers!.node as unknown as { discoveries: Map<string, { client: boolean }> }).discoveries].filter(([, t]) => t.client).map(([k]) => k).sort();
    await until(() => topics(b).join() === topics(a).join(), 5000, 'Bo’s device on the new topics');
    expect(topics(a)).toEqual(topicsFor(now).map((t) => t.toString('hex')).sort());
  });

  it('fetch from a device only for commits this one lacks', async () => {
    const { a, b, dirA, dirB } = await pair();
    const count = (h: RunningHost) => {
      const node = h.host.peers!.node;
      const fetch = node.fetch.bind(node);
      const seen = { n: 0 };
      node.fetch = (remote: string) => {
        seen.n++;
        return fetch(remote);
      };
      return seen;
    };
    const fromA = count(a);
    const fromB = count(b);
    // Ada commits: Bo's device fetches it once; its branch moves, and it says so, but Ada's device has
    // that commit already, and fetches nothing.
    await api(a, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'one.md', content: '# One\n' }) });
    await until(() => head(dirA) === head(dirB), 15_000, 'the same commit on both');
    await new Promise((r) => setTimeout(r, 1000));
    expect(fromB.n).toBe(1);
    expect(fromA.n).toBe(0);
    // And it knows where Bo's branch is, as a fetch would have told it.
    expect(git(dirA, 'rev-parse', `refs/remotes/bee/main`)).toBe(head(dirB));
  });

  it('say which records they hold as a hash, and offer the members a relay', async () => {
    const { a, b } = await pair();
    const link = b.host.peers!.node.links.get(a.host.peers!.node.myKey)!;
    expect(link.hello).not.toHaveProperty('records');
    expect(link.hello!.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(link.hello!.relay).toBe(a.host.peers!.node.relayOffered);
    expect(link.hello!.relay).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('weekly topics', () => {
  it('change each week, and two devices a little apart in time share one', () => {
    const secret = 'ab'.repeat(32);
    const week = 7 * 24 * 3600_000;
    const t = 100 * week + 1000;
    const [now, last] = topicsFor(secret, t).map((b) => b.toString('hex'));
    expect(topicsFor(secret, t + week)[1]!.toString('hex')).toBe(now);
    expect(last).not.toBe(now);
    // A device whose clock is a day behind, across a week's start, still shares one.
    const behind = topicsFor(secret, t - 2000).map((b) => b.toString('hex'));
    expect(behind.some((x) => x === now || x === last)).toBe(true);
  });
});

describe('another version of kuraa', () => {
  it('say when a device runs a newer or older kuraa, and do not sync with it until one is updated', async () => {
    const { a, b } = await pair();
    const { versionNews } = await import('../src/peers/node.js');
    const newer: string[] = [];
    const heard = () => newer.push('newer');
    versionNews.on('newer', heard);
    try {
      // Bo's device as a later kuraa: what it says is of a protocol Ada's does not know.
      const bNode = b.host.peers!.node as unknown as { helloFor(l: unknown): Promise<object>; links: Map<string, { close(): void }>; dial(key: string): void };
      const helloFor = bNode.helloFor.bind(bNode);
      bNode.helloFor = async (l) => ({ ...(await helloFor(l)), protocol: 99 });
      const ada = a.host.peers!.node.myKey;
      bNode.links.get(ada)!.close();
      bNode.dial(ada);
      await until(async () => (await a.host.peers!.status()).devices.some((d) => d.name === 'bee' && d.kuraa === 'newer'), 15_000, 'Ada’s device: bee runs a newer kuraa');
      expect(newer.length).toBeGreaterThan(0);
      const bee = (await a.host.peers!.status()).devices.find((d) => d.name === 'bee')!;
      expect(bee.online).toBe(false);
    } finally {
      versionNews.off('newer', heard);
    }
  });
});

describe('reaching each other however the networks are (0053)', () => {
  /** Join a workspace from an invite link, into a new folder. */
  async function joinInto(invitation: string, name: string, o: { bootstrap?: unknown[]; lan?: boolean } = {}): Promise<string> {
    const parent = mkdtempSync(join(tmpdir(), `kuraa-peer-${name}-`));
    dirs.push(parent);
    const dir = join(parent, 'notes');
    await joinWorkspace({ dir, invitation, name, bootstrap: (o.bootstrap ?? testnet.bootstrap) as never, timeoutMs: 20_000, lan: o.lan });
    git(dir, 'config', 'user.name', name);
    git(dir, 'config', 'user.email', `${name}@example.org`);
    return dir;
  }
  const deviceKey = (dir: string) => (JSON.parse(readFileSync(join(dir, '.git', 'kuraa', 'device.json'), 'utf8')) as { publicKey: string }).publicKey;
  const close = async (h: RunningHost) => {
    await h.close();
    hosts.splice(hosts.indexOf(h), 1);
  };

  it('say when this computer cannot reach the DHT at all (UDP blocked, or no network)', async () => {
    const a = await start(repo(), { bootstrap: [{ host: '127.0.0.1', port: 9 }], net: { lan: false } });
    await until(async () => (await a.host.peers!.status()).network.kind === 'unreachable', 30_000, 'unreachable');
  });

  it('go through a device both reach, when they cannot reach each other: end to end, and git and rooms over it', async () => {
    const blocked = new Set<string>();
    const dirA = repo();
    const a = await start(dirA, { net: { computer: 'a', direct: (k) => !blocked.has(k), tunnelAfterMs: 300 } });
    const dirB = await joinInto(await inviteFrom(a), 'bee');
    const b = await start(dirB, { net: { computer: 'b' } });
    await until(async () => (await b.host.peers!.status()).devices.some((d) => d.online), 15_000, 'bee online');
    const dirC = await joinInto(await b.host.peers!.inviteLink({ hours: 1, once: true }), 'cee');
    // Ada's and Cee's computers cannot reach each other (two hard networks, say): only Bee's reaches both.
    blocked.add(deviceKey(dirC));
    const c = await start(dirC, { net: { computer: 'c', direct: (k) => k !== a.host.peers!.node.myKey, tunnelAfterMs: 300 } });
    await until(async () => (await a.host.peers!.status()).devices.some((d) => d.name === 'cee' && d.via === 'tunnel'), 20_000, 'Cee reached through Bee');
    expect((await c.host.peers!.status()).devices.find((d) => d.name === 'disruptive-practice' || d.key === a.host.peers!.node.myKey)?.via).toBe('tunnel');
    // Work done on Cee's device comes straight to Ada's, over the tunnel.
    await api(c, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'from-cee.md', content: '# From Cee\n' }) });
    await until(() => existsSync(join(dirA, 'from-cee.md')), 15_000, 'Cee’s file on Ada’s device');
    // Bee passed on only what it could not read: it has no link to either end of the tunnel's own.
    expect(b.host.peers!.node.links.get(c.host.peers!.node.myKey)?.accepted).toBe(true);
  });

  it('connect a second shared workspace over the link of the first, between the same two computers', async () => {
    const blocked = new Set<string>();
    const dirA1 = repo();
    const dirA2 = repo();
    const a1 = await start(dirA1, { net: { computer: 'x' } });
    const a2 = await start(dirA2, { net: { computer: 'x', direct: (k) => !blocked.has(k) } });
    const dirB1 = await joinInto(await inviteFrom(a1), 'one');
    const dirB2 = await joinInto(await inviteFrom(a2), 'two');
    const b1 = await start(dirB1, { net: { computer: 'y' } });
    await until(async () => (await b1.host.peers!.status()).devices.some((d) => d.online), 15_000, 'the first workspace connected');
    // The second workspace's devices cannot find each other by themselves: through the first's link, they do.
    blocked.add(deviceKey(dirB2));
    const b2 = await start(dirB2, { net: { computer: 'y', direct: (k) => k !== a2.host.peers!.node.myKey } });
    await until(async () => (await b2.host.peers!.status()).devices.some((d) => d.online && d.via === 'tunnel'), 20_000, 'the second workspace connected over the first');
    await api(b2, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'two.md', content: '# Two\n' }) });
    await until(() => existsSync(join(dirA2, 'two.md')), 15_000, 'the second workspace syncs');
  });

  it('join and sync with a server over TCP, by the invite link’s hints, with no DHT and no local network', async () => {
    const nowhere = [{ host: '127.0.0.1', port: 9 }];
    const free = await new Promise<number>((resolve) => {
      const srv = createServer().listen(0, () => {
        const { port } = srv.address() as { port: number };
        srv.close(() => resolve(port));
      });
    });
    const dirS = repo();
    const s = await start(dirS, { net: { peerPort: free, publicAddress: '127.0.0.1', dhtPort: 49999 } });
    const link = await s.host.peers!.inviteLink({ hours: 1, once: false });
    expect(decodeLink(link).hints?.tcp).toEqual([`${s.host.peers!.node.myKey}@127.0.0.1:${free}`]);
    // A device on a network the DHT cannot cross (UDP blocked), and alone on its local network.
    const dirD = await joinInto(link, 'desk', { bootstrap: nowhere, lan: false });
    expect(file(dirD)).toBe(NOTES);
    // Its host goes on by the server's address, which the server told it.
    const d = await start(dirD, { bootstrap: nowhere, net: { lan: false } });
    await until(async () => (await d.host.peers!.status()).devices.some((x) => x.online && x.via === 'tcp'), 20_000, 'the server reached over TCP');
    // What the server tells its members: where it takes TCP, and its DHT node to start from.
    const hello = d.host.peers!.node.links.get(s.host.peers!.node.myKey)!.hello!;
    expect(hello.tcp).toEqual([`127.0.0.1:${free}`]);
    expect(hello.dht).toBe('127.0.0.1:49999');
    await api(s, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'from-server.md', content: '# Hi\n' }) });
    await until(() => existsSync(join(dirD, 'from-server.md')), 15_000, 'the server’s file on the desk');
    // When it last saw the server is kept.
    await close(s);
    await until(async () => (await d.host.peers!.status()).devices.every((x) => !x.online && x.lastSeen !== null), 20_000, 'the server gone, and when it was last seen');
  });
});
