// One session per room, one leader per session (0077): devices of one
// workspace, on a local DHT, with people (headless clients) editing one
// document. Whatever happens (a device leaves and comes back, a commit or an
// outside edit arrives at a device that does not lead the room, the leader
// goes, the network splits and heals), each edit ends up once, in every room
// and every file, and every device ends in one session.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import { Transform } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { connectHeadless, type HeadlessClient } from '@kuraa/session/testing';
import { createPerson, type Person } from '../src/peers/person.js';
import { joinWorkspace as joinWorkspaceAs, startHost, type RunningHost } from '../src/index.js';
import type { HostTimings } from '../src/host.js';

const NOTES = '---\ntitle: Field notes\n---\n\n# Day one\n\nThe tide was out.\n\nWe counted crabs.\n\nThe wind rose.\n\n# Day two\n\nIt rained.\n\nClouds came.\n\nNight fell.\n';
const FAST: Partial<HostTimings> = { flushMs: 100, idleCommitMs: 400, maxCommitMs: 3000, dropMs: 120_000, rejoinMs: 600 };
const ADA = { name: 'Ada', email: 'ada@example.org', color: '#d33' };
const BO = { name: 'Bo', email: 'bo@example.org', color: '#33d' };
const CY = { name: 'Cy', email: 'cy@example.org', color: '#3d3' };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const log = (dir: string) => (process.env.PEER_LOG ? (m: string) => console.log(`[${/session-(bee|cee)/.exec(dir)?.[1] ?? 'ada'} ${Date.now() % 100_000}] ${m}`) : undefined);

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
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** How much longer to wait on a slow computer (KURAA_TEST_SLOW=2: twice as long). */
const SLOW = Number(process.env.KURAA_TEST_SLOW ?? 1) || 1;

async function until(cond: () => boolean | Promise<boolean>, ms = 20_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms * SLOW;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-session-a-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Ada');
  git(dir, 'config', 'user.email', 'ada@example.org');
  writeFileSync(join(dir, 'notes.md'), NOTES);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  return dir;
}

const signing = new Map<string, { publicKey: Buffer; secretKey: Buffer }>();
const signingFor = (dir: string) => {
  if (!signing.has(dir)) signing.set(dir, crypto.keyPair());
  return signing.get(dir)!;
};
const people = new Map<string, Person>();
async function personFor(dir: string, name = 'Ada'): Promise<Person> {
  let p = people.get(dir);
  if (!p) {
    const home = mkdtempSync(join(tmpdir(), 'kuraa-session-person-'));
    dirs.push(home);
    p = await createPerson(name, join(home, 'person.json'));
    people.set(dir, p);
  }
  return p;
}

/**
 * The network between devices, for tests: links between two devices can be
 * cut (closed, and no new one let through) and mended.
 */
class Net {
  private readonly cut = new Set<string>();
  readonly devices: Device[] = [];
  private pair = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  reaches = (me: () => string) => (k: string) => !this.cut.has(this.pair(me(), k));
  split(side: Device[]): void {
    const other = this.devices.filter((d) => !side.includes(d));
    for (const a of side) {
      for (const b of other) {
        this.cut.add(this.pair(a.key, b.key));
        a.node.links.get(b.key)?.close();
        b.node.links.get(a.key)?.close();
      }
    }
  }
  heal(): void {
    this.cut.clear();
    for (const a of this.devices) {
      for (const b of this.devices) {
        if (a === b || a.node.links.get(b.key)?.accepted) continue;
        const n = a.node as unknown as { unban(k: string): void; dial(k: string): void; dialling: Map<string, NodeJS.Timeout> };
        n.unban(b.key);
        clearTimeout(n.dialling.get(b.key));
        n.dialling.delete(b.key);
        if (a.key < b.key) n.dial(b.key);
      }
    }
  }
  connected(): boolean {
    return this.devices.every((a) => this.devices.every((b) => a === b || !!a.node.links.get(b.key)?.accepted));
  }
}

interface Device {
  host: RunningHost;
  dir: string;
  key: string;
  node: NonNullable<RunningHost['host']['peers']>['node'];
}

const device = (h: RunningHost, dir: string): Device => ({ host: h, dir, key: h.host.peers!.node.myKey, node: h.host.peers!.node });

