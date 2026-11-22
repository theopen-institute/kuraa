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
import { MAX_SHARED_BYTES, OUTPUTS, SharedOutputs, fetchedFrom, outputsRefspec } from '../src/peers/outputs.js';

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
  out: SharedOutputs;
  members: { key: string; name: string }[];
}

function device(name: string): Device {
  const dir = mkdtempSync(join(tmpdir(), `kuraa-outputs-${name}-`));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, '-c', 'user.name=T', '-c', 'user.email=t@example.org', 'commit', '-q', '--allow-empty', '-m', 'Initial');
  const d = { dir, key: randomBytes(32).toString('hex'), signing: crypto.keyPair(), cache: [], changes: [], announced: 0, members: [] } as unknown as Device;
  return d;
}

/** Each device knows the others as members, signing with their keys. */
function connect(...devices: Device[]): void {
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
      log: () => undefined,
      publishMs: 60_000,
    });
  }
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
