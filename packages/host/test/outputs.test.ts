// Run outputs shared between devices (0058): published as a signed commit of the
// device's own ref, outside the branches; fetched, checked and taken by the
// others; cleared everywhere from anywhere. Two repositories, real git, no network.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'hypercore-crypto';
import type { RunRecord } from '@kuraa/session/model';
import { Git } from '../src/git.js';
import { commitSigner } from '../src/signing.js';
import { MAX_LIVE_BYTES, MAX_SHARED_BYTES, OUTPUTS, SharedOutputs, fetchedFrom, outputsRefspec, type SharedOutputsDeps } from '../src/peers/outputs.js';
import type { OutputsFrame } from '../src/peers/link.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PLOT = randomBytes(2048).toString('base64');
const DOC = 'reports/analysis.Rmd';

function run(id: string, code: string, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id, path: DOC, chunk: { label: null, index: 0, codeHash: code }, engine: 'r', state: 'done',
    outputs: [{ type: 'text', text: `[1] ${code}\n` }],
    basis: { session: 's1', steps: [{ label: 'setup', index: 0, codeHash: 'h0', complete: true }] },
    by: { name: 'Ada', color: '#d33' }, queuedAt: '2026-11-20T10:00:00.000Z', finishedAt: '2026-11-20T10:00:01.000Z', ms: 900, ...extra,
  };
}

interface Device {
  dir: string;
  key: string;
  signing: { publicKey: Buffer; secretKey: Buffer };
  cache: { path: string; runs: RunRecord[] }[];
  changes: { path: string; added: RunRecord[]; removed: string[] }[];
  announced: number;
  /** What it sent as it happened (0062), and to whom: devices with `path` open, or (null) every one. */
  sent: { frame: OutputsFrame; path: string | null }[];
  out: SharedOutputs;
  members: { key: string; name: string }[];
}

function device(name: string): Device {
  const dir = mkdtempSync(join(tmpdir(), `kuraa-outputs-${name}-`));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.org', 'commit', '-q', '--allow-empty', '-m', 'Initial');
  const d = { dir, key: randomBytes(32).toString('hex'), signing: crypto.keyPair(), cache: [], changes: [], announced: 0, members: [], sent: [] } as unknown as Device;
  return d;
}

/** Each device knows the others as members, signing with their keys. */
function connect(...devices: Device[]): void {
  connectWith({}, ...devices);
}

function connectWith(opts: Partial<SharedOutputsDeps>, ...devices: Device[]): void {
  for (const d of devices) {
    d.members = devices.filter((o) => o !== d).map((o) => ({ key: o.key, name: o === devices[0] ? 'ada-laptop' : `device-${o.key.slice(0, 4)}` }));
    d.out = new SharedOutputs({
      git: new Git(d.dir),
      myKey: d.key,
      stateDir: join(d.dir, '.git', 'kuraa'),
      signing: async () => d.signing,
      members: async () => d.members,
      signerOf: async (key) => devices.find((o) => o.key === key)?.signing.publicKey.toString('hex') ?? null,
      cached: async () => d.cache,
      forget: async (ids) => {
        const out: { path: string; ids: string[] }[] = [];
        for (const c of d.cache) {
          const gone = c.runs.filter((r) => ids.has(r.id)).map((r) => r.id);
          c.runs = c.runs.filter((r) => !ids.has(r.id));
          if (gone.length) out.push({ path: c.path, ids: gone });
        }
        return out;
      },
      changed: (path, added, removed) => d.changes.push({ path, added, removed }),
      announce: () => d.announced++,
      live: (frame, path) => d.sent.push({ frame, path }),
      log: () => undefined,
      publishMs: 60_000,
      ...opts,
    });
  }
}

/** What `from` sent as it happened, taken by `to` (as over the link: the link says who sent it), and forgotten. */
async function deliver(from: Device, to: Device): Promise<void> {
  for (const { frame } of from.sent.splice(0)) await to.out.receive(from.key, frame);
}

/** `to` fetches `from`'s outputs refs, as peers do (node.ts), under the remote name `as`. */
function fetchInto(to: Device, from: Device, as = 'peer'): void {
  git(to.dir, 'fetch', '-q', '--prune', '--no-write-fetch-head', from.dir, outputsRefspec(as));
}

