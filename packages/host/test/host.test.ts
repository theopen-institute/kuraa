// Host integration tests: real git repos in temp directories, headless clients over WebSocket.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { rmarkdown } from '@kuraa/format-rmarkdown';
import { textSchema } from '@kuraa/format-text';
import { connectHeadless, type HeadlessClient } from '@kuraa/session/testing';
import { gitIdentity, inspectFolder, startHost, type RunningHost } from '../src/index.js';

const NOTES = `---
title: Field notes
---

# Day one

The tide was already on the turn when we arrived.

Mateus recalibrated the *refractometer*   before lunch.

- quadrats every 5 m
- cores at 0 m and 25 m

## Day two

Light rain all morning.
`;

const ALICE = { name: 'Alice Ng', email: 'alice@example.org', color: '#d33' };
const BOB = { name: 'Bob Ferreira', email: 'bob@example.org', color: '#33d' };
const FAST = { flushMs: 150, idleCommitMs: 600, maxCommitMs: 5000, dropMs: 400 };
const schema = pandocMarkdown.schema;

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
/** Git commands that talk to the in-process host must not block its event loop. */
const gitAsync = async (cwd: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd })).stdout.trim();

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-test-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test Host');
  git(dir, 'config', 'user.email', 'host@example.org');
  writeFileSync(join(dir, 'notes.md'), NOTES);
  writeFileSync(join(dir, 'other.md'), '# Other\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  return dir;
}

async function until(cond: () => boolean | Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Insert text at the start of the first textblock whose text includes `anchor`. */
function insertAt(doc: PMNode, anchor: string, text: string): PMNode {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isTextblock && node.textContent.includes(anchor)) pos = p + 1 + node.textContent.indexOf(anchor);
    return pos < 0;
  });
  if (pos < 0) throw new Error(`anchor not found: ${anchor}`);
  return new Transform(doc).insert(pos, schema.text(text)).doc;
}

