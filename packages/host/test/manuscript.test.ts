// The manuscript (docs/decisions/0088-a-manuscript-is-a-quarto-book.md, 0090) on a
// host: manuscripts made as Quarto profiles' books at the top of the
// workspace, their chapters any of its documents, a document in one at most; the
// order changed, documents added (in place) and taken out, each written and
// committed; home folders kept; renames and deletions followed; a book of a
// project of its own (a folder's _quarto.yml) read and changed as before.
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

type Shown = { file: string; folder: string; profile: string | null; title: string; home: string | null; chapters: unknown[]; appendices: string[] };

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
    mkdirSync(join(dir, 'novel/chapters'), { recursive: true });
    mkdirSync(join(dir, 'field'), { recursive: true });
    writeFileSync(join(dir, 'novel/chapters/b-harbour.md'), '---\ntitle: The harbour\n---\n\nBoats.\n');
    writeFileSync(join(dir, 'novel/chapters/a-arrival.md'), '---\ntitle: Arrival\n---\n\nWe came.\n');
    writeFileSync(join(dir, 'novel/notes.md'), 'Research.\n');
    writeFileSync(join(dir, 'field/tides.md'), 'Tides.\n');
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

  it('makes manuscripts as profiles’ books, their chapters anywhere, a document in one at most', async () => {
    expect(await list()).toEqual([]);
    // Of a folder: its documents, its home that folder.
    expect(await post('make', { folder: 'novel/' })).toEqual({ status: 200, body: { file: '_quarto-novel.yml' } });
    expect(read('_quarto-novel.yml')).toBe('book:\n  title: "novel"\n  chapters:\n    - novel/chapters/a-arrival.md\n    - novel/chapters/b-harbour.md\n    - novel/notes.md\n');
    expect(read('_quarto.yml')).toBe('project:\n  type: book\nprofile:\n  group:\n    - [ novel ]\n');
    expect(JSON.parse(read('.kuraa/manuscripts.json'))).toEqual({ homes: { '_quarto-novel.yml': 'novel/' } });
    expect(git(dir, 'log', '-1', '--format=%b')).toMatch(/Co-authored-by: Ana Lima/);
    // By a title: empty, its home a folder named for it (made when its first chapter is).
    expect(await post('make', { title: 'A Thesis' })).toEqual({ status: 200, body: { file: '_quarto-a-thesis.yml' } });
    expect(read('_quarto.yml')).toContain('    - [ novel, a-thesis ]\n');
    const [thesis, novel] = await list();
    expect(novel).toMatchObject({ file: '_quarto-novel.yml', folder: '', profile: 'novel', title: 'novel', home: 'novel/' });
    expect(thesis).toMatchObject({ file: '_quarto-a-thesis.yml', profile: 'a-thesis', title: 'A Thesis', home: 'a-thesis/', chapters: [] });

    // Any document, from anywhere; but in one manuscript only (0090), and in it once.
    expect((await post('add', { file: '_quarto-a-thesis.yml', path: 'field/tides.md' })).status).toBe(200);
    expect(read('_quarto-a-thesis.yml')).toContain('    - field/tides.md\n');
    const taken = await post('add', { file: '_quarto-a-thesis.yml', path: 'novel/notes.md' });
    expect(taken.status).toBe(409);
    expect(taken.body.message).toMatch(/novel\/notes\.md is in novel already/);
    expect((await post('order', { file: '_quarto-a-thesis.yml', chapters: [{ chapter: 'field/tides.md' }, { chapter: 'novel/notes.md' }], appendices: [] })).status).toBe(409);
    expect((await post('order', { file: '_quarto-novel.yml', chapters: [{ chapter: 'novel/notes.md' }, { chapter: 'novel/notes.md' }], appendices: [] })).status).toBe(400);
    // Taken out of one, it may go in another; in place, after a chapter.
    expect((await post('remove', { file: '_quarto-a-thesis.yml', path: 'field/tides.md' })).status).toBe(200);
    expect(read('_quarto-a-thesis.yml')).not.toContain('tides.md');
    expect((await post('add', { file: '_quarto-novel.yml', path: 'field/tides.md', after: 'novel/chapters/a-arrival.md' })).status).toBe(200);
    expect(read('_quarto-novel.yml')).toContain('    - novel/chapters/a-arrival.md\n    - field/tides.md\n    - novel/chapters/b-harbour.md\n');

    // Its home changed.
    expect((await post('home', { file: '_quarto-a-thesis.yml', home: 'field' })).status).toBe(200);
    expect(JSON.parse(read('.kuraa/manuscripts.json')).homes['_quarto-a-thesis.yml']).toBe('field/');
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('follows renames and deletions into the manuscripts, and homes with them', async () => {
    await post('make', { folder: 'novel/' });
    await post('make', { title: 'Thesis' });
    await post('add', { file: '_quarto-thesis.yml', path: 'field/tides.md' });
    const r = await api('/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'novel', to: 'story' }) });
    expect(r.status).toBe(200);
    await until(() => read('_quarto-novel.yml').includes('story/chapters/a-arrival.md'), 10_000, 'the book to follow the rename');
    await until(() => JSON.parse(read('.kuraa/manuscripts.json')).homes['_quarto-novel.yml'] === 'story/', 10_000, 'the home to follow');
    expect((await api('/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'field/tides.md', to: 'story/tides.md' }) })).status).toBe(200);
    await until(() => read('_quarto-thesis.yml').includes('story/tides.md'), 10_000, 'a chapter moved into another’s folder stays in its book');
    expect((await api(`/api/files?path=${encodeURIComponent('story/chapters/a-arrival.md')}`, { method: 'DELETE' })).status).toBe(200);
    await until(() => !read('_quarto-novel.yml').includes('a-arrival'), 10_000, 'the book to follow the deletion');
    // A manuscript's file deleted: out of the project's group.
    expect((await api(`/api/files?path=${encodeURIComponent('_quarto-thesis.yml')}`, { method: 'DELETE' })).status).toBe(200);
    await until(() => !read('_quarto.yml').includes('thesis'), 10_000, 'the group to follow');
    expect(read('_quarto.yml')).toContain('- [ novel ]');
    await until(() => git(dir, 'status', '--porcelain') === '', 10_000, 'everything committed');
  });

  it('reads a folder’s book of its own, its chapters in its folder, and adds no profiles to a top-level book', async () => {
    writeFileSync(join(dir, 'novel/_quarto.yml'), '# Ours.\nproject:\n  type: book\nbook:\n  title: Novel\n  chapters:\n    - notes.md\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'A book of its own');
    const [m] = await list();
    expect(m).toMatchObject({ file: 'novel/_quarto.yml', folder: 'novel/', profile: null, title: 'Novel', home: 'novel/', chapters: [{ chapter: 'novel/notes.md' }] });
    expect((await post('add', { file: 'novel/_quarto.yml', path: 'field/tides.md' })).status).toBe(400);
    expect((await post('add', { file: 'novel/_quarto.yml', path: 'novel/chapters/a-arrival.md' })).status).toBe(200);
    expect(read('novel/_quarto.yml')).toBe('# Ours.\nproject:\n  type: book\nbook:\n  title: Novel\n  chapters:\n    - notes.md\n    - chapters/a-arrival.md\n');
    // A top-level _quarto.yml that is a book of its own: no profiles beside it.
    writeFileSync(join(dir, '_quarto.yml'), 'project:\n  type: book\nbook:\n  chapters:\n    - field/tides.md\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-qm', 'A top-level book');
    expect((await post('make', { title: 'Another' })).status).toBe(409);
    expect(existsSync(join(dir, '_quarto-another.yml'))).toBe(false);
  });
});
