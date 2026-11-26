// The manuscript (docs/decisions/0088-a-manuscript-is-a-quarto-book.md) on a host:
// a folder made a manuscript, its order changed, a document added and taken
// out, each written to its _quarto.yml and committed; renames and deletions
// followed; and a _quarto.yml that is open in a room left to the room.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

describe('the manuscript', () => {
  let dir: string;
  let running: RunningHost;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' } });
  const post = async (route: string, body: object) => {
    const r = await api(`/api/features/manuscript/${route}`, { method: 'POST', body: JSON.stringify({ body, by: ANA }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const list = async () => ((await (await api('/api/features/manuscript/manuscripts')).json()) as { manuscripts: { file: string; folder: string; title: string; chapters: unknown[]; appendices: string[] }[] }).manuscripts;
  const book = () => readFileSync(join(dir, 'novel/_quarto.yml'), 'utf8');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-manuscript-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test Host');
    git(dir, 'config', 'user.email', 'host@example.org');
    mkdirSync(join(dir, 'novel/chapters'), { recursive: true });
    writeFileSync(join(dir, 'novel/chapters/b-harbour.md'), '---\ntitle: The harbour\n---\n\nBoats.\n');
    writeFileSync(join(dir, 'novel/chapters/a-arrival.md'), '---\ntitle: Arrival\n---\n\nWe came.\n');
    writeFileSync(join(dir, 'novel/notes.md'), 'Research.\n');
    writeFileSync(join(dir, 'other.md'), 'Elsewhere.\n');
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

  it('makes a folder a manuscript, changes its order, adds and takes out documents, each committed', async () => {
    expect(await list()).toEqual([]);
    const made = await post('make', { folder: 'novel/' });
    expect(made).toEqual({ status: 200, body: { file: 'novel/_quarto.yml' } });
    expect(book()).toBe('project:\n  type: book\n\nbook:\n  title: "novel"\n  chapters:\n    - chapters/a-arrival.md\n    - chapters/b-harbour.md\n    - notes.md\n');
    expect(git(dir, 'log', '-1', '--format=%s%n%b')).toMatch(/novel\/_quarto\.yml[\s\S]*Co-authored-by: Ana Lima/);
    expect((await post('make', { folder: 'novel/' })).status).toBe(409);

    // The writer's own settings and comments stay as they are.
    writeFileSync(join(dir, 'novel/_quarto.yml'), `${book()}\n# Rendered for the press.\nformat:\n  pdf: default\n`);
    git(dir, 'commit', '-qam', 'Settings');
    const order = {
      file: 'novel/_quarto.yml',
      chapters: [{ part: 'The coast', chapters: ['novel/chapters/b-harbour.md', 'novel/chapters/a-arrival.md'] }],
      appendices: ['novel/notes.md'],
    };
    expect((await post('order', order)).status).toBe(200);
    expect(book()).toContain('  chapters:\n    - part: The coast\n      chapters:\n        - chapters/b-harbour.md\n        - chapters/a-arrival.md\n  appendices:\n    - notes.md\n');
    expect(book()).toContain('# Rendered for the press.\nformat:\n  pdf: default');
    const [m] = await list();
    expect(m).toMatchObject({ folder: 'novel/', title: 'novel', chapters: order.chapters, appendices: order.appendices });
    // Only its folder's documents.
    expect((await post('order', { ...order, appendices: ['other.md'] })).status).toBe(400);

    expect((await post('remove', { path: 'novel/notes.md' })).status).toBe(200);
    expect(book()).not.toContain('notes.md');
    expect((await post('add', { path: 'novel/notes.md' })).status).toBe(200);
    expect(book()).toContain('    - notes.md\n');
    expect((await post('add', { path: 'other.md' })).status).toBe(404);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('follows a chapter renamed, and one deleted', async () => {
    await post('make', { folder: 'novel/' });
    const r = await api('/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'novel/chapters', to: 'novel/text' }) });
    expect(r.status).toBe(200);
    await until(() => book().includes('text/a-arrival.md'), 10_000, 'the book to follow the rename');
    expect(book()).not.toContain('chapters/a-arrival.md');
    expect((await api(`/api/files?path=${encodeURIComponent('novel/notes.md')}`, { method: 'DELETE' })).status).toBe(200);
    await until(() => !book().includes('notes.md'), 10_000, 'the book to follow the deletion');
    await until(() => git(dir, 'status', '--porcelain') === '', 10_000, 'everything committed');
  });
});
