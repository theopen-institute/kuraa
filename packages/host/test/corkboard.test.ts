// The corkboard and the outline (docs/decisions/0095-corkboard-and-outline.md)
// on a host: what a folder's cards show (documents' details, words and targets;
// folders' documents and words, all through them), and a document's header
// fields set through the core, committed, credited to whoever asked.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { corkboardFeature } from '@kuraa/corkboard';
import { startHost, type RunningHost } from '../src/index.js';

const ANA = { name: 'Ana Lima', email: 'ana@example.org', color: '#d33' };
const FAST = { flushMs: 150, idleCommitMs: 500, maxCommitMs: 5000, dropMs: 400 };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

describe('the corkboard', () => {
  let dir: string;
  let running: RunningHost;
  const api = (path: string, init: RequestInit = {}) =>
    fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' } });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-corkboard-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test Host');
    git(dir, 'config', 'user.email', 'host@example.org');
    mkdirSync(join(dir, 'novel/coast'), { recursive: true });
    writeFileSync(join(dir, 'novel/a.md'), '---\ntitle: Arrival\nsynopsis: They come.\nlabel: Chapter\nstatus: First draft\ntarget-words: 2000\n---\n\nWe came by sea.\n');
    writeFileSync(join(dir, 'novel/coast/cliffs.md'), 'High ones here.\n');
    writeFileSync(join(dir, 'novel/coast/beach.md'), 'Sand.\n');
    writeFileSync(join(dir, 'novel/map.png'), 'not a picture');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    running = await startHost({ dir, timings: FAST, features: [corkboardFeature] });
  });

  afterEach(async () => {
    await running.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('gives a folder’s cards: documents with their details, words and targets; folders with theirs, all through them', async () => {
    const r = await api(`/api/features/corkboard/cards?folder=${encodeURIComponent('novel')}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({
      documents: { 'novel/a.md': { synopsis: 'They come.', label: 'Chapter', status: 'First draft', words: 4, target: 2000 } },
      folders: { 'novel/coast': { documents: 2, words: 4 } },
    });
  });

  it('sets a document’s header fields, committed and credited; refuses what is not a document', async () => {
    const set = (path: string, fields: object) => api('/api/documents/header', { method: 'POST', body: JSON.stringify({ path, fields, by: ANA }) });
    expect((await set('novel/a.md', { synopsis: 'They come by night.', status: 'Done' })).status).toBe(200);
    expect(readFileSync(join(dir, 'novel/a.md'), 'utf8')).toBe('---\ntitle: Arrival\nsynopsis: They come by night.\nlabel: Chapter\nstatus: Done\ntarget-words: 2000\n---\n\nWe came by sea.\n');
    expect(git(dir, 'log', '-1', '--format=%s%n%b')).toMatch(/Change synopsis, status of novel\/a\.md[\s\S]*Co-authored-by: Ana Lima/);
    // A header made for a document with none.
    expect((await set('novel/coast/beach.md', { synopsis: 'Sandy.' })).status).toBe(200);
    expect(readFileSync(join(dir, 'novel/coast/beach.md'), 'utf8')).toBe('---\nsynopsis: Sandy.\n---\n\nSand.\n');
    expect((await set('novel/map.png', { synopsis: 'x' })).status).toBe(400);
    expect((await set('novel/gone.md', { synopsis: 'x' })).status).toBe(404);
    expect((await set('novel/a.md', {})).status).toBe(400);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });
});
