// Devices of one workspace, on a local DHT: joining by invite link, git between
// them both ways, work done apart merged the same way on each, people on two
// devices editing one document live, and every member with the same say (0038).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { searchFeature } from '@kuraa/search';
import { connectHeadless, type HeadlessClient } from '@kuraa/session/testing';
import { commitSigner } from '../src/signing.js';
import { sign, signRecord, signsMessage, vouchMessage } from '../src/peers/records.js';
import { createPerson, type Person } from '../src/peers/person.js';
import { joinWorkspace as joinWorkspaceAs, startHost, type RunningHost } from '../src/index.js';
import type { PeerOptions } from '../src/peers/peers.js';
import type { RunOptions } from '../src/runner.js';
import type { HostTimings } from '../src/host.js';
import type { RunRecord } from '@kuraa/session/model';
import { hashText } from '@kuraa/kernel';
import { Git } from '../src/git.js';
import { Identity, decodeLink, topicsFor } from '../src/peers/identity.js';
import type { PeerNode } from '../src/peers/node.js';
import type { JoinProgress } from '../src/peers/join.js';
import type { HostFeature } from '@kuraa/feature-kit/host';
import { marksFeature, readMarks } from '@kuraa/feature-example';
import syncGit from '@kuraa/sync-git';

/** A 1×1 PNG: an image to add (0109). */
const PIXEL = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1d5e5a90000000049454e44ae426082', 'hex');
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

/** How much longer to wait on a slow computer (KURAA_TEST_SLOW=2: twice as long). */
const SLOW = Number(process.env.KURAA_TEST_SLOW ?? 1) || 1;

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms * SLOW;
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
const signingKeyFor = (dir: string) => {
  if (!signingKeys.has(dir)) signingKeys.set(dir, crypto.keyPair());
  return signingKeys.get(dir)!;
};

/**
 * Each device's person, made the first time it is asked for, as the app makes
 * one for whoever runs it: a device is in a workspace only as someone (0072).
 */
const people = new Map<string, Person>();
const NAMES = new Map([['bee', 'Bo'], ['cee', 'Cy'], ['dee', 'Dee']]);
async function personFor(dir: string, name?: string): Promise<Person> {
  let p = people.get(dir);
  if (!p) {
    const home = mkdtempSync(join(tmpdir(), 'kuraa-peer-person-'));
    dirs.push(home);
    p = await createPerson(name ?? 'Ada', join(home, 'person.json'));
    people.set(dir, p);
  }
  return p;
}

/**
 * A device of someone the owner puts in the workspace (0072), told to a host's
 * device as its records: its own key (above or below the given key, if asked),
 * the key it signs with, and its person's vouch for it. Its key.
 */
async function deviceOfSomeone(owner: RunningHost, name: string, o: { above?: string; below?: string } = {}): Promise<string> {
  let device = crypto.keyPair();
  const hexOf = (k: { publicKey: Buffer }) => k.publicKey.toString('hex');
  while ((o.above && hexOf(device) <= o.above) || (o.below && hexOf(device) >= o.below)) device = crypto.keyPair();
  const person = await personFor(`device:${hexOf(device)}`, name);
  const key = crypto.keyPair();
  const ws = (await owner.host.peers!.node.identity.workspace())!.id;
  const m = vouchMessage(hexOf(key), person.id, name);
  await owner.host.peers!.node.identity.takeRecords([
    ...person.events.map((e) => signRecord({ kind: 'key-event', workspace: ws, subject: person.id, event: e }, device)),
    signRecord({ kind: 'signs', workspace: ws, subject: hexOf(key), proof: sign(signsMessage(hexOf(device)), key), name }, device),
    signRecord({ kind: 'vouch', workspace: ws, subject: hexOf(key), person: person.id, personKey: hexOf(person), name, proof: sign(m, person), keyProof: sign(m, key) }, device),
  ]);
  await owner.host.peers!.setRole(person.id, 'member');
  return hexOf(device);
}

/** Join as the device's person, with its signing key (each made on first use). */
async function joinWorkspace(o: Parameters<typeof joinWorkspaceAs>[0]) {
  const person = o.person ?? (await personFor(o.dir, NAMES.get(o.name ?? '') ?? o.name));
  return joinWorkspaceAs({ ...o, person, signing: o.signing ?? signingKeyFor(o.dir) });
}

type Net = Pick<PeerOptions, 'direct' | 'computer' | 'tunnelAfterMs' | 'lan' | 'peerPort' | 'publicAddress' | 'dhtPort' | 'outputsPublishMs'>;

async function start(dir: string, extra: { types?: DocumentType[]; person?: Person; invites?: object; run?: RunOptions; node?: PeerNode; dialMs?: number; lookupsMs?: number[]; bootstrap?: unknown[]; net?: Net; timings?: Partial<HostTimings>; features?: HostFeature[] } = {}): Promise<RunningHost> {
  const { person, node, dialMs, lookupsMs, bootstrap, net, timings, ...rest } = extra;
  const h = await startHost({ features: [searchFeature], ...rest, dir, timings: { ...FAST, ...timings }, peers: { bootstrap: (bootstrap ?? testnet.bootstrap) as never, signing: signingKeyFor(dir), person: person ?? (await personFor(dir)), node, dialMs, lookupsMs, ...net }, log: process.env.PEER_LOG ? (m) => console.log(`[${dir.slice(-6)}] ${m}`) : undefined });
  hosts.push(h);
  return h;
}

/** An invite link for one person, made on a host's device. */
const inviteFrom = (h: RunningHost) => h.host.peers!.inviteLink({ hours: 24, once: true });

