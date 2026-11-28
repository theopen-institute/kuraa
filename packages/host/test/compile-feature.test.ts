// Compile (docs/decisions/0093-order-and-compile-over-folders.md) on a host:
// on by default; documents and folders left out of compiles and put back, each
// written to their folder's .kuraa-compile.yml and committed; a folder's title
// and format kept; what is left out following renames, moves and deletions;
// a folder's render refused where rendering is off, as a document's is.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { compileFeature, emptyCompile } from '@kuraa/compile';
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

type Folder = { folder: string; title: string | null; format: string | null; heading: boolean; target: number | null; exclude: string[] };

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
    expect(await folders()).toEqual([{ ...emptyCompile('novel'), title: 'The Coast', format: 'pdf', exclude: ['notes.md', 'research'] }]);

    // The book's target in words (0094), and none again.
    expect((await post('target', { folder: 'novel', target: 80000 })).status).toBe(200);
    expect(read('novel/.kuraa-compile.yml')).toContain('target-words: 80000\n');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('A target of 80,000 words for novel/');
    expect((await folders())[0]!.target).toBe(80000);
    expect((await post('target', { folder: 'novel', target: 0 })).status).toBe(400);
    expect((await post('target', { folder: 'novel', target: null })).status).toBe(200);

    // A folder's name no heading where it is compiled inside another, and a heading again.
    expect((await post('heading', { folder: 'novel/research', heading: false })).status).toBe(200);
    expect(read('novel/research/.kuraa-compile.yml')).toMatch(/\nheading: false\n$/);
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('No heading for novel/research/ in Compile');
    expect((await post('heading', { folder: 'nowhere', heading: false })).status).toBe(404);
    expect((await post('heading', { folder: 'novel/research', heading: true })).status).toBe(200);
    expect(existsSync(join(dir, 'novel/research/.kuraa-compile.yml'))).toBe(false);

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

  it('keeps a book’s own settings as each changes, even several at once; a folder’s documents without titles; templates and covers to choose (0106)', async () => {
    writeFileSync(join(dir, 'house.docx'), 'a Word document');
    writeFileSync(join(dir, 'novel/cover.jpg'), 'a picture');
    const files = (await (await api('/api/features/compile/files')).json()) as { templates: string[]; images: string[] };
    expect(files).toEqual({ templates: ['house.docx'], images: ['novel/cover.jpg', 'novel/map.png'] });
    // Changed at once, as the panel may: each kept.
    const answers = await Promise.all([
      post('settings', { folder: 'novel', subtitle: 'A novel' }),
      post('settings', { folder: 'novel', author: 'Ada Byron' }),
      post('settings', { folder: 'novel', toc: true }),
      post('settings', { folder: 'novel', numbering: 'chapters' }),
      post('settings', { folder: 'novel', separator: '#' }),
      post('settings', { folder: 'novel', referenceDoc: 'house.docx' }),
      post('settings', { folder: 'novel', cover: 'novel/cover.jpg' }),
      post('titles', { folder: 'novel', titles: false }),
    ]);
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200, 200, 200, 200, 200, 200]);
    expect(await folders()).toEqual([{
      ...emptyCompile('novel'), subtitle: 'A novel', author: 'Ada Byron', toc: true, numbering: 'chapters', separator: '#',
      referenceDoc: 'house.docx', cover: 'novel/cover.jpg', titles: false,
    }]);
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('No titles for the documents in novel/ in Compile');
    // Not a Word document, or not there: refused.
    expect((await post('settings', { folder: 'novel', referenceDoc: 'novel/notes.md' })).status).toBe(400);
    expect((await post('settings', { folder: 'novel', cover: 'gone.png' })).status).toBe(400);
    // Only what is named changes; null takes it away.
    expect((await post('settings', { folder: 'novel', cover: null })).status).toBe(200);
    expect((await folders())[0]).toMatchObject({ cover: null, referenceDoc: 'house.docx', author: 'Ada Byron' });
    // The template renamed: followed.
    expect((await api('/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'house.docx', to: 'styles.docx' }) })).status).toBe(200);
    await until(async () => (await folders())[0]?.referenceDoc === 'styles.docx', 10_000, 'the template’s rename to be followed');
  });

  it('asks the host to render a folder, which says why it cannot here', async () => {
    const r = await api('/api/renders', { method: 'POST', body: JSON.stringify({ path: 'novel/', format: 'docx', exclude: ['novel/notes.md'], title: 'The Coast', by: ANA }) });
    expect(r.status).toBe(422);
    expect(((await r.json()) as { message: string }).message).toMatch(/Rendering is turned off/);
    expect((await api('/api/renders', { method: 'POST', body: JSON.stringify({ path: 'nowhere/', format: 'docx', by: ANA }) })).status).toBe(404);
    expect((await api(`/api/renders?path=${encodeURIComponent('novel/')}`)).status).toBe(200);
  });

  it('gives what a folder’s book could have: its folders and documents, nothing left out, each at its depth', async () => {
    await post('include', { path: 'novel/notes.md', include: false });
    const contents = async (path: string) => api(`/api/renders/contents?path=${encodeURIComponent(path)}`);
    const r = await contents('novel/');
    expect(r.status).toBe(200);
    expect(((await r.json()) as { items: unknown[] }).items).toEqual([
      { kind: 'folder', path: 'novel/research', title: 'research', depth: 1 },
      { kind: 'document', path: 'novel/research/sources.md', title: 'sources.md', depth: 2, words: 1 },
      { kind: 'document', path: 'novel/arrival.md', title: 'Arrival', depth: 1, words: 2 },
      { kind: 'document', path: 'novel/notes.md', title: 'notes.md', depth: 1, words: 1 },
    ]);
    expect((await contents('novel/arrival.md')).status).toBe(400);
    expect((await contents('nowhere/')).status).toBe(404);
  });
});
