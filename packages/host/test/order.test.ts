// Folders' orders (docs/decisions/0093-order-and-compile-over-folders.md):
// a `.kuraa-order` file in each folder arranged by hand, read with the tree,
// written and committed when someone arranges it, and following renames,
// moves and deletions of what it names.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatOrder, ordersAfterDelete, ordersAfterRename, orderedFolder, parseOrder } from '../src/order.js';
import { startHost, type RunningHost } from '../src/index.js';

const FAST = { flushMs: 150, idleCommitMs: 500, maxCommitMs: 5000, dropMs: 400 };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

describe('an order file', () => {
  it('is a name a line, comments and blank lines passed over, each name once', () => {
    expect(parseOrder('# about\nb.md\n\n  a  \nb.md\nx/y.md\n')).toEqual(['b.md', 'a']);
    expect(parseOrder(formatOrder(['c.md', 'part one'])!)).toEqual(['c.md', 'part one']);
    expect(formatOrder([])).toBeNull();
    expect(orderedFolder('.kuraa-order')).toBe('');
    expect(orderedFolder('novel/parts/.kuraa-order')).toBe('novel/parts');
    expect(orderedFolder('novel/a.md')).toBeNull();
  });

  it('follows a rename in place, a move out of one folder and to the end of another, and a deletion', () => {
    const orders = new Map([['novel', ['b.md', 'a.md']], ['drafts', ['x.md']], ['', ['novel', 'drafts']]]);
    expect(ordersAfterRename(orders, 'novel/a.md', 'novel/arrival.md')).toEqual(new Map([['novel', ['b.md', 'arrival.md']]]));
    expect(ordersAfterRename(orders, 'novel/a.md', 'drafts/a.md')).toEqual(new Map([['novel', ['b.md']], ['drafts', ['x.md', 'a.md']]]));
    // Into a folder arranged by name: it stays so.
    expect(ordersAfterRename(orders, 'novel/a.md', 'notes/a.md')).toEqual(new Map([['novel', ['b.md']]]));
    expect(ordersAfterRename(orders, 'novel', 'story')).toEqual(new Map([['', ['story', 'drafts']]]));
    expect(ordersAfterRename(orders, 'other/z.md', 'other/y.md')).toEqual(new Map());
    expect(ordersAfterDelete(orders, 'drafts/x.md')).toEqual(new Map([['drafts', []]]));
    expect(ordersAfterDelete(orders, 'drafts/nothing.md')).toEqual(new Map());
  });
});

describe('orders on a host', () => {
  let dir: string;
  let running: RunningHost;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' } });
  const order = async (folder: string, names: string[]) => api('/api/order', { method: 'POST', body: JSON.stringify({ folder, names }) });
  const tree = async () => ((await (await api('/api/tree')).json()) as { orders: Record<string, string[]> }).orders;
  const read = (p: string) => readFileSync(join(dir, p), 'utf8');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-order-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test Host');
    git(dir, 'config', 'user.email', 'host@example.org');
    mkdirSync(join(dir, 'novel/coast'), { recursive: true });
    for (const f of ['novel/a.md', 'novel/b.md', 'novel/c.md', 'novel/coast/d.md', 'loose.md']) writeFileSync(join(dir, f), `# ${f}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    running = await startHost({ dir, timings: FAST });
  });

  afterEach(async () => {
    await running.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps a folder’s order in it, committed, and gives it with the tree', async () => {
    expect(await tree()).toEqual({});
    const r = await order('novel', ['c.md', 'coast', 'a.md', 'gone.md', 'c.md']);
    expect(r.status).toBe(200);
    // Only what is there, each once.
    expect(parseOrder(read('novel/.kuraa-order'))).toEqual(['c.md', 'coast', 'a.md']);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Order novel/');
    expect(await tree()).toEqual({ novel: ['c.md', 'coast', 'a.md'] });
    // The top level's, at the top.
    expect((await order('', ['loose.md', 'novel'])).status).toBe(200);
    expect(existsSync(join(dir, '.kuraa-order'))).toBe(true);
    // None: by name again, the file gone.
    expect((await order('novel', [])).status).toBe(200);
    expect(existsSync(join(dir, 'novel/.kuraa-order'))).toBe(false);
    expect((await order('nowhere', ['a.md'])).status).toBe(404);
    expect((await order('novel', ['../loose.md'])).status).toBe(400);
  });

  it('follows renames, moves and deletions', async () => {
    await order('novel', ['c.md', 'a.md', 'coast']);
    await order('', ['novel', 'loose.md']);
    const rename = (from: string, to: string) => api('/api/files', { method: 'PATCH', body: JSON.stringify({ from, to }) });
    expect((await rename('novel/a.md', 'novel/arrival.md')).status).toBe(200);
    expect(parseOrder(read('novel/.kuraa-order'))).toEqual(['c.md', 'arrival.md', 'coast']);
    // Moved to the top: out of novel's, at the end of the top's.
    expect((await rename('novel/c.md', 'c.md')).status).toBe(200);
    expect(parseOrder(read('novel/.kuraa-order'))).toEqual(['arrival.md', 'coast']);
    expect(parseOrder(read('.kuraa-order'))).toEqual(['novel', 'loose.md', 'c.md']);
    // A folder renamed: its order goes with it, and its name changes in its folder's.
    expect((await rename('novel', 'story')).status).toBe(200);
    expect(parseOrder(read('story/.kuraa-order'))).toEqual(['arrival.md', 'coast']);
    expect(parseOrder(read('.kuraa-order'))).toEqual(['story', 'loose.md', 'c.md']);
    expect((await api(`/api/files?path=${encodeURIComponent('story/coast')}`, { method: 'DELETE' })).status).toBe(200);
    expect(parseOrder(read('story/.kuraa-order'))).toEqual(['arrival.md']);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});