describe('shared run outputs', () => {
  it('publish a device’s cache as a signed commit with no parent, outside the branches, one blob per plot', async () => {
    const [a, b] = [device('a'), device('b')];
    connect(a, b);
    const image = { type: 'image' as const, mime: 'image/png', data: PLOT, width: 400, height: 300 };
    a.cache = [{ path: DOC, runs: [run('r1', 'x', { outputs: [image] }), run('r2', 'y', { outputs: [{ type: 'text', text: 'y' }, image] })] }];
    const oid = await a.out.publishNow();
    expect(oid).toMatch(/^[0-9a-f]{40}$/);
    expect(git(a.dir, 'rev-parse', `${OUTPUTS}${a.key}`)).toBe(oid);
    // No parent, signed by this device's key, and not a branch.
    expect(git(a.dir, 'rev-list', '--count', oid!)).toBe('1');
    expect(await commitSigner(new Git(a.dir), oid!)).toBe(a.signing.publicKey.toString('hex'));
    expect(git(a.dir, 'branch', '-a', '--format=%(refname)')).toBe('refs/heads/main');
    // Two runs, one plot, as its bytes.
    const sha = createHash('sha256').update(Buffer.from(PLOT, 'base64')).digest('hex');
    const docDir = createHash('sha1').update(DOC).digest('hex');
    expect(git(a.dir, 'ls-tree', '-r', '--name-only', oid!).split('\n').sort()).toEqual([`images/${sha}`, `runs/${docDir}/r1.json`, `runs/${docDir}/r2.json`]);
    expect(execFileSync('git', ['cat-file', 'blob', `${oid}:images/${sha}`], { cwd: a.dir }).toString('base64')).toBe(PLOT);
    expect(a.announced).toBe(1);
    // Nothing changed: nothing published.
    expect(await a.out.publishNow()).toBeNull();
    // A new run replaces the commit; the plot already written is named, not written again.
    a.cache[0]!.runs.push(run('r3', 'z'));
    const next = await a.out.publishNow();
    expect(next).not.toBe(oid);
    expect(git(a.dir, 'rev-list', '--count', next!)).toBe('1');
    expect(git(a.dir, 'rev-parse', `${next}:images/${sha}`)).toBe(git(a.dir, 'rev-parse', `${oid}:images/${sha}`));
  });

  it('let another device fetch and take them, shown with the device they ran on and their plots, and tell who has the document open', async () => {
    const [a, b] = [device('a'), device('b')];
    connect(a, b);
    a.cache = [{ path: DOC, runs: [run('r1', 'x', { outputs: [{ type: 'text', text: 'hi' }, { type: 'image', mime: 'image/png', data: PLOT, width: 4, height: 3 }] })] }];
    const oid = (await a.out.publishNow())!;
    await b.out.start();
    expect(await b.out.lacks({ [a.key]: oid })).toBe(true);
    fetchInto(b, a);
    expect(await b.out.lacks({ [a.key]: oid })).toBe(false); // fetched: the commit is here
    await b.out.adopt('peer', a.key);
    expect(git(b.dir, 'rev-parse', `${OUTPUTS}${a.key}`)).toBe(oid);
    const runs = await b.out.runs(DOC);
    expect(runs).toEqual([{ ...a.cache[0]!.runs[0], device: 'ada-laptop' }]);
    expect(b.changes).toEqual([{ path: DOC, added: runs, removed: [] }]);
    expect(await b.out.runs('other.Rmd')).toEqual([]);
    // Taking the same again changes nothing.
    await b.out.adopt('peer', a.key);
    expect(b.changes).toHaveLength(1);
  });

  it('pass on a device’s outputs through another, keeping only the newest, and only if signed by that device', async () => {
    const [a, b, c] = [device('a'), device('b'), device('c')];
    connect(a, b, c);
    a.cache = [{ path: DOC, runs: [run('r1', 'x')] }];
    const first = (await a.out.publishNow())!;
    fetchInto(b, a, 'ada');
    await b.out.adopt('ada', a.key);
    // C hears of A's outputs from B: signed by A, so taken.
    fetchInto(c, b, 'bee');
    await c.out.adopt('bee', b.key);
    expect((await c.out.runs(DOC)).map((r) => r.id)).toEqual(['r1']);

    // A publishes again, a second later; C takes it from A directly, then B passes on the older one: kept out.
    await new Promise((r) => setTimeout(r, 1100));
    a.cache[0]!.runs = [run('r2', 'x2')];
    const second = (await a.out.publishNow())!;
    fetchInto(c, a, 'ada');
    await c.out.adopt('ada', a.key);
    fetchInto(c, b, 'bee');
    await c.out.adopt('bee', b.key);
    expect(git(c.dir, 'rev-parse', `${OUTPUTS}${a.key}`)).toBe(second);
    expect((await c.out.runs(DOC)).map((r) => r.id)).toEqual(['r2']);
    expect(first).not.toBe(second);

    // B makes outputs of its own, and passes them on as if they were A's: not signed by A, not taken.
    b.cache = [{ path: DOC, runs: [run('forged', 'x')] }];
    const bees = (await b.out.publishNow())!;
    git(b.dir, 'update-ref', `${fetchedFrom('ada')}${a.key}`, bees);
    git(c.dir, 'fetch', '-q', '--no-write-fetch-head', b.dir, `+${fetchedFrom('ada')}*:${fetchedFrom('bee')}*`);
    await c.out.adopt('bee', b.key);
    expect(git(c.dir, 'rev-parse', `${OUTPUTS}${a.key}`)).toBe(second);
    expect((await c.out.runs(DOC)).map((r) => r.id)).toEqual(['r2']);
  });

  it('clear another device’s output everywhere: hidden here at once, and forgotten by the device that made it', async () => {
    const [a, b] = [device('a'), device('b')];
    connect(a, b);
    a.cache = [{ path: DOC, runs: [run('r1', 'x'), run('r2', 'y', { chunk: { label: null, index: 1, codeHash: 'y' } })] }];
    await a.out.publishNow();
    await a.out.start();
    await b.out.start();
    fetchInto(b, a);
    await b.out.adopt('peer', a.key);
    // Cleared on B: gone from what B shows, and said in B's outputs.
    expect(await b.out.hide(DOC, { label: null, index: 0, codeHash: 'x' })).toEqual(['r1']);
    expect((await b.out.runs(DOC)).map((r) => r.id)).toEqual(['r2']);
    expect(await b.out.hidden()).toEqual(new Set(['r1']));
    const bees = (await b.out.publishNow())!;
    expect(JSON.parse(git(b.dir, 'cat-file', 'blob', `${bees}:hidden.json`))).toEqual({ ids: ['r1'] });
    // A takes B's outputs, and forgets the run B's person cleared: whoever has the document open there is told.
    fetchInto(a, b);
    await a.out.adopt('peer', b.key);
    expect(a.cache[0]!.runs.map((r) => r.id)).toEqual(['r2']);
    expect(a.changes).toContainEqual({ path: DOC, added: [], removed: ['r1'] });
    // Clearing a whole document hides every run of it another device made.
    expect(await b.out.hide(DOC)).toEqual(['r2']);
    expect(await b.out.runs(DOC)).toEqual([]);
  });

  it('drop the outputs of a device no longer in the workspace', async () => {
    const [a, b] = [device('a'), device('b')];
    connect(a, b);
    a.cache = [{ path: DOC, runs: [run('r1', 'x')] }];
    await a.out.publishNow();
    fetchInto(b, a);
    await b.out.adopt('peer', a.key);
    b.members = [];
    await b.out.adopt('peer', a.key);
    expect(git(b.dir, 'for-each-ref', OUTPUTS)).toBe('');
    expect(await b.out.runs(DOC)).toEqual([]);
    expect(b.changes.at(-1)).toEqual({ path: DOC, added: [], removed: ['r1'] });
  });

  it('publish the newest runs first, up to a limit', async () => {
    const [a] = [device('a')];
    connect(a);
    const big = Buffer.alloc(Math.floor(MAX_SHARED_BYTES * 0.6)).toString('base64').slice(0, Math.floor(MAX_SHARED_BYTES * 0.6));
    a.cache = [{
      path: DOC, runs: [
        run('old', 'x', { outputs: [{ type: 'text', text: big }], finishedAt: '2026-11-01T00:00:00.000Z' }),
        run('new', 'y', { outputs: [{ type: 'text', text: big }], finishedAt: '2026-11-02T00:00:00.000Z' }),
        run('small', 'z', { finishedAt: '2026-10-01T00:00:00.000Z' }),
      ],
    }];
    const oid = (await a.out.publishNow())!;
    expect(git(a.dir, 'ls-tree', '-r', '--name-only', oid).split('\n').map((p) => p.split('/').pop()).sort()).toEqual(['new.json', 'small.json']);
  });
});

