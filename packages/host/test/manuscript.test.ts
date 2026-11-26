// The manuscript (docs/decisions/0091-order-and-manuscripts-over-folders.md) on a
// host: a folder made a manuscript (a .kuraa-manuscript.yml in it), not one
// inside another; documents and folders left out and put back, each written
// and committed; renames and deletions followed; unmade.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { manuscriptFeature } from '@kuraa/manuscript';
import { startHost, type RunningHost } from '../src/index.js';

const ANA = { name: 'Ana Lima', email: 'ana@example.org', color: '#d33' };
const FAST = { flushMs: 150, idleCommitMs: 500, maxCommitMs: 5000, dropMs: 400 };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

type Shown = { folder: string; title: string | null; name: string; exclude: string[] };

describe('the manuscript', () => {
  let dir: string;
  let running: RunningHost;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' } });
  const post = async (route: string, body: object) => {
    const r = await api(`/api/features/manuscript/${route}`, { method: 'POST', body: JSON.stringify({ body, by: ANA }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const list = async () => ((await (await api('/api/features/manuscript/manuscripts')).json()) as { manuscripts: Shown[] }).manuscripts;
  const read = (p: string) => readFileSync(join(dir, p), 'utf8');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-manuscript-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test Host');
    git(dir, 'config', 'user.email', 'host@example.org');
    mkdirSync(join(dir, 'novel/research'), { recursive: true });
    writeFileSync(join(dir, 'novel/arrival.md'), '---\ntitle: Arrival\n---\n\nWe came.\n');
    writeFileSync(join(dir, 'novel/notes.md'), 'Notes.\n');
    writeFileSync(join(dir, 'novel/research/sources.md'), 'Sources.\n');
    writeFileSync(join(dir, 'novel/map.png'), 'not really a picture');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    running = await startHost({ dir, timings: FAST, features: [manuscriptFeature] });
    // Off until the workspace turns it on.
    expect((await api('/api/features/manuscript/manuscripts')).status).toBe(409);
    expect((await api('/api/features/manuscript', { method: 'PATCH', body: JSON.stringify({ on: true, by: ANA }) })).status).toBe(200);
  });

  afterEach(async () => {
    await running.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('makes a folder a manuscript, leaves out and puts back, and unmakes it', async () => {
    expect(await list()).toEqual([]);
    expect(await post('make', { folder: 'novel/' })).toEqual({ status: 200, body: { folder: 'novel/' } });
    expect(read('novel/.kuraa-manuscript.yml')).toMatch(/^# This folder is a manuscript in Kuraa/);
    expect(git(dir, 'log', '-1', '--format=%s%n%b')).toMatch(/Make novel\/ a manuscript[\s\S]*Co-authored-by: Ana Lima/);
    expect(await list()).toEqual([{ folder: 'novel/', title: null, name: 'novel', exclude: [] }]);
    // One in another, or around another: no.
    expect((await post('make', { folder: 'novel/research' })).status).toBe(409);
    expect((await post('make', { folder: '' })).status).toBe(409);
    expect((await post('make', { folder: 'novel' })).status).toBe(409);
    expect((await post('make', { folder: 'nowhere' })).status).toBe(404);

    expect((await post('include', { path: 'novel/notes.md', include: false })).status).toBe(200);
    expect((await post('include', { path: 'novel/research/', include: false })).status).toBe(200);
    expect(read('novel/.kuraa-manuscript.yml')).toContain('exclude:\n  - notes.md\n  - research\n');
    expect((await list())[0]!.exclude).toEqual(['novel/notes.md', 'novel/research']);
    // Not a document a book is made of; not in a manuscript.
    expect((await post('include', { path: 'novel/map.png', include: false })).status).toBe(400);
    writeFileSync(join(dir, 'loose.md'), 'Loose.\n');
    expect((await post('include', { path: 'loose.md', include: false })).status).toBe(404);
    expect((await post('include', { path: 'novel/notes.md', include: true })).status).toBe(200);
    expect((await list())[0]!.exclude).toEqual(['novel/research']);

    expect((await post('unmake', { folder: 'novel/' })).status).toBe(200);
    expect(existsSync(join(dir, 'novel/.kuraa-manuscript.yml'))).toBe(false);
    expect(await list()).toEqual([]);
    expect((await post('unmake', { folder: 'novel/' })).status).toBe(404);
    expect(git(dir, 'status', '--porcelain')).toBe('?? loose.md');
  });

  it('follows renames and deletions of what it leaves out, and moves with its folder', async () => {
    await post('make', { folder: 'novel/' });
    await post('include', { path: 'novel/notes.md', include: false });
    await post('include', { path: 'novel/research', include: false });
    const rename = (from: string, to: string) => api('/api/files', { method: 'PATCH', body: JSON.stringify({ from, to }) });
    expect((await rename('novel/notes.md', 'novel/old-notes.md')).status).toBe(200);
    await until(async () => (await list())[0]!.exclude.includes('novel/old-notes.md'), 10_000, 'the rename to be followed');
    // The manuscript's folder renamed: its file goes with it, what it names stays named from it.
    expect((await rename('novel', 'story')).status).toBe(200);
    expect(await list()).toEqual([{ folder: 'story/', title: null, name: 'story', exclude: ['story/old-notes.md', 'story/research'] }]);
    expect((await api(`/api/files?path=${encodeURIComponent('story/research')}`, { method: 'DELETE' })).status).toBe(200);
    await until(async () => (await list())[0]!.exclude.length === 1, 10_000, 'the deletion to be followed');
    await until(() => git(dir, 'status', '--porcelain') === '', 10_000, 'everything committed');
  });
});