describe('host', () => {
  let dir: string;
  let running: RunningHost;
  const clients: HeadlessClient[] = [];

  const api = async (path: string, init: RequestInit = {}) => {
    const res = await fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
    return res;
  };
  const roomFor = async (path: string) => (await (await api(`/api/rooms?path=${encodeURIComponent(path)}`)).json()) as { room: string; generation: string };
  const connect = async (path: string, user = ALICE) => {
    const { room } = await roomFor(path);
    const s = /\.rmd$/i.test(path) ? rmarkdown.schema : /\.(md|markdown)$/i.test(path) ? schema : textSchema;
    const c = connectHeadless({ url: running.url.replace(/^http/, 'ws') + '/collab', room, token: running.token, user, schema: s });
    clients.push(c);
    await c.ready;
    return c;
  };
  const file = (name = 'notes.md') => readFileSync(join(dir, name), 'utf8');

  beforeEach(async () => {
    dir = makeRepo();
    running = await startHost({ dir, timings: FAST });
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    await running.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('requires the token on HTTP', async () => {
    expect((await fetch(running.url + '/api/workspace')).status).toBe(401);
    const ws = await (await api('/api/workspace')).json();
    expect(ws.branch).toBe('main');
    expect(ws.types.map((t: { id: string }) => t.id)).toEqual(expect.arrayContaining(['pandoc-markdown', 'rmarkdown', 'text', 'text-r', 'text-bibtex']));
    const tree = await (await api('/api/tree')).json();
    expect(tree.files).toContainEqual({ path: 'notes.md', type: 'pandoc-markdown' });
  });

  it('M2: two clients converge and see each other', async () => {
    const a = await connect('notes.md', ALICE);
    const b = await connect('notes.md', BOB);
    a.write(insertAt(a.read(), 'Light rain', 'A: '));
    b.write(insertAt(b.read(), 'The tide', 'B: '));
    await until(() => a.read().eq(b.read()) && a.read().textContent.includes('A: ') && a.read().textContent.includes('B: '), 5000, 'convergence');
    await until(() => a.peers().length === 2 && b.peers().some((p) => p.name === ALICE.name), 5000, 'presence');
  });

  it('M3: flushes to disk with untouched blocks byte-identical, and survives a restart', async () => {
    const a = await connect('notes.md');
    a.write(insertAt(a.read(), 'Light rain', 'Heavy then '));
    await until(() => file().includes('Heavy then Light rain'), 3000, 'flush');
    const expected = NOTES.replace('Light rain', 'Heavy then Light rain');
    // The odd spacing in the untouched paragraph survives byte for byte.
    expect(file()).toBe(expected);

    // Unflushed edits survive a host restart through the room cache.
    const { generation } = await roomFor('notes.md');
    a.write(insertAt(a.read(), 'The tide', 'Late: '));
    a.destroy();
    clients.splice(0);
    await running.close();
    running = await startHost({ dir, timings: FAST, token: running.token });
    const after = await roomFor('notes.md');
    expect(after.generation).toBe(generation);
    const b = await connect('notes.md', BOB);
    expect(b.read().textContent).toContain('Late: The tide');
    expect(b.read().textContent).toContain('Heavy then Light rain');
  });

  it('M4: commits with co-authors, lists history and shows an earlier version', async () => {
    const a = await connect('notes.md', ALICE);
    const b = await connect('notes.md', BOB);
    a.write(insertAt(a.read(), 'Light rain', 'Alice: '));
    await until(() => b.read().textContent.includes('Alice: '));
    b.write(insertAt(b.read(), 'The tide', 'Bob: '));
    await until(() => git(dir, 'log', '-1', '--format=%B').includes('Co-authored-by: Bob'), 5000, 'commit');
    const body = git(dir, 'log', '-1', '--format=%B');
    expect(body).toContain('Co-authored-by: Alice Ng <alice@example.org>');
    expect(body).toContain('Co-authored-by: Bob Ferreira <bob@example.org>');
    expect(git(dir, 'status', '--porcelain')).toBe('');

    const hist = await (await api('/api/history?path=notes.md')).json();
    expect(hist.commits).toHaveLength(2);
    expect(hist.commits[0].coAuthors.map((c: { name: string }) => c.name).sort()).toEqual(['Alice Ng', 'Bob Ferreira']);
    const old = await (await api(`/api/history/${hist.commits[1].hash}?path=notes.md`)).text();
    expect(old).toBe(NOTES);

    // Named version on request.
    a.write(insertAt(a.read(), 'Light rain', 'v2 '));
    await until(() => a.read().textContent.includes('v2 '));
    const res = await (await api('/api/versions', { method: 'POST', body: JSON.stringify({ path: 'notes.md', message: 'Draft for review' }) })).json();
    expect(res.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Draft for review');
  });

  it('M4: history follows renames and gives the path each version had', async () => {
    await api('/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'notes.md', to: 'field/day-one.md' }) });
    const hist = (await (await api('/api/history?path=field%2Fday-one.md')).json()) as { commits: { hash: string; path: string; subject: string }[] };
    expect(hist.commits.map((c) => [c.subject, c.path])).toEqual([
      ['Rename notes.md to field/day-one.md', 'field/day-one.md'],
      ['Initial', 'notes.md'],
    ]);
    const old = await api(`/api/history/${hist.commits[1]!.hash}?path=${encodeURIComponent(hist.commits[1]!.path)}`);
    expect(old.status).toBe(200);
    expect(await old.text()).toBe(NOTES);
  });

  it('M5: an outside edit elsewhere in the file reaches clients and survives on disk', async () => {
    const a = await connect('notes.md');
    a.write(insertAt(a.read(), 'Light rain', 'Typing: '));
    // Edit a different block on disk before the flush.
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('# Day one', '# Day one (edited in RStudio)'));
    await until(() => a.read().textContent.includes('edited in RStudio'), 5000, 'outside change in room');
    await until(() => file().includes('edited in RStudio') && file().includes('Typing: Light rain'), 5000, 'both on disk');
    expect(a.read().textContent).toContain('Typing: Light rain');
  });

  it('M5: an outside edit with no live edits applies as a minimal difference', async () => {
    const a = await connect('notes.md');
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('Light rain all morning.', 'Light rain all morning, sun after two.'));
    await until(() => a.read().textContent.includes('sun after two'), 5000, 'outside change');
    expect(a.messages.some((m) => m.type === 'outside-change')).toBe(true);
  });

  it('M5: a conflicting outside edit keeps the live version and saves the outside one', async () => {
    const a = await connect('notes.md');
    a.write(insertAt(a.read(), 'Light rain', 'LIVE '));
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('Light rain all morning.', 'OUTSIDE rain all morning.'));
    await until(() => a.messages.some((m) => m.type === 'conflict'), 5000, 'conflict notice');
    const saved = readdirSync(dir).find((f) => f.startsWith('notes.md.outside-'));
    expect(saved).toBeTruthy();
    expect(readFileSync(join(dir, saved!), 'utf8')).toContain('OUTSIDE rain');
    await until(() => file().includes('LIVE Light rain'), 5000, 'live version on disk');
    expect(a.read().textContent).toContain('LIVE Light rain');
  });

  it('M5 + M9: clone over git HTTP with the token; a push reaches the open room; sync merges back', async () => {
    const a = await connect('notes.md');
    const clone = mkdtempSync(join(tmpdir(), 'kuraa-clone-'));
    try {
      const remote = running.url.replace('://', `://kuraa:${running.token}@`) + '/git';
      await gitAsync(tmpdir(), 'clone', '-q', remote, clone);
      expect(readFileSync(join(clone, 'notes.md'), 'utf8')).toBe(NOTES);
      git(clone, 'config', 'user.name', 'Outside');
      git(clone, 'config', 'user.email', 'outside@example.org');
      writeFileSync(join(clone, 'notes.md'), NOTES.replace('# Day two', '# Day two (pushed)'));
      git(clone, 'commit', '-q', '-am', 'Pushed edit');
      await gitAsync(clone, 'push', '-q', 'origin', 'main');
      await until(() => a.read().textContent.includes('Day two (pushed)'), 5000, 'pushed change in room');
      expect(file()).toContain('# Day two (pushed)');

      // Wrong token is refused.
      const bad = running.url.replace('://', '://kuraa:nope@') + '/git';
      await expect(gitAsync(tmpdir(), 'ls-remote', bad)).rejects.toThrow();

      // The host can also sync with an upstream remote: here, the clone as a bare mirror.
      const upstream = mkdtempSync(join(tmpdir(), 'kuraa-upstream-'));
      execFileSync('git', ['clone', '-q', '--bare', dir, upstream]);
      git(dir, 'remote', 'add', 'origin', upstream);
      const work = mkdtempSync(join(tmpdir(), 'kuraa-work-'));
      execFileSync('git', ['clone', '-q', upstream, work]);
      git(work, 'config', 'user.name', 'Upstream');
      git(work, 'config', 'user.email', 'up@example.org');
      writeFileSync(join(work, 'notes.md'), readFileSync(join(work, 'notes.md'), 'utf8').replace('The tide', 'Upstream: the tide'));
      git(work, 'commit', '-q', '-am', 'Upstream edit');
      git(work, 'push', '-q');
      const sync = await (await api('/api/sync', { method: 'POST' })).json();
      expect(sync.ok).toBe(true);
      await until(() => a.read().textContent.includes('Upstream: the tide'), 5000, 'merged change in room');
      rmSync(upstream, { recursive: true, force: true });
      rmSync(work, { recursive: true, force: true });
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('edits a source file line by line, keeping its line endings, and merges outside edits', async () => {
    const script = 'library(dplyr)\r\n\r\nx <- c(1, 2, 3)\r\nmean(x)\r\n';
    writeFileSync(join(dir, 'clean.R'), script);
    writeFileSync(join(dir, 'rebuild'), '#!/usr/bin/env Rscript\nsource("clean.R")\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Scripts');

    const tree = (await (await api('/api/tree')).json()) as { files: { path: string; type: string | null }[] };
    const typeOf = (p: string) => tree.files.find((f) => f.path === p)?.type;
    expect(typeOf('clean.R')).toBe('text-r');
    expect(typeOf('rebuild')).toBe('text-r');

    const c = await connect('clean.R');
    expect(c.read().childCount).toBe(5);
    // Type inside line 3, before its closing parenthesis, as an editor would.
    let pos = 0;
    for (let i = 0; i < 2; i++) pos += c.read().child(i).nodeSize;
    const at = pos + 1 + c.read().child(2).textContent.indexOf(')');
    c.write(new Transform(c.read()).insert(at, textSchema.text(', 4')).doc);
    await until(() => file('clean.R').includes('c(1, 2, 3, 4)'), 5000, 'flush');
    expect(file('clean.R')).toBe('library(dplyr)\r\n\r\nx <- c(1, 2, 3, 4)\r\nmean(x)\r\n');

    // Another program edits a different line.
    writeFileSync(join(dir, 'clean.R'), file('clean.R').replace('mean(x)', 'median(x)'));
    await until(() => c.read().child(3).textContent === 'median(x)', 5000, 'outside edit in the room');
    expect(c.read().child(2).textContent).toBe('x <- c(1, 2, 3, 4)');
    await until(() => git(dir, 'status', '--porcelain', '--', 'clean.R') === '', 5000, 'commit');
    expect(git(dir, 'show', 'HEAD:clean.R')).toBe('library(dplyr)\r\n\r\nx <- c(1, 2, 3, 4)\r\nmedian(x)');
  });

  it('creates, renames and deletes files, committing each change', async () => {
    let res = await api('/api/files', { method: 'POST', body: JSON.stringify({ path: 'drafts/new.Rmd', content: '# New\n\n```{r}\n1 + 1\n```\n' }) });
    expect(res.status).toBe(201);
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Create drafts/new.Rmd');
    const c = await connect('drafts/new.Rmd');
    expect(c.read().child(1).type.name).toBe('code_chunk');
    res = await api('/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'drafts/new.Rmd', to: 'drafts/renamed.Rmd' }) });
    expect(res.status).toBe(200);
    expect(existsSync(join(dir, 'drafts/renamed.Rmd'))).toBe(true);
    res = await api('/api/files?path=drafts%2Frenamed.Rmd', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Delete drafts/renamed.Rmd');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path: '../escape.md' }) })).status).toBe(400);
  });
});

// What shells use instead of running git themselves.
describe('workspace helpers', () => {
  it('inspects a folder, and the host initialises it only when asked', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'kuraa-init-')));
    try {
      writeFileSync(join(dir, 'notes.md'), NOTES);
      expect(await inspectFolder(dir)).toEqual({ dir, repoRoot: null, entries: 1 });
      await expect(startHost({ dir, port: 0 })).rejects.toThrow('Not a git repository');
      expect(existsSync(join(dir, '.git'))).toBe(false);

      const running = await startHost({ dir, port: 0, init: true, timings: FAST });
      try {
        expect(git(dir, 'log', '--format=%s')).toBe('Initialise workspace');
        expect(git(dir, 'ls-files')).toBe('notes.md');
        const res = await fetch(`${running.url}/api/tree`, { headers: { authorization: `Bearer ${running.token}` } });
        expect(res.status).toBe(200);
      } finally {
        await running.close();
      }
      expect((await inspectFolder(dir)).repoRoot).toBe(dir);

      git(dir, 'config', 'user.name', 'Folder Person');
      git(dir, 'config', 'user.email', 'folder@example.org');
      expect(await gitIdentity(dir)).toEqual({ name: 'Folder Person', email: 'folder@example.org' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
