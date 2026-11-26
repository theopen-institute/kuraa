// Compile (docs/decisions/0091-order-and-compile-over-folders.md) on a host:
// on by default; documents and folders left out of compiles and put back, each
// written to their folder's .kuraa-compile.yml and committed; a folder's title
// and format kept; what is left out following renames, moves and deletions;
// a folder's render refused where rendering is off, as a document's is.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileFeature } from '@kuraa/compile';
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

type Folder = { folder: string; title: string | null; format: string | null; exclude: string[] };

describe('Compile', () => {
  let dir: string;
  let running: RunningHost;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' } });
  const post = async (route: string, body: object) => {
    const r = await api(`/api/features/compile/${route}`, { method: 'POST', body: JSON.stringify({ body, by: ANA }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const folders = async () => ((await (await api('/api/features/compile/folders')).json()) as { folders: Folder[] }).folders;
  const read = (p: string) => readFileSync(join(dir, p), 'utf8');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-compile-'));
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
    running = await startHost({ dir, timings: FAST, features: [compileFeature] });
  });

  afterEach(async () => {
    await running.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves documents and folders out, puts them back, and keeps a folder’s title and format', async () => {
    // On by default.
    expect(await folders()).toEqual([]);
    expect((await post('include', { path: 'novel/notes.md', include: false })).status).toBe(200);
    expect((await post('include', { path: 'novel/research/', include: false })).status).toBe(200);
    expect(read('novel/.kuraa-compile.yml')).toMatch(/^# Kuraa’s Compile for this folder[\s\S]*exclude:\n {2}- notes.md\n {2}- research\n$/);
    expect(git(dir, 'log', '-1', '--format=%s%n%b')).toMatch(/Leave research in novel\/ out of Compile[\s\S]*Co-authored-by: Ana Lima/);
    expect((await post('include', { path: 'novel/map.png', include: false })).status).toBe(400);
    expect((await post('include', { path: 'novel/gone.md', include: false })).status).toBe(404);

    expect((await post('settings', { folder: 'novel', title: 'The Coast', format: 'pdf' })).status).toBe(200);
    expect(await folders()).toEqual([{ folder: 'novel', title: 'The Coast', format: 'pdf', exclude: ['notes.md', 'research'] }]);

    // Put back, and nothing kept: the file goes.
    await post('include', { path: 'novel/notes.md', include: true });
    await post('include', { path: 'novel/research', include: true });
    await post('settings', { folder: 'novel', title: null, format: null });
    expect(existsSync(join(dir, 'novel/.kuraa-compile.yml'))).toBe(false);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('keeps what is left out left out when it is renamed or moved, and forgets it when it is deleted', async () => {
    await post('include', { path: 'novel/notes.md', include: false });
    await post('include', { path: 'novel/research', include: false });
    const rename = (from: string, to: string) => api('/api/files', { method: 'PATCH', body: JSON.stringify({ from, to }) });
    expect((await rename('novel/notes.md', 'novel/old-notes.md')).status).toBe(200);
    await until(async () => (await folders())[0]?.exclude.includes('old-notes.md') ?? false, 10_000, 'the rename to be followed');
    // Moved to the top: still left out, there.
    expect((await rename('novel/old-notes.md', 'old-notes.md')).status).toBe(200);
    await until(async () => (await folders()).some((f) => f.folder === '' && f.exclude.includes('old-notes.md')), 10_000, 'the move to be followed');
    expect((await api(`/api/files?path=${encodeURIComponent('novel/research')}`, { method: 'DELETE' })).status).toBe(200);
    await until(async () => !(await folders()).some((f) => f.folder === 'novel'), 10_000, 'the deletion to be followed');
    await until(() => git(dir, 'status', '--porcelain') === '', 10_000, 'everything committed');
  });

  it('asks the host to render a folder, which says why it cannot here', async () => {
    const r = await api('/api/renders', { method: 'POST', body: JSON.stringify({ path: 'novel/', format: 'docx', exclude: ['novel/notes.md'], title: 'The Coast', by: ANA }) });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toMatch(/Rendering is turned off/);
    expect((await api('/api/renders', { method: 'POST', body: JSON.stringify({ path: 'nowhere/', format: 'docx', by: ANA }) })).status).toBe(404);
    expect((await api(`/api/renders?path=${encodeURIComponent('novel/')}`)).status).toBe(200);
  });
});