async function start(net: Net, dir: string, timings: Partial<HostTimings> = {}): Promise<Device> {
  let me = '';
  const h = await startHost({ dir, timings: { ...FAST, ...timings }, peers: { bootstrap: testnet.bootstrap as never, signing: signingFor(dir), person: await personFor(dir), lookupsMs: [300, 600, 1000], direct: net.reaches(() => me), tunnelAfterMs: 600_000 }, log: log(dir) });
  hosts.push(h);
  me = h.host.peers!.node.myKey;
  const d = device(h, dir);
  net.devices.push(d);
  return d;
}

/** Devices of one workspace: the first's, and others joined by invite links, all online. */
async function workspace(n: number, timings: Partial<HostTimings> = {}): Promise<{ net: Net; devices: Device[] }> {
  const net = new Net();
  const first = await start(net, repo(), timings);
  const names = ['bee', 'cee', 'dee'];
  for (let i = 1; i < n; i++) {
    const parent = mkdtempSync(join(tmpdir(), `kuraa-session-${names[i - 1]}-`));
    dirs.push(parent);
    const dir = join(parent, 'notes');
    const invitation = await first.host.host.peers!.inviteLink({ hours: 1, once: true });
    await joinWorkspaceAs({ dir, invitation, name: names[i - 1], bootstrap: testnet.bootstrap as never, timeoutMs: 20_000, person: await personFor(dir, names[i - 1]), signing: signingFor(dir) });
    git(dir, 'config', 'user.name', names[i - 1]!);
    git(dir, 'config', 'user.email', `${names[i - 1]}@example.org`);
    await start(net, dir, timings);
  }
  await until(() => net.connected(), 30_000, 'every device connected to every other');
  return { net, devices: net.devices };
}

const api = (h: RunningHost, path: string) => fetch(h.url + path, { headers: { authorization: `Bearer ${h.token}` } });

/** Someone in the document on a device, as the app is: moved to the room that replaced theirs (reseeded), with what they had not sent. */
class Someone {
  c!: HeadlessClient;
  constructor(readonly d: Device, readonly user = ADA) {}
  async open(): Promise<this> {
    const { room } = (await (await api(this.d.host, '/api/rooms?path=notes.md')).json()) as { room: string };
    this.c = connectHeadless({ url: this.d.host.url.replace(/^http/, 'ws') + '/collab', room, token: this.d.host.token, user: this.user, schema: pandocMarkdown.schema });
    clients.push(this.c);
    await this.c.ready;
    return this;
  }
  /** Follow a room replaced (as the app does: carried edits are not tested here; nothing is left unsent when it moves). */
  async follow(): Promise<void> {
    if (!this.c.messages.some((m) => m.type === 'reseeded')) return;
    this.c.destroy();
    await this.open();
  }
  text(): string {
    return pandocMarkdown.serialize(this.c.read());
  }
  type(anchor: string, text: string): void {
    this.c.write(insertAt(this.c.read(), anchor, text));
  }
  leave(): void {
    this.c.destroy();
  }
}
const person = (d: Device, user = ADA) => new Someone(d, user).open();

function insertAt(doc: PMNode, anchor: string, text: string): PMNode {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isTextblock && node.textContent.includes(anchor)) pos = p + 1 + node.textContent.indexOf(anchor);
    return pos < 0;
  });
  if (pos < 0) throw new Error(`anchor not found: ${anchor}`);
  return new Transform(doc).insert(pos, pandocMarkdown.schema.text(text)).doc;
}