/** Two paired devices: Ada's (the first) and Bo's (joined by an invite link). */
async function pair(first: Parameters<typeof start>[1] = {}, second: Parameters<typeof start>[1] = {}): Promise<{ a: RunningHost; b: RunningHost; dirA: string; dirB: string }> {
  const dirA = repo();
  const a = await start(dirA, first);
  const invitation = await inviteFrom(a);
  const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
  dirs.push(parent);
  const dirB = join(parent, 'notes');
  await joinWorkspace({ dir: dirB, invitation, name: 'bee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, log: process.env.PEER_LOG ? (m) => console.log(`[join] ${m}`) : undefined });
  git(dirB, 'config', 'user.name', 'Bo');
  git(dirB, 'config', 'user.email', 'bo@example.org');
  const b = await start(dirB, second);
  await until(async () => (await a.host.peers!.status()).devices.some((d) => d.online) && (await b.host.peers!.status()).devices.some((d) => d.online), 15_000, 'both online');
  return { a, b, dirA, dirB };
}

const api = (h: RunningHost, path: string, init: RequestInit = {}) =>
  fetch(h.url + path, { ...init, headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' } });

/** The room each client was given. */
const roomOf = new WeakMap<HeadlessClient, string>();

async function connect(h: RunningHost, user = ADA): Promise<HeadlessClient> {
  const { room } = (await (await api(h, '/api/rooms?path=notes.md')).json()) as { room: string };
  const c = connectHeadless({ url: h.url.replace(/^http/, 'ws') + '/collab', room, token: h.token, user, schema: pandocMarkdown.schema });
  clients.push(c);
  roomOf.set(c, room);
  await c.ready;
  return c;
}

/** A room replaced by another device's session of it (0077): followed, as the app does (Editor.vue, on reseeded). */
async function follow(c: HeadlessClient, h: RunningHost, user: typeof ADA): Promise<HeadlessClient> {
  if (!c.messages.some((m) => m.type === 'reseeded')) return c;
  c.destroy();
  return connect(h, user);
}

/**
 * People on two devices in one session of the document, before they type. Two devices that open it at
 * once can each start a session, not yet knowing of the other's (on a slow computer, often); when they
 * meet, one gives way (0077) and its clients are told to follow, as the app does. Returns the clients,
 * each in the session its device has now.
 */
async function together(...people: { c: HeadlessClient; h: RunningHost; user: typeof ADA }[]): Promise<HeadlessClient[]> {
  await until(async () => {
    for (const p of people) p.c = await follow(p.c, p.h, p.user);
    const rooms = people.map((p) => p.h.host.liveRooms()[0]);
    return rooms.every((r) => r && r.session === rooms[0]!.session) && people.every((p, i) => roomOf.get(p.c) === rooms[i]!.name);
  }, 20_000, 'one session on both devices');
  return people.map((p) => p.c);
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
/** The file as it is now; none while git replaces it (it takes a file away before writing the new one). */
const file = (dir: string) => {
  try {
    return readFileSync(join(dir, 'notes.md'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
};

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

  it('bring in a commit naming policy no one holds, once the device it came from says it does not hold it either', async () => {
    const { b, dirA, dirB } = await pair();
    await b.close();
    hosts.splice(hosts.indexOf(b), 1);
    // A commit saying it was made under a policy operation that does not exist: waited for, it would never come.
    writeFileSync(join(dirA, 'notes.md'), NOTES.replace('The tide was out.', 'The tide was far out.'));
    git(dirA, 'commit', '-q', '-am', `Ada, apart\n\nKuraa-Policy: ${'ee'.repeat(32)}`);
    await start(dirB);
    await until(() => head(dirB) === head(dirA), 20_000, 'the commit brought in');
    expect(file(dirB)).toContain('The tide was far out.');
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
    const [ada, bo] = await together({ c: await connect(a, ADA), h: a, user: ADA }, { c: await connect(b, BO), h: b, user: BO }) as [HeadlessClient, HeadlessClient];
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
    // Whoever edited on the other device is credited as the records say who that device is (by name: no address
    // is checked since 0078), not as its messages say.
    const committer = git(dirA, 'log', '-1', '--format=%an');
    const other = committer === 'Ada' ? 'Bo' : 'Ada';
    expect(body).toContain(`Co-authored-by: ${committer} <${committer.toLowerCase()}@example.org>`);
    expect(body).not.toContain(`Co-authored-by: ${other} <`);
    expect(body).toContain('Kuraa-Kind: autosave');
  });
});

describe('annotations are their authors’ own (0082)', () => {
  it('someone who may not change a document marks it: live on the other device, committed as theirs, taken there despite the rule', async () => {
    const { a, b, dirA, dirB } = await pair({ features: [marksFeature] }, { features: [marksFeature] });
    const adaId = (await personFor(dirA)).id;
    const boId = (await personFor(dirB)).id;
    // Only Ada may change the document; marks on for the workspace.
    await a.host.peers!.setRule('notes.md', [adaId]);
    expect((await api(a, '/api/features/marks', { method: 'PATCH', body: JSON.stringify({ on: true, by: ADA }) })).status).toBe(200);
    await until(() => existsSync(join(dirB, '.kuraa/features.json')), 20_000, 'marks on, on Bo’s device too');
    await until(async () => ((await (await api(b, '/api/access?path=notes.md')).json()) as { canWrite: boolean }).canWrite === false, 20_000, 'the rule on Bo’s device');
    const [ada, bo] = await together({ c: await connect(a, ADA), h: a, user: ADA }, { c: await connect(b, BO), h: b, user: BO }) as [HeadlessClient, HeadlessClient];
    await until(() => bo.feature('marks', boId).people().includes(boId) || Object.keys(bo.feature('marks', boId).entries()).length === 0, 10_000, 'Bo’s map');
    // Bo marks a passage.
    const doc = bo.read();
    let at = -1;
    doc.descendants((n, pos) => {
      if (at < 0 && n.isText && n.text!.includes('tide')) at = pos + n.text!.indexOf('tide');
      return at < 0;
    });
    const f = bo.feature('marks', boId);
    await until(() => (bo.read().textContent.length > 0), 5000, 'the document');
    f.update({ set: { b1: { from: f.anchorAt(at, 1), to: f.anchorAt(at + 4, -1), quote: 'tide', by: 'Bo', color: '#33d' } } });
    // Ada sees it live: Bo's own map, from his device.
    await until(() => Object.keys(ada.feature('marks', boId).entries()).length === 1, 15_000, 'Bo’s mark live on Ada’s device');
    // Bo's device writes his own file, signed as his; Ada's device takes it, the rule on the document notwithstanding.
    const own = `notes.md.marks/@${boId}.json`;
    await until(() => existsSync(join(dirB, own)) && git(dirB, 'status', '--porcelain') === '', 20_000, 'Bo’s file committed on his device');
    await until(() => existsSync(join(dirA, own)), 30_000, 'Bo’s file on Ada’s device');
    expect(readMarks(readFileSync(join(dirA, own), 'utf8')).map((m) => m.quote)).toEqual(['tide']);
    expect(git(dirA, 'log', '--format=%B', '-n', '20')).not.toContain('Kuraa-Refused');
    // Bo's edit to the document itself is not taken on Ada's device.
    bo.write(insertAt(bo.read(), 'The tide', 'Bo was here: '));
    await new Promise((r) => setTimeout(r, 1500));
    expect(ada.read().textContent).not.toContain('Bo was here');
  });
});

describe('a personal backup (0115)', () => {
  it('judges what its backup holds as work from its person’s own device, and every other device judges it alike', async () => {
    const { a, b, dirA, dirB } = await pair({ run: { engines: [], components: [syncGit] } });
    const adaId = (await personFor(dirA)).id;
    const boId = (await personFor(dirB)).id;
    // Only Ada may change the notes; only Bo may make other.md.
    await a.host.peers!.setRule('notes.md', [adaId]);
    await a.host.peers!.setRule('other.md', [boId]);
    await until(async () => ((await (await api(b, '/api/access?path=notes.md')).json()) as { canWrite: boolean }).canWrite === false, 20_000, 'the rules on Bo’s device');
    // Ada's backup: an empty repository, everything pushed to it.
    const bare = mkdtempSync(join(tmpdir(), 'kuraa-backup-'));
    dirs.push(bare);
    git(bare, 'init', '-q', '--bare', '-b', 'main');
    git(dirA, 'remote', 'add', 'backup', bare);
    git(dirA, 'config', '--add', 'kuraa.online', 'backup');
    expect((await a.host.syncNow()).ok).toBe(true);
    // Something no device of the workspace made reaches it: unsigned, as plain git makes it, pushed there directly.
    const elsewhere = mkdtempSync(join(tmpdir(), 'kuraa-elsewhere-'));
    dirs.push(elsewhere);
    git(elsewhere, 'clone', '-q', bare, '.');
    git(elsewhere, 'config', 'user.name', 'Someone');
    git(elsewhere, 'config', 'user.email', 'someone@example.org');
    writeFileSync(join(elsewhere, 'notes.md'), `${NOTES}\nAdded at the backup.\n`);
    writeFileSync(join(elsewhere, 'other.md'), 'Not Ada’s to make.\n');
    git(elsewhere, 'add', '-A');
    git(elsewhere, 'commit', '-q', '-m', 'At the backup');
    git(elsewhere, 'push', '-q', 'origin', 'main');
    // Ada's device brings it in as hers: the notes taken, other.md (Bo's alone) kept out, on record.
    await a.host.syncNow();
    await until(() => file(dirA).includes('Added at the backup.'), 15_000, 'the backup’s change on Ada’s device');
    expect(existsSync(join(dirA, 'other.md'))).toBe(false);
    expect(git(dirA, 'log', '-1', '--format=%B')).toMatch(/Kuraa-Refused: [0-9a-f]+ other\.md/);
    // Bo's device, taking it from Ada's, judges it the same: the same files, the same history.
    await until(() => head(dirB) === head(dirA), 30_000, 'Bo’s device at Ada’s commit');
    expect(file(dirB)).toContain('Added at the backup.');
    expect(existsSync(join(dirB, 'other.md'))).toBe(false);
  });
});

describe('run outputs between devices (0058)', () => {
  const ECHO = join(import.meta.dirname, 'fixtures/echo-engine.mjs');
  const ENVS = join(import.meta.dirname, 'fixtures/environments.mjs');
  const runsOn = async (h: RunningHost) => ((await (await api(h, '/api/runs?path=notes.md')).json()) as { runs: RunRecord[] }).runs;

  it('show a chunk run on one device on the other, outside the branches, and clear it on both from either', async () => {
    const { a, b, dirA, dirB } = await pair({ run: { engines: ['echo'], environment: 'fake', components: [ECHO, ENVS] } });
    const res = await api(a, '/api/runs', { method: 'POST', body: JSON.stringify({ path: 'notes.md', engine: 'echo', code: 'crabs', chunk: { label: 'count', index: 0, codeHash: hashText('crabs') }, by: ADA }) });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as RunRecord;
    await until(async () => (await runsOn(a)).some((r) => r.id === id), 15_000, 'the run done on Ada’s device');
    // Bo's device, which runs no code, shows it, saying where it ran; a person with the document open there is told.
    const bo = await connect(b, BO);
    const told = bo.messages;
    await until(async () => (await runsOn(b)).some((r) => r.id === id), 20_000, 'Ada’s run on Bo’s device');
    const shown = (await runsOn(b)).find((r) => r.id === id)!;
    expect(shown).toMatchObject({ by: { name: 'Ada' }, device: git(dirB, 'remote'), chunk: { label: 'count' }, state: 'done' });
    expect(shown.outputs[0]).toMatchObject({ type: 'text', text: expect.stringContaining('echo crabs') });
    await until(() => told.some((m) => m.type === 'run' && m.run.id === id), 5000, 'Bo told of the run');
    // Its own ref on each device: not a branch, never checked out, and the working trees untouched.
    const adaKey = (await a.host.peers!.status()).device.key;
    expect(git(dirB, 'for-each-ref', '--format=%(refname)', 'refs/kuraa/outputs/')).toBe(`refs/kuraa/outputs/${adaKey}`);
    expect(git(dirB, 'rev-parse', `refs/kuraa/outputs/${adaKey}`)).toBe(git(dirA, 'rev-parse', `refs/kuraa/outputs/${adaKey}`));
    expect(git(dirB, 'branch', '-a', '--format=%(refname)').split('\n').every((r) => r.startsWith('refs/heads/') || r.startsWith('refs/remotes/'))).toBe(true);
    expect(git(dirA, 'status', '--porcelain')).toBe('');
    expect(git(dirB, 'status', '--porcelain')).toBe('');
    // Cleared on Bo's device: gone there at once, and from Ada's once it hears.
    expect((await api(b, '/api/runs/clear', { method: 'POST', body: JSON.stringify({ path: 'notes.md', chunk: shown.chunk }) })).status).toBe(200);
    expect((await runsOn(b)).some((r) => r.id === id)).toBe(false);
    await until(() => told.some((m) => m.type === 'runs-removed' && m.ids.includes(id)), 5000, 'Bo told it is gone');
    await until(async () => !(await runsOn(a)).some((r) => r.id === id), 20_000, 'gone from Ada’s device too');
  });

  it('show a run on a device with its document open as it goes, before any publish, and clear it there at once (0062)', async () => {
    // Ada's device publishes nothing by git within the test: whatever reaches Bo's comes as it happened.
    const { a, b, dirA } = await pair({ run: { engines: ['echo'], environment: 'fake', components: [ECHO, ENVS] }, net: { outputsPublishMs: 600_000 } });
    const bo = await connect(b, BO);
    await until(() => a.host.peers!.rooms.devicesWith('notes.md').length === 1, 15_000, 'Ada’s device to know Bo’s has the document open');
    const res = await api(a, '/api/runs', { method: 'POST', body: JSON.stringify({ path: 'notes.md', engine: 'echo', code: 'gulls', chunk: { label: 'birds', index: 0, codeHash: hashText('gulls') }, by: ADA }) });
    const { id } = (await res.json()) as RunRecord;
    const told = (state: string) => bo.messages.find((m) => m.type === 'run' && m.run.id === id && m.run.state === state) as { run: RunRecord } | undefined;
    await until(() => !!told('done'), 5000, 'Bo told the run is done');
    // Told it was under way, saying where, then done, with its output.
    expect(told('queued')?.run ?? told('running')?.run).toMatchObject({ device: expect.any(String), by: { name: 'Ada' } });
    expect(told('done')!.run).toMatchObject({ device: expect.any(String), chunk: { label: 'birds' } });
    expect(told('done')!.run.outputs[0]).toMatchObject({ type: 'text', text: expect.stringContaining('echo gulls') });
    expect((await runsOn(b)).find((r) => r.id === id)).toMatchObject({ state: 'done' });
    expect(git(dirA, 'for-each-ref', 'refs/kuraa/outputs/')).toBe('');
    // Cleared on Ada's device: gone from Bo's at once, with nothing published.
    expect((await api(a, '/api/runs/clear', { method: 'POST', body: JSON.stringify({ path: 'notes.md', chunk: told('done')!.run.chunk }) })).status).toBe(200);
    await until(() => bo.messages.some((m) => m.type === 'runs-removed' && m.ids.includes(id)), 5000, 'Bo told it is gone');
    expect((await runsOn(b)).some((r) => r.id === id)).toBe(false);
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
    // Two devices of people in the workspace that Ada's device cannot reach: one with a key above its own, one below.
    // (Ada's host may be writing .git/config at the same moment: git.ts waits its turn.)
    const above = await deviceOfSomeone(a, 'above', { above: node.myKey });
    const below = await deviceOfSomeone(a, 'below', { below: node.myKey });
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

  it('look the workspace up again while a device is missing, less and less often, then at the last interval, and not while every device is here', async () => {
    const { a, b } = await joinedPair({ lookupsMs: [50, 100, 200, 1500] });
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
    // Bee goes: looked up three times, as the schedule says; then at the last interval, for as long as it is missing (0071).
    await b.close();
    hosts.splice(hosts.indexOf(b), 1);
    await until(() => lookups() === 3, 5000, 'three lookups');
    await new Promise((r) => setTimeout(r, 600));
    expect(lookups()).toBe(3);
    await until(() => lookups() === 4, 5000, 'a fourth lookup');
    await until(() => lookups() === 5, 5000, 'and a fifth, as long after');
  });
});

describe('equal members, and forks', () => {
  it('let only admins invite and remove: a link puts its holder in as a member unless it says admin (0066)', async () => {
    const people = mkdtempSync(join(tmpdir(), 'kuraa-people-'));
    dirs.push(people);
    const ada = await createPerson('Ada', join(people, 'ada', 'person.json'));
    const bo = await createPerson('Bo', join(people, 'bo', 'person.json'));
    const dirA = repo();
    const a = await start(dirA, { person: ada });
    // A workspace made now: its genesis names Ada its admin, and is pinned.
    expect((await a.host.peers!.people()).people).toEqual([{ id: ada.id, role: 'owner', name: 'Ada', devices: [a.host.peers!.node.myKey], you: true }]);
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
    dirs.push(parent);
    const dirB = join(parent, 'notes');
    signingKeys.set(dirB, crypto.keyPair());
    await joinWorkspace({ dir: dirB, invitation: await inviteFrom(a), name: 'bee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, person: bo, signing: signingKeys.get(dirB) });
    expect(git(dirB, 'config', 'kuraa.genesis')).toBe(git(dirA, 'config', 'kuraa.genesis'));
    const b = await start(dirB, { person: bo });
    const role = async (h: RunningHost, id: string) => (await h.host.peers!.people()).people.find((p) => p.id === id)?.role ?? null;
    await until(async () => (await role(a, bo.id)) === 'member' && (await role(b, bo.id)) === 'member', 15_000, 'Bo a member on both');
    // A member may not invite, nor remove a device, nor make himself an admin.
    await expect(b.host.peers!.inviteLink({ hours: 1, once: true })).rejects.toThrow('Only an admin');
    await expect(b.host.peers!.removeDevice(a.host.peers!.node.myKey)).rejects.toThrow('Only an admin');
    await expect(b.host.peers!.setRole(bo.id, 'admin')).rejects.toThrow('owner');
    expect((await api(b, `/api/peers/devices/${a.host.peers!.node.myKey}`, { method: 'DELETE' })).status).toBe(403);
    // Ada, the owner, makes him an admin: then he may invite, but only as members (admins are the owner's to make: 0070).
    expect((await a.host.peers!.people()).people.find((p) => p.id === ada.id)?.role).toBe('owner');
    await a.host.peers!.setRole(bo.id, 'admin');
    await until(async () => (await role(b, bo.id)) === 'admin', 15_000, 'Bo an admin on his device');
    expect(decodeLink(await b.host.peers!.inviteLink({ hours: 1, once: true })).grant).toMatchObject({ group: 'workspace', role: 'member' });
    await expect(b.host.peers!.inviteLink({ hours: 1, once: true, role: 'admin' })).rejects.toThrow('owner');
    await expect(b.host.peers!.setRole(ada.id, 'member')).rejects.toThrow('owner');
    await expect(b.host.peers!.removePerson(ada.id)).rejects.toThrow('owner');
    // The owner stays: she cannot take herself out; she takes Bo out, with his device.
    await expect(a.host.peers!.removePerson(ada.id)).rejects.toThrow('owner');
    await a.host.peers!.removePerson(bo.id);
    expect(await role(a, bo.id)).toBeNull();
    await until(async () => (await b.host.peers!.status()).removed, 15_000, 'Bo’s device removed');
  });

  it('keep what someone may not change as it was (0066)', async () => {
    const people = mkdtempSync(join(tmpdir(), 'kuraa-people-'));
    dirs.push(people);
    const ada = await createPerson('Ada', join(people, 'ada', 'person.json'));
    const bo = await createPerson('Bo', join(people, 'bo', 'person.json'));
    const dirA = repo();
    mkdirSync(join(dirA, 'chapters'));
    writeFileSync(join(dirA, 'chapters', 'one.md'), '# One\n\nAda’s.\n');
    git(dirA, 'add', '-A');
    git(dirA, 'commit', '-q', '-m', 'Chapter one');
    const a = await start(dirA, { person: ada });
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
    dirs.push(parent);
    const dirB = join(parent, 'notes');
    signingKeys.set(dirB, crypto.keyPair());
    await joinWorkspace({ dir: dirB, invitation: await inviteFrom(a), name: 'bee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, person: bo, signing: signingKeys.get(dirB) });
    const b = await start(dirB, { person: bo });
    await until(async () => (await a.host.peers!.people()).people.some((p) => p.id === bo.id), 15_000, 'Bo in the workspace');
    // Only Ada may change chapters/.
    await a.host.peers!.setRule('chapters/', [ada.id]);
    await until(async () => !(await b.host.peers!.access('chapters/one.md')).canWrite, 15_000, 'the rule on Bo’s device');
    expect((await b.host.peers!.access('chapters/one.md')).rule).toEqual({ path: 'chapters/', by: ['Ada'], who: [ada.id] });
    expect((await b.host.peers!.access('notes.md')).canWrite).toBe(true);
    await expect(b.host.peers!.setRule('', [bo.id])).rejects.toThrow('Only an admin');

    // Bo adds a chapter anyway, and a note where anyone may.
    expect((await api(b, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'chapters/two.md', content: '# Two\n\nBo’s.\n' }) })).status).toBe(201);
    expect((await api(b, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'bo.md', content: '# Bo’s note\n' }) })).status).toBe(201);
    // His note comes in; his chapter does not: Ada's copy keeps chapters/ as it was, and the merge says why.
    await until(() => existsSync(join(dirA, 'bo.md')), 20_000, 'Bo’s note on Ada’s device');
    await until(() => /Kept chapters\/two\.md as it was: not Bo to change/.test(git(dirA, 'log', '-1', '--merges', '--format=%B')), 20_000, 'Bo’s chapter kept out');
    expect(existsSync(join(dirA, 'chapters', 'two.md'))).toBe(false);
    // Ada's merge reaches Bo's device: his copy has the chapter no longer either.
    await until(() => !existsSync(join(dirB, 'chapters', 'two.md')), 20_000, 'Bo’s copy in step');
    // Nothing is offered in its place: what he may not change, he reads (0072).
    expect((await b.host.peers!.access('chapters/one.md'))).not.toHaveProperty('suggestions');
    // But his chapter is not lost: in the file's history, as changes not kept, on both devices; and he is told.
    const history = async (h: RunningHost) => ((await (await api(h, `/api/history?path=${encodeURIComponent('chapters/two.md')}`)).json()) as { commits: { hash: string; kind: string }[] }).commits;
    const [notKept] = await history(a);
    expect(notKept).toMatchObject({ kind: 'not-kept' });
    expect(await (await api(a, `/api/history/${notKept!.hash}?path=${encodeURIComponent('chapters/two.md')}`)).text()).toBe('# Two\n\nBo’s.\n');
    expect((await history(b)).map((c) => c.kind)).toContain('not-kept');
    expect((await b.host.peers!.access('chapters/two.md')).notKept.map((n) => n.commit)).toEqual([notKept!.hash]);
    expect((await a.host.peers!.access('chapters/two.md')).notKept).toEqual([]);
  });

  it('take live edits only from those who may change the document; theirs reach everyone (0066)', async () => {
    const people = mkdtempSync(join(tmpdir(), 'kuraa-people-'));
    dirs.push(people);
    const adaP = await createPerson('Ada', join(people, 'ada', 'person.json'));
    const boP = await createPerson('Bo', join(people, 'bo', 'person.json'));
    const dirA = repo();
    const a = await start(dirA, { person: adaP });
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
    dirs.push(parent);
    const dirB = join(parent, 'notes');
    signingKeys.set(dirB, crypto.keyPair());
    await joinWorkspace({ dir: dirB, invitation: await inviteFrom(a), name: 'bee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, person: boP, signing: signingKeys.get(dirB) });
    const b = await start(dirB, { person: boP });
    await until(async () => (await a.host.peers!.people()).people.some((p) => p.id === boP.id), 15_000, 'Bo in the workspace');
    await a.host.peers!.setRule('notes.md', [adaP.id]);
    await until(async () => !(await b.host.peers!.access('notes.md')).canWrite, 15_000, 'the rule on Bo’s device');
    const [ca, cb] = await Promise.all([connect(a, ADA), connect(b, BO)]);
    const [ada, bo] = await together({ c: ca, h: a, user: ADA }, { c: cb, h: b, user: BO }) as [HeadlessClient, HeadlessClient];
    ada.write(insertAt(ada.read(), 'The tide', 'Ada: '));
    await until(() => bo.read().textContent.includes('Ada: '), 15_000, 'Ada’s edit on Bo’s device');
    // Bo types anyway (as an app that let him would): his room has it, Ada's does not take it.
    bo.write(insertAt(bo.read(), 'It rained', 'Bo: '));
    await new Promise((r) => setTimeout(r, 1500));
    expect(ada.read().textContent).not.toContain('Bo: ');
    // Ada's device commits the room: hers to change.
    await until(() => file(dirA).includes('Ada: The tide') && git(dirA, 'status', '--porcelain') === '', 20_000, 'Ada’s edit committed');
    expect(file(dirA)).not.toContain('Bo: ');
  });

  it('give a file read only by some to them alone: never to anyone else, not even its objects (0066)', async () => {
    const people = mkdtempSync(join(tmpdir(), 'kuraa-people-'));
    dirs.push(people);
    const ada = await createPerson('Ada', join(people, 'ada', 'person.json'));
    const bo = await createPerson('Bo', join(people, 'bo', 'person.json'));
    const cy = await createPerson('Cy', join(people, 'cy', 'person.json'));
    const dirA = repo();
    const a = await start(dirA, { person: ada });
    const join_ = async (who: typeof bo, name: string) => {
      const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
      dirs.push(parent);
      const dir = join(parent, 'notes');
      signingKeys.set(dir, crypto.keyPair());
      await joinWorkspace({ dir, invitation: await inviteFrom(a), name, bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, person: who, signing: signingKeys.get(dir) });
      return { dir, h: await start(dir, { person: who }) };
    };
    const { dir: dirB, h: b } = await join_(bo, 'bee');
    const { dir: dirC, h: c } = await join_(cy, 'cee');
    await until(async () => (await a.host.peers!.people()).people.length === 3, 15_000, 'all three in');

    // Ada writes a plan, and gives it to herself and Bo alone.
    expect((await api(a, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'plan.md', content: '# Plan\n\nThe surprise party is on Friday.\n' }) })).status).toBe(201);
    // With an image of its own (0109), everyone's while the plan is.
    const addImage = (name: string) => api(a, `/api/images?doc=plan.md&name=${name}`, { method: 'POST', body: new Uint8Array(PIXEL) });
    expect(await (await addImage('venue.png')).json()).toMatchObject({ path: 'plan.md.files/venue.png' });
    await until(() => existsSync(join(dirC, 'plan.md')), 20_000, 'the plan, first everyone’s, on Cy’s device');
    const res = await api(a, '/api/audience', { method: 'POST', body: JSON.stringify({ path: 'plan.md', audience: [ada.id, bo.id] }) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { readers: { words: string } }).readers.words).toBe('You and Bo');
    // Off the workspace's own branch, into a space of its own; plain git sees nothing out of place.
    expect(git(dirA, 'ls-tree', '--name-only', 'HEAD')).not.toContain('plan.md');
    expect(git(dirA, 'status', '--porcelain')).toBe('');
    expect(git(dirA, 'for-each-ref', '--format=%(refname)', 'refs/spaces/')).toMatch(/^refs\/spaces\/[0-9a-f]{32}\/heads\/main$/);
    // Its own files went with it (0109); one added now goes straight there, never on the workspace's own branch.
    expect(await (await addImage('cake.png')).json()).toMatchObject({ path: 'plan.md.files/cake.png' });
    const space = git(dirA, 'for-each-ref', '--format=%(refname)', 'refs/spaces/');
    expect(git(dirA, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('plan.md.files');
    expect(git(dirA, 'ls-tree', '-r', '--name-only', space).split('\n').sort()).toEqual(['plan.md', 'plan.md.files/cake.png', 'plan.md.files/venue.png']);
    expect(git(dirA, 'status', '--porcelain')).toBe('');

    // Bo's device has it, read from the space; the file list says who reads it.
    const treeOf = async (h: RunningHost) => ((await (await api(h, '/api/tree')).json()) as { files: { path: string; readers?: string }[] }).files;
    await until(async () => (await treeOf(b)).some((f) => f.path === 'plan.md' && f.readers), 20_000, 'the plan in a space on Bo’s device');
    expect(readFileSync(join(dirB, 'plan.md'), 'utf8')).toContain('Friday');
    await until(() => existsSync(join(dirB, 'plan.md.files/cake.png')), 20_000, 'the plan’s image on Bo’s device');
    const treeB = { files: await treeOf(b) };
    expect(treeB.files.find((f) => f.path === 'plan.md')?.readers).toBe('You and Ada');
    expect(((await (await api(b, '/api/features/search/search?q=surprise')).json()) as { files: { path: string }[] }).files.map((f) => f.path)).toContain('plan.md');
    // Bo changes it: it comes back to Ada, in the space.
    writeFileSync(join(dirB, 'plan.md'), '# Plan\n\nThe surprise party is on Friday. Bo brings cake.\n');
    await b.host.serial(() => b.host.commitPaths(['plan.md'], 'Cake'));
    await until(() => readFileSync(join(dirA, 'plan.md'), 'utf8').includes('cake'), 20_000, 'Bo’s change on Ada’s device');
    expect(git(dirA, 'status', '--porcelain')).toBe('');

    // Code run for a document everyone reads does not see the plan; code run for the plan sees everything.
    expect(await a.host.hiddenFrom('notes.md')).toEqual(['plan.md', 'plan.md.files/cake.png', 'plan.md.files/venue.png']);
    expect(await a.host.hiddenFrom('plan.md')).toEqual([]);

    // Cy's device: the old version, from when everyone read it, is still in the history it has; the space, nothing of it.
    await until(async () => (await c.host.peers!.status()).devices.filter((d) => d.online).length === 2, 15_000, 'Cy connected');
    await c.host.peers!.syncAll();
    await new Promise((r) => setTimeout(r, 1500));
    await c.host.peers!.syncAll();
    expect(git(dirC, 'for-each-ref', 'refs/spaces/', 'refs/kuraa/peer-spaces/')).toBe('');
    const cakeBlob = git(dirA, 'rev-parse', `${git(dirA, 'for-each-ref', '--format=%(refname)', 'refs/spaces/')}:plan.md`);
    expect(() => git(dirC, 'cat-file', '-e', cakeBlob)).toThrow();
    const treeC = (await (await api(c, '/api/tree')).json()) as { files: { path: string }[] };
    expect(treeC.files.map((f) => f.path)).not.toContain('plan.md');
    expect(((await (await api(c, '/api/features/search/search?q=cake')).json()) as { files: { path: string }[] }).files).toEqual([]);
    // Its file went from Cy's working tree with the workspace's branch, and its own files with it; the later image never came.
    await until(() => !existsSync(join(dirC, 'plan.md')), 20_000, 'the plan gone from Cy’s copy');
    await until(() => !existsSync(join(dirC, 'plan.md.files/venue.png')), 20_000, 'the plan’s first image gone from Cy’s copy');
    expect(existsSync(join(dirC, 'plan.md.files/cake.png'))).toBe(false);
  });

  it('let a person remove their own computer, admin or not; no one else’s (0068)', async () => {
    const people = mkdtempSync(join(tmpdir(), 'kuraa-people-'));
    dirs.push(people);
    const ada = await createPerson('Ada', join(people, 'ada', 'person.json'));
    const bo = await createPerson('Bo', join(people, 'bo', 'person.json'));
    const dirA = repo();
    const a = await start(dirA, { person: ada });
    // Bo, a member, on two computers.
    const joinAs = async (name: string) => {
      const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
      dirs.push(parent);
      const dir = join(parent, 'notes');
      signingKeys.set(dir, crypto.keyPair());
      await joinWorkspace({ dir, invitation: await inviteFrom(a), name, bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, person: bo, signing: signingKeys.get(dir) });
      return start(dir, { person: bo });
    };
    const laptop = await joinAs('laptop');
    const desk = await joinAs('desk');
    const deskKey = desk.host.peers!.node.myKey;
    await until(async () => (await laptop.host.peers!.people()).people.find((p) => p.id === bo.id)?.devices.includes(deskKey) ?? false, 20_000, 'Bo’s desk known as his on his laptop');
    // Not Ada's computer: not his to remove.
    await expect(laptop.host.peers!.removeDevice(a.host.peers!.node.myKey)).rejects.toThrow('whoever it is');
    // His desk, lost: removed from his laptop, and Ada's device takes it.
    await laptop.host.peers!.removeDevice(deskKey);
    await until(async () => (await a.host.peers!.node.identity.removed()).includes(deskKey), 20_000, 'Ada’s device took the removal');
    await until(async () => (await desk.host.peers!.status()).removed, 20_000, 'the desk knows');
  });

  it('keep permissions on files and folders: a private folder’s new files in its space, never public; rules go with renames (0069)', async () => {
    const people = mkdtempSync(join(tmpdir(), 'kuraa-people-'));
    dirs.push(people);
    const ada = await createPerson('Ada', join(people, 'ada', 'person.json'));
    const bo = await createPerson('Bo', join(people, 'bo', 'person.json'));
    const dirA = repo();
    const a = await start(dirA, { person: ada });
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
    dirs.push(parent);
    const dirB = join(parent, 'notes');
    signingKeys.set(dirB, crypto.keyPair());
    await joinWorkspace({ dir: dirB, invitation: await inviteFrom(a), name: 'bee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, person: bo, signing: signingKeys.get(dirB) });
    const b = await start(dirB, { person: bo });
    await until(async () => (await a.host.peers!.people()).people.length === 2, 15_000, 'Bo in');

    // Ada: plans/ is read by her and Bo, and changed by her alone.
    await a.host.peers!.setPermissions('plans/', { read: [ada.id, bo.id], write: [ada.id] });
    const policy = await a.host.peers!.node.identity.policy();
    // Private: named by its hash, though Ada's overview names it.
    expect([...policy.perms.keys()]).toEqual([expect.stringMatching(/^h:[0-9a-f]{64}$/)]);
    expect((await a.host.peers!.permissions('plans/')).own).toEqual({ write: [ada.id], read: [ada.id, bo.id].sort() });
    // A new file in it goes into the space at once: never onto the workspace's branch.
    expect((await api(a, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'plans/party.md', content: '# Party\n' }) })).status).toBe(201);
    expect(git(dirA, 'log', '--all', '--format=%H', '--', 'plans/party.md').split('\n').filter(Boolean).every((c) => !git(dirA, 'branch', '--contains', c))).toBe(true);
    expect(a.host.spaceOf('plans/party.md')).not.toBeNull();
    expect((await a.host.peers!.rules()).permissions).toEqual([{ path: 'plans/', private: true, write: [ada.id], read: [ada.id, bo.id].sort() }]);
    await until(() => existsSync(join(dirB, 'plans', 'party.md')), 20_000, 'the plan on Bo’s device');

    // Renamed, it stays in its space.
    expect((await api(a, '/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'plans/party.md', to: 'plans/fiesta.md' }) })).status).toBe(200);
    expect(a.host.spaceOf('plans/fiesta.md')).not.toBeNull();
    expect(git(dirA, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toContain('plans/');
    await until(() => existsSync(join(dirB, 'plans', 'fiesta.md')) && !existsSync(join(dirB, 'plans', 'party.md')), 20_000, 'renamed on Bo’s device');

    // A file with a permission of its own: Bo may not move it (it would be left behind); Ada's move takes it along.
    await a.host.peers!.setPermissions('notes.md', { write: [ada.id] });
    await until(async () => !!(await b.host.peers!.node.identity.policy()).permAt('notes.md'), 15_000, 'the permission on Bo’s device');
    const refused = await api(b, '/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'notes.md', to: 'field.md' }) });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toMatch(/only an admin can move it/);
    expect((await api(a, '/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'notes.md', to: 'field.md' }) })).status).toBe(200);
    const after = await a.host.peers!.node.identity.policy();
    expect(after.permAt('notes.md')).toBeNull();
    expect(after.permAt('field.md')?.perm).toEqual({ write: [ada.id] });

    // A file moved into plans/ reads as plans/ says: into its space.
    expect((await api(a, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'budget.md', content: '# Budget\n' }) })).status).toBe(201);
    expect((await api(a, '/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'budget.md', to: 'plans/budget.md' }) })).status).toBe(200);
    expect(a.host.spaceOf('plans/budget.md')).toBe(a.host.spaceOf('plans/fiesta.md'));
  });

  it('take a member’s work, and name it by the person whose it is', async () => {
    const people = mkdtempSync(join(tmpdir(), 'kuraa-people-'));
    dirs.push(people);
    const bo = await createPerson('Bo', join(people, 'bo.json'));
    const dirA = repo();
    const a = await start(dirA);
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-b-'));
    dirs.push(parent);
    const dirB = join(parent, 'notes');
    await joinWorkspace({ dir: dirB, invitation: await inviteFrom(a), name: 'bee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, person: bo });
    const b = await start(dirB, { person: bo });
    // A member's work comes in, with no rule to pass.
    expect((await api(b, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'chapters/bo.md', content: '# Bo’s\n' }) })).status).toBe(201);
    // In Ada's history, not only on her disk (a slow computer may show the file a moment before the branch moves).
    const brought = () => git(dirA, 'log', '-1', '--format=%H', '--', 'chapters/bo.md');
    await until(() => existsSync(join(dirA, 'chapters', 'bo.md')) && brought() !== '', 15_000, 'Bo’s work on Ada’s device');
    // Signed with Bo's key on his computer, which his identity vouched for: Ada's device names him (by his identity's ID).
    const signer = await commitSigner(a.host.git, brought());
    expect(signer).toBe(signingKeys.get(dirB)!.publicKey.toString('hex'));
    await until(async () => (await a.host.peers!.status()).devices[0]?.person === 'Bo', 15_000, 'Bo named on Ada’s device');
    expect(await a.host.peers!.node.identity.personOf(signer!)).toEqual({ key: bo.id, name: 'Bo' });
  });

  it('spread a new member through the others; the owner removes a computer, a member no one else’s (0070, 0072)', async () => {
    const { a, b, dirA, dirB } = await pair();
    // Ada, the owner, makes Bo an admin; a third device joins by Bo's link (not hers); Ada's learns of it from Bo's.
    await a.host.peers!.setRole((await personFor(dirB)).id, 'admin');
    await until(async () => (await b.host.peers!.people()).admin, 15_000, 'Bo an admin on his device');
    const parent = mkdtempSync(join(tmpdir(), 'kuraa-peer-c-'));
    dirs.push(parent);
    const dirC = join(parent, 'notes');
    await joinWorkspace({ dir: dirC, invitation: await inviteFrom(b), name: 'cee', bootstrap: testnet.bootstrap as never, timeoutMs: 20_000 });
    const c = await start(dirC, { invites: {} });
    await until(() => git(dirA, 'remote').split('\n').includes('cee'), 15_000, 'Ada’s device knows cee through bee');
    await until(async () => (await c.host.peers!.status()).devices.filter((d) => d.online).length === 2, 15_000, 'cee meets both');
    // The newest member renames its device; it may not remove anyone else's.
    expect((await api(c, '/api/peers/name', { method: 'POST', body: JSON.stringify({ name: 'Cy’s laptop' }) })).status).toBe(200);
    expect((await c.host.peers!.status()).device.name).toBe('cy-s-laptop');
    const adaKey = (await a.host.peers!.status()).device.key;
    expect((await api(c, `/api/peers/devices/${adaKey}`, { method: 'DELETE' })).status).toBe(403);
    // Ada, the owner, removes Cy's computer: its key dropped here, and every device turns it away.
    const cyKey = (await c.host.peers!.status()).device.key;
    await a.host.peers!.removeDevice(cyKey);
    await until(() => !git(dirB, 'remote').split('\n').some((r) => git(dirB, 'remote', 'get-url', r) === `kuraa://${cyKey}`), 20_000, 'Bo’s device forgets Cy’s');
    await until(async () => (await c.host.peers!.status()).removed, 20_000, 'Cy’s device knows it is out');
    await until(async () => !(await c.host.peers!.status()).devices.some((d) => d.online), 20_000, 'Cy’s device is turned away');
    // Cy is still in the workspace: only that computer is out. The others were not removed; it keeps its copy.
    expect((await a.host.peers!.people()).people.some((p) => p.name === 'Cy')).toBe(true);
    expect((await b.host.peers!.status()).removed).toBe(false);
    expect(file(dirC)).toBe(NOTES);
    // Removing a device that is not a member, or this one, is refused.
    await expect(a.host.peers!.removeDevice('0'.repeat(64))).rejects.toThrow('No such device');
    await expect(a.host.peers!.removeDevice(adaKey)).rejects.toThrow('This is this device');
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
    let ada = await connect(a, ADA);
    let bo = await connect(b, BO);
    ada.write(insertAt(ada.read(), 'It rained', 'Ada: '));
    // Opened at once on both, the two may start a session each; one gives way to the other (0077): followed.
    await until(async () => {
      bo = await follow(bo, b, BO);
      return bo.read().textContent.includes('Ada: ');
    }, 15_000, 'the shared room');
    await start(dirC);
    const want = (t: string) => t.includes('We counted many crabs.') && t.includes('Ada: It rained');
    await until(async () => {
      ada = await follow(ada, a, ADA);
      bo = await follow(bo, b, BO);
      return want(ada.read().textContent) && want(bo.read().textContent);
    }, 25_000, 'Cy’s edit in the room');
    expect(ada.read().textContent.match(/many/g)).toHaveLength(1);
    expect(ada.read().eq(bo.read())).toBe(true);
    await until(() => want(file(dirA)) && file(dirA) === file(dirB) && file(dirB) === file(dirC) && head(dirA) === head(dirB) && head(dirB) === head(dirC), 25_000, 'all three the same');
    expect(file(dirA).match(/many/g)).toHaveLength(1);
  });
});

// A room kept warm on one device while the other goes on (0075): sessions.test.ts (0077).

describe('invite links', () => {
  async function joinBy(link: string, name: string, timeoutMs = 20_000): Promise<string> {
    const parent = mkdtempSync(join(tmpdir(), `kuraa-peer-${name}-`));
    dirs.push(parent);
    const dir = join(parent, 'notes');
    await joinWorkspace({ dir, invitation: link, name, bootstrap: testnet.bootstrap as never, timeoutMs, log: process.env.PEER_LOG ? (m) => console.log(`[join ${name}] ${m}`) : undefined });
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
    await mallory.addRemote(l.issuer.key, l.issuer.name);
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

  it('stop working once revoked (on every device) or expired, whichever admin made them', async () => {
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
    // A link another admin made lets people in like any other.
    await a.host.peers!.setRole((await personFor(dirB)).id, 'admin');
    await until(async () => (await b.host.peers!.people()).admin, 15_000, 'Bo an admin on his device');
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
    await a.host.peers!.setRole((await personFor(dirB)).id, 'admin');
    await until(async () => (await b.host.peers!.people()).admin, 15_000, 'Bo an admin on his device');
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