describe('run outputs as they happen (0062)', () => {
  const image = { type: 'image' as const, mime: 'image/png', data: PLOT, width: 4, height: 3 };

  it('send a run as it goes, its plots as bytes, to the devices with its document open; shown there at once, with the device it runs on', async () => {
    const [a, b] = [device('a'), device('b')];
    connect(a, b);
    const queued = run('r1', 'x', { state: 'queued', outputs: [], finishedAt: null, ms: null });
    a.out.ran(queued);
    a.out.ran({ ...queued, state: 'running' });
    expect(a.sent.map((s) => [s.path, (s.frame.meta.run as RunRecord).state])).toEqual([[DOC, 'queued'], [DOC, 'running']]);
    await deliver(a, b);
    // Under way there: said, and listed among the document's runs waiting, never among its outputs.
    expect(b.changes.map((c) => c.added.map((r) => [r.id, r.state, r.device]))).toEqual([[['r1', 'queued', 'ada-laptop']], [['r1', 'running', 'ada-laptop']]]);
    expect((await b.out.pending(DOC)).map((r) => [r.id, r.device])).toEqual([['r1', 'ada-laptop']]);
    expect(await b.out.runs(DOC)).toEqual([]);

    const done = run('r1', 'x', { outputs: [{ type: 'text', text: 'hi' }, image, image] });
    a.out.ran(done);
    const { frame } = a.sent[0]!;
    expect(frame.data).toHaveLength(1); // one plot, shown twice, sent once
    expect(frame.data[0]!.toString('base64')).toBe(PLOT);
    expect(JSON.stringify(frame.meta)).not.toContain(PLOT);
    await deliver(a, b);
    expect(await b.out.pending(DOC)).toEqual([]);
    expect(await b.out.runs(DOC)).toEqual([{ ...done, device: 'ada-laptop' }]);
    expect(b.changes.at(-1)).toEqual({ path: DOC, added: [{ ...done, device: 'ada-laptop' }], removed: [] });
  });

  it('keep what came as it happened until a commit of that device holds it, then show it once', async () => {
    const [a, b] = [device('a'), device('b')];
    connect(a, b);
    const r1 = run('r1', 'x', { outputs: [image], finishedAt: new Date().toISOString() });
    a.out.ran(r1);
    await deliver(a, b);
    expect(b.changes).toHaveLength(1);
    // The commit holds it: nothing new to say, and shown once.
    a.cache = [{ path: DOC, runs: [r1] }];
    await a.out.publishNow();
    fetchInto(b, a);
    await b.out.adopt('peer', a.key);
    expect(b.changes).toHaveLength(1);
    expect(await b.out.runs(DOC)).toEqual([{ ...r1, device: 'ada-laptop' }]);
    // A run that finished just after the commit was made, and came as it happened, stays until the next.
    const r2 = run('r2', 'y', { chunk: { label: null, index: 1, codeHash: 'y' }, finishedAt: new Date(Date.now() + 5000).toISOString() });
    a.out.ran(r2);
    await deliver(a, b);
    expect((await b.out.runs(DOC)).map((r) => r.id).sort()).toEqual(['r1', 'r2']);
  });

  it('let go of a run that came as it happened once a later commit shows it gone there', async () => {
    const [a, b] = [device('a'), device('b')];
    connect(a, b);
    a.out.ran(run('old', 'x', { finishedAt: '2026-11-01T00:00:00.000Z' }));
    await deliver(a, b);
    a.cache = [{ path: DOC, runs: [run('other', 'y')] }];
    await a.out.publishNow();
    fetchInto(b, a);
    await b.out.adopt('peer', a.key);
    expect((await b.out.runs(DOC)).map((r) => r.id)).toEqual(['other']);
    expect(b.changes.at(-1)).toMatchObject({ removed: ['old'] });
  });

  it('clear at once on the devices connected: a device’s own runs (gone), and another’s (hidden, and forgotten by the one that made it)', async () => {
    const [a, b] = [device('a'), device('b')];
    connect(a, b);
    a.cache = [{ path: DOC, runs: [run('r1', 'x'), run('r2', 'y', { chunk: { label: null, index: 1, codeHash: 'y' } })] }];
    await a.out.publishNow();
    fetchInto(b, a);
    await b.out.adopt('peer', a.key);
    // A's person clears r1 there: B stops showing it at once, though A's commit still holds it.
    a.out.cleared(['r1']);
    expect(a.sent.at(-1)!.path).toBeNull();
    await deliver(a, b);
    expect((await b.out.runs(DOC)).map((r) => r.id)).toEqual(['r2']);
    expect(b.changes.at(-1)).toEqual({ path: DOC, added: [], removed: ['r1'] });
    // B's person clears r2: A forgets it at once.
    expect(await b.out.hide(DOC, { label: null, index: 1, codeHash: 'y' })).toEqual(['r2']);
    expect(b.sent.at(-1)).toEqual({ frame: { meta: { op: 'hide', ids: ['r2'] }, data: [] }, path: null });
    await a.out.start();
    await deliver(b, a);
    expect(a.cache[0]!.runs.map((r) => r.id)).toEqual(['r1']);
    expect(a.changes).toContainEqual({ path: DOC, added: [], removed: ['r2'] });
  });

  it('stop showing a device’s runs under way once it goes, or once cancelled', async () => {
    const [a, b] = [device('a'), device('b')];
    connect(a, b);
    a.out.ran(run('r1', 'x', { state: 'running', outputs: [], finishedAt: null }));
    a.out.ran(run('r2', 'y', { state: 'queued', outputs: [], finishedAt: null }));
    await deliver(a, b);
    a.out.ran(run('r2', 'y', { state: 'cancelled', outputs: [], finishedAt: null }));
    await deliver(a, b);
    expect(b.changes.at(-1)).toEqual({ path: DOC, added: [], removed: ['r2'] });
    b.out.disconnected(a.key);
    expect(b.changes.at(-1)).toEqual({ path: DOC, added: [], removed: ['r1'] });
    expect(await b.out.pending(DOC)).toEqual([]);
  });

  it('take runs only from a member, about its own, well formed; and send by git alone a run too large', async () => {
    const [a, b, stranger] = [device('a'), device('b'), device('s')];
    connect(a, b);
    // From a device not in the workspace: not taken.
    await b.out.receive(stranger.key, { meta: { op: 'run', run: run('x1', 'x') }, data: [] });
    // A plot it does not carry, or a state no run has: not taken.
    await b.out.receive(a.key, { meta: { op: 'run', run: { ...run('x2', 'x'), outputs: [{ ...image, data: '', blob: 'f'.repeat(64) }] } }, data: [] });
    await b.out.receive(a.key, { meta: { op: 'run', run: { ...run('x3', 'x'), state: 'exploded' } }, data: [] });
    expect(await b.out.runs(DOC)).toEqual([]);
    expect(b.changes).toEqual([]);
    // Too large to send as it happened: left to git.
    a.out.ran(run('big', 'x', { outputs: [{ type: 'text', text: 'x'.repeat(MAX_LIVE_BYTES) }] }));
    expect(a.sent).toEqual([]);
  });

  it('publish soon after a first change, and then no sooner than a gap after the last', async () => {
    const [a] = [device('a')];
    connectWith({ publishMs: 20, gapMs: 400 }, a);
    a.cache = [{ path: DOC, runs: [run('r1', 'x')] }];
    a.out.publish();
    await new Promise((r) => setTimeout(r, 300));
    const first = git(a.dir, 'rev-parse', `${OUTPUTS}${a.key}`);
    a.cache[0]!.runs.push(run('r2', 'y', { chunk: { label: null, index: 1, codeHash: 'y' } }));
    a.out.publish();
    await new Promise((r) => setTimeout(r, 30));
    expect(git(a.dir, 'rev-parse', `${OUTPUTS}${a.key}`)).toBe(first);
    await new Promise((r) => setTimeout(r, 500));
    expect(git(a.dir, 'rev-parse', `${OUTPUTS}${a.key}`)).not.toBe(first);
    a.out.close();
  });
});