/** The file as it is: git takes it away before writing the new one, so where it is not there that moment, read again (up to half a second). */
const file = (d: Device) => {
  for (let i = 0; ; i++) {
    try {
      return readFileSync(join(d.dir, 'notes.md'), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || i >= 50) throw e;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
};
const head = (d: Device) => git(d.dir, 'rev-parse', 'HEAD');
const clean = (d: Device) => git(d.dir, 'status', '--porcelain') === '';
const session = (d: Device) => d.host.host.liveRooms()[0]?.session ?? null;
const roomText = (d: Device) => {
  const r = d.host.host.liveRooms()[0];
  return r ? d.host.host.roomText(r.name) ?? null : null;
};
const count = (text: string, s: string) => text.split(s).length - 1;

/**
 * All settled: every device in one session (those with the room open), every
 * room's text the same and the file's, committed, on one commit everywhere.
 */
async function settled(devices: Device[], ps: Someone[], ms = 30_000): Promise<void> {
  await until(async () => {
    for (const p of ps) await p.follow();
    const live = devices.filter((d) => d.host.host.liveRooms().length);
    const sessions = new Set(live.map(session));
    if (sessions.size !== 1) return false;
    const texts = new Set([...live.map(roomText), ...ps.map((p) => p.text())]);
    if (texts.size !== 1) return false;
    const [text] = [...texts];
    return devices.every((d) => file(d) === text && clean(d) && head(d) === head(devices[0]!));
  }, ms, 'one session, the same text in every room and file, committed, on one commit').catch((e: Error) => {
    for (const d of devices) console.log(`DEVICE ${d.key.slice(0, 6)} session=${session(d)} head=${head(d).slice(0, 7)} clean=${clean(d)}\nFILE:\n${file(d)}\nROOM:\n${roomText(d)}`);
    for (const p of ps) console.log(`PERSON on ${p.d.key.slice(0, 6)}:\n${p.text()}`);
    throw e;
  });
}

/** The two devices of a pair, by key: the leader (lower) and the other. */
const byKey = (a: Device, b: Device) => (a.key < b.key ? [a, b] : [b, a]) as [Device, Device];

describe('one leader per session (0077)', () => {
  // The warm room of 0075: Bo leaves; his device keeps the room (still in the session); Ada edits, her edit is
  // committed and reaches Bo's device by git; Bo comes back. Whichever device leads, Ada's edit is there once,
  // and nothing old is written over it.
  for (const warm of ['lower', 'higher'] as const) {
    for (const dropped of [false, true]) {
      it(`a device that left and comes back: the room kept ${dropped ? 'until it closed' : 'warm'}, on the device with the ${warm} key`, async () => {
        const { devices } = await workspace(2, dropped ? { dropMs: 400 } : {});
        const [low, high] = byKey(devices[0]!, devices[1]!);
        const [boD, adaD] = warm === 'lower' ? [low, high] : [high, low];
        const ada = await person(adaD, ADA);
        const bo = await person(boD, BO);
        ada.type('The tide', 'Ada1: ');
        await settled(devices, [ada, bo]);
        bo.leave();
        if (dropped) await until(() => !boD.host.host.liveRooms().length, 10_000, 'Bo’s device left the session');
        ada.type('It rained', 'Ada2: ');
        await until(() => git(boD.dir, 'show', 'HEAD:notes.md').includes('Ada2') && head(boD) === head(adaD) && clean(adaD) && clean(boD), 20_000, 'Ada’s edit committed, and on Bo’s device');
        await sleep(500);
        expect(file(boD)).toBe(file(adaD));
        const bo2 = await person(boD, BO);
        expect(count(bo2.text(), 'Ada2')).toBe(1);
        bo2.type('We counted', 'Bo: ');
        await settled(devices, [ada, bo2]);
        expect(file(adaD)).toBe(NOTES.replace('The tide', 'Ada1: The tide').replace('We counted', 'Bo: We counted').replace('It rained', 'Ada2: It rained'));
      });
    }
  }

  it('a commit arriving at a device that does not lead the room is brought in once, by the one that does', async () => {
    const { devices } = await workspace(2);
    const [leader, other] = byKey(devices[0]!, devices[1]!);
    const one = await person(leader, ADA);
    const two = await person(other, BO);
    one.type('The tide', 'Live: ');
    await settled(devices, [one, two]);
    // A commit made elsewhere (the online copy, say), fetched by the device that does not lead the room.
    const elsewhere = mkdtempSync(join(tmpdir(), 'kuraa-session-elsewhere-'));
    dirs.push(elsewhere);
    git(elsewhere, 'clone', '-q', other.dir, '.');
    writeFileSync(join(elsewhere, 'notes.md'), file(other).replace('It rained.', 'It rained, from elsewhere.'));
    git(elsewhere, '-c', 'user.name=Eve', '-c', 'user.email=eve@example.org', 'commit', '-q', '-am', 'From elsewhere');
    git(other.dir, 'fetch', '-q', elsewhere, 'main:refs/remotes/elsewhere/main');
    two.type('We counted', 'Typing: ');
    await other.host.host.serial(() => other.host.host.bringBranch('main', 'refs/remotes/elsewhere/main'));
    await settled(devices, [one, two]);
    for (const t of [one.text(), two.text(), file(leader)]) {
      expect(count(t, 'from elsewhere')).toBe(1);
      expect(count(t, 'Typing: ')).toBe(1);
      expect(count(t, 'Live: ')).toBe(1);
    }
  });

  it('an edit made outside the app on a device that does not lead the room is committed there, and comes into the room once', async () => {
    const { devices } = await workspace(2);
    const [leader, other] = byKey(devices[0]!, devices[1]!);
    const one = await person(leader, ADA);
    const two = await person(other, BO);
    one.type('The tide', 'Live: ');
    await settled(devices, [one, two]);
    // RStudio, say, saves the file on the device that does not lead (a moment after git wrote it: the watcher may take two writes so close as one).
    await sleep(300);
    writeFileSync(join(other.dir, 'notes.md'), file(other).replace('The wind rose.', 'The wind rose, said RStudio.'));
    await until(() => git(other.dir, 'log', '-1', '--format=%H', '--', 'notes.md') !== '' && git(other.dir, 'show', 'HEAD:notes.md').includes('said RStudio'), 20_000, 'committed on the device that does not lead');
    await settled(devices, [one, two]);
    for (const t of [one.text(), two.text(), file(leader), file(other)]) expect(count(t, 'said RStudio')).toBe(1);
  });

  it('the leader leaves while others type: the next goes on with the same document, building on its last commit', async () => {
    const { devices } = await workspace(3, { dropMs: 300 });
    const sorted = [...devices].sort((a, b) => (a.key < b.key ? -1 : 1));
    const [leader, second, third] = sorted as [Device, Device, Device];
    const one = await person(leader, ADA);
    const two = await person(second, BO);
    const three = await person(third, CY);
    one.type('The tide', 'Ada: ');
    await settled(devices, [one, two, three]);
    const before = session(leader);
    // Typing on, while the leader goes.
    const typing = (async () => {
      for (let i = 0; i < 12; i++) {
        two.type('We counted', `b${i} `);
        three.type('The wind', `c${i} `);
        await sleep(60);
      }
    })();
    one.leave();
    await typing;
    await until(() => !leader.host.host.liveRooms().length, 10_000, 'the leader left');
    await settled(devices, [two, three]);
    expect(session(second)).toBe(before);
    for (const t of [two.text(), file(leader), file(third)]) {
      for (let i = 0; i < 12; i++) {
        expect(count(t, `b${i} `)).toBe(1);
        expect(count(t, `c${i} `)).toBe(1);
      }
      expect(count(t, 'Ada: ')).toBe(1);
    }
    // One line of commits: no merge of the session's own commits with each other.
    expect(git(leader.dir, 'rev-list', '--merges', '--count', 'HEAD')).toBe('0');
  });

  it('a network split: both sides edit apart, and when they meet, both edits are there once (by git), in one session', async () => {
    const { net, devices } = await workspace(2);
    const [a, b] = devices as [Device, Device];
    const one = await person(a, ADA);
    const two = await person(b, BO);
    one.type('The tide', 'Before: ');
    await settled(devices, [one, two]);
    net.split([a]);
    await until(() => !a.node.links.get(b.key)?.accepted && !b.node.links.get(a.key)?.accepted, 10_000, 'apart');
    one.type('We counted', 'Apart A: ');
    two.type('It rained', 'Apart B: ');
    await until(() => session(a) !== session(b), 10_000, 'two sessions, after rejoinMs');
    await until(() => file(a).includes('Apart A') && file(b).includes('Apart B') && clean(a) && clean(b), 20_000, 'each side committed');
    net.heal();
    await settled(devices, [one, two], 40_000);
    for (const t of [one.text(), two.text(), file(a), file(b)]) {
      expect(count(t, 'Apart A: ')).toBe(1);
      expect(count(t, 'Apart B: ')).toBe(1);
      expect(count(t, 'Before: ')).toBe(1);
    }
  });

  it('the last device leaves: its text written, committed and let go of; opened again, a new session from the file', async () => {
    const { devices } = await workspace(2, { dropMs: 300 });
    const [a, b] = devices as [Device, Device];
    const one = await person(a, ADA);
    const two = await person(b, BO);
    // Opened at once, the two may have started apart: one session first (0077), as in the app.
    await settled(devices, [one, two]);
    one.type('The tide', 'Last: ');
    await until(() => two.text().includes('Last: '), 10_000, 'in the session');
    const first = session(a);
    two.leave();
    one.leave();
    await until(() => devices.every((d) => !d.host.host.liveRooms().length), 10_000, 'every device left');
    await until(() => devices.every((d) => file(d).includes('Last: The tide') && clean(d)) && head(a) === head(b), 20_000, 'written and committed everywhere');
    const again = await person(b, BO);
    expect(session(b)).not.toBe(first);
    expect(again.text()).toBe(file(b));
    expect(count(again.text(), 'Last: ')).toBe(1);
  });
});

/** A seeded random number generator (mulberry32), so a failing schedule can be run again. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('one leader per session, at random (0077)', () => {
  const SEED = Number(process.env.KURAA_SESSION_SEED ?? 77);
  it(`edits, comings and goings, splits and outside commits on three devices end the same everywhere, each edit once (seed ${SEED})`, async () => {
    const random = rng(SEED);
    const pick = <T>(xs: T[]) => xs[Math.floor(random() * xs.length)]!;
    const { net, devices } = await workspace(3);
    // Each device types in a paragraph of its own; commits from elsewhere change a fourth: edits made apart never clash.
    const anchors = ['The tide', 'We counted', 'The wind'];
    const outside = ['It rained', 'Clouds came', 'Night fell'];
    const users = [ADA, BO, CY];
    const ps: (Someone | null)[] = [null, null, null];
    const typed: string[] = [];
    let n = 0;
    let apart = false;
    for (let step = 0; step < 24; step++) {
      const i = Math.floor(random() * 3);
      const d = devices[i]!;
      const r = random();
      const p = ps[i];
      if (p) await p.follow();
      if (process.env.PEER_LOG) console.log(`STEP ${step} device ${['ada', 'bee', 'cee'][i]} r=${r.toFixed(2)} apart=${apart}`);
      if (r < 0.45) {
        const q = p ?? (ps[i] = await person(d, users[i]));
        const token = `t${n++}x `;
        q.type(anchors[i]!, token);
        typed.push(token);
        // The host has it before anything else happens to the person (an edit never sent is not this test's).
        await until(() => (roomText(d) ?? '').includes(token), 10_000, `${token} at its host`);
      } else if (r < 0.6 && p) {
        p.leave();
        ps[i] = null;
      } else if (r < 0.75) {
        if (apart) net.heal();
        else {
          // Split once what is in the rooms is committed: edits not yet committed when the network parts are in both
          // sides' rooms, and committed by both, which git may keep as a conflict where both sides go on editing beside them.
          await until(() => devices.every((d) => !d.host.host.liveRooms().length || (roomText(d) ?? '').trim() === git(d.dir, 'show', 'HEAD:notes.md')), 20_000, 'the rooms committed');
          net.split([pick(devices)]);
        }
        apart = !apart;
        await sleep(200);
      } else {
        // A commit from elsewhere (the online copy, say), brought in at this device.
        const elsewhere = mkdtempSync(join(tmpdir(), 'kuraa-session-elsewhere-'));
        dirs.push(elsewhere);
        git(elsewhere, 'clone', '-q', d.dir, '.');
        const token = `o${n++}x `;
        writeFileSync(join(elsewhere, 'notes.md'), readFileSync(join(elsewhere, 'notes.md'), 'utf8').replace(outside[i]!, `${token}${outside[i]}`));
        git(elsewhere, '-c', 'user.name=Eve', '-c', 'user.email=eve@example.org', 'commit', '-q', '-am', 'From elsewhere');
        git(d.dir, 'fetch', '-q', elsewhere, 'main:refs/remotes/elsewhere/main');
        await d.host.host.serial(() => d.host.host.bringBranch('main', 'refs/remotes/elsewhere/main')).catch(() => undefined);
        typed.push(token);
      }
      await sleep(Math.floor(random() * 300));
    }
    net.heal();
    await until(() => net.connected(), 30_000, 'connected again');
    for (let i = 0; i < 3; i++) ps[i] ??= await person(devices[i]!, users[i]);
    const all = ps as Someone[];
    await settled(devices, all, 50_000);
    const text = file(devices[0]!);
    for (const t of typed) expect(count(text, t), t).toBe(1);
    expect(count(text, 'Day one')).toBe(1);
    for (const o of outside) expect(count(text, o)).toBe(1);
  }, 120_000 * SLOW);
});
