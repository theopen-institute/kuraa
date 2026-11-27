// Host integration tests: real git repos in temp directories, headless clients over WebSocket.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Transform } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { rmarkdown } from '@kuraa/format-rmarkdown';
import { textSchema } from '@kuraa/format-text';
import { connectHeadless, type HeadlessClient } from '@kuraa/session/testing';
import { hashText } from '@kuraa/kernel';
import { gitIdentity, inspectFolder, startHost, type RunningHost } from '../src/index.js';
import syncGit from '@kuraa/sync-git';
/** The online copy is a component (decision 0059): hosts here have it, as every program that starts one gives it. */
const ONLINE = { engines: [], components: [syncGit] };

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

async function until(cond: () => boolean | Promise<boolean>, ms = 15_000, what = 'condition'): Promise<void> {
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
    running = await startHost({ dir, timings: FAST, run: ONLINE });
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
    expect(ws.types.map((t: { id: string }) => t.id)).toEqual(['pandoc-markdown', 'rmarkdown', 'text']);
    const tree = await (await api('/api/tree')).json();
    expect(tree.files).toContainEqual({ path: 'notes.md', type: 'pandoc-markdown', title: 'Field notes' });
  });

  it('a draft (0096): a new document with no file until something is written in it, then made and committed', async () => {
    const draftRoom = (path: string) => api(`/api/rooms?path=${encodeURIComponent(path)}&draft=1`);
    expect((await draftRoom('a<b.md')).status).toBe(400);
    const { room } = (await (await draftRoom('drafts/harbour.md')).json()) as { room: string };
    const c = connectHeadless({ url: running.url.replace(/^http/, 'ws') + '/collab', room, token: running.token, user: ALICE, schema });
    clients.push(c);
    await c.ready;
    expect(c.read().textContent).toBe('');
    // Opened and left untouched: nothing on disk, nothing in the file list.
    await new Promise((r) => setTimeout(r, 600));
    expect(existsSync(join(dir, 'drafts'))).toBe(false);
    expect((await (await api('/api/tree')).json()).files.map((f: { path: string }) => f.path)).not.toContain('drafts/harbour.md');
    // Written in: the file (and its folder) made, then committed.
    c.write(pandocMarkdown.parse('Harbour log\n').doc);
    await until(() => existsSync(join(dir, 'drafts/harbour.md')) && file('drafts/harbour.md').includes('Harbour log'), 15_000, 'the file made');
    await until(() => git(dir, 'log', '--format=%H', '--', 'drafts/harbour.md') !== '', 15_000, 'the file committed');
  });

  it('M2: two clients converge and see each other', async () => {
    const a = await connect('notes.md', ALICE);
    const b = await connect('notes.md', BOB);
    a.write(insertAt(a.read(), 'Light rain', 'A: '));
    b.write(insertAt(b.read(), 'The tide', 'B: '));
    await until(() => a.read().eq(b.read()) && a.read().textContent.includes('A: ') && a.read().textContent.includes('B: '), 15_000, 'convergence');
    await until(() => a.peers().length === 2 && b.peers().some((p) => p.name === ALICE.name), 15_000, 'presence');
  });

  it('M3: flushes to disk with untouched blocks byte-identical, and survives a restart', async () => {
    const a = await connect('notes.md');
    a.write(insertAt(a.read(), 'Light rain', 'Heavy then '));
    await until(() => file().includes('Heavy then Light rain'), 15_000, 'flush');
    const expected = NOTES.replace('Light rain', 'Heavy then Light rain');
    // The odd spacing in the untouched paragraph survives byte for byte.
    expect(file()).toBe(expected);

    // Edits not yet written when the host stops are written as it stops; the next session starts from the file (0077).
    const { generation } = await roomFor('notes.md');
    a.write(insertAt(a.read(), 'The tide', 'Late: '));
    await until(() => (running.host as unknown as { records: Map<string, { dirty: boolean }> }).records.get('main:notes.md')!.dirty, 5000, 'the edit at the host');
    a.destroy();
    clients.splice(0);
    await running.close();
    running = await startHost({ dir, timings: FAST, token: running.token, run: ONLINE });
    const after = await roomFor('notes.md');
    expect(after.generation).not.toBe(generation);
    const b = await connect('notes.md', BOB);
    expect(b.read().textContent).toContain('Late: The tide');
    expect(b.read().textContent).toContain('Heavy then Light rain');
    expect(b.read().textContent.match(/Late: /g)).toHaveLength(1);
  });

  it('keeps a room no one is in open in its session a while, then starts a new session from the file as it is (0077)', async () => {
    await running.close();
    running = await startHost({ dir, timings: { ...FAST, dropMs: 60_000 }, token: running.token, run: ONLINE });
    const a = await connect('notes.md');
    a.write(insertAt(a.read(), 'Light rain', 'Heavy then '));
    await until(() => file().includes('Heavy then') && git(dir, 'status', '--porcelain') === '', 15_000, 'committed');
    const { room } = await roomFor('notes.md');
    a.destroy();
    clients.splice(0);
    // Kept warm: the same session, still open here; a change made outside comes into it, once, by this device (which leads it).
    await new Promise((r) => setTimeout(r, 200));
    expect(running.host.liveRooms()).toHaveLength(1);
    writeFileSync(join(dir, 'notes.md'), file().replace('The tide', 'Outside: The tide'));
    await until(() => (running.host.roomText(room) ?? '').includes('Outside: The tide'), 15_000, 'the outside change in the warm room');
    expect((await roomFor('notes.md')).room).toBe(room);
    const b = await connect('notes.md', BOB);
    expect(b.read().textContent.match(/Outside: /g)).toHaveLength(1);
    expect(b.read().eq(pandocMarkdown.parse(file()).doc)).toBe(true);
    b.destroy();
    clients.splice(0);
    // Dropped (here, at once): the session is over, and the next starts afresh from the file, changed meanwhile.
    await running.close();
    writeFileSync(join(dir, 'notes.md'), file().replace('Light rain', 'Light rain, again'));
    running = await startHost({ dir, timings: { ...FAST, dropMs: 300 }, token: running.token, run: ONLINE });
    const c = await connect('notes.md', BOB);
    const second = (await roomFor('notes.md')).room;
    expect(second).not.toBe(room);
    expect(c.read().textContent.match(/again/g)).toHaveLength(1);
    expect(c.read().eq(pandocMarkdown.parse(file()).doc)).toBe(true);
    c.destroy();
    clients.splice(0);
    await until(() => !running.host.liveRooms().length, 5000, 'the session left');
    await until(async () => (await roomFor('notes.md')).room !== second, 5000, 'a new session next time');
  });

  it('takes an outside change whatever its short hash: two texts with the same FNV hash and length are told apart', async () => {
    // Two words of one length that leave FNV-1a (hashText, 32 bit) in the same state: found by trying.
    const seen = new Map<string, string>();
    let pair: [string, string] | null = null;
    for (let i = 0; !pair; i++) {
      const w = i.toString(36).padStart(5, '0');
      const h = hashText(NOTES.replace('Light rain', `Light ${w}`));
      const had = seen.get(h);
      if (had) pair = [had, w];
      else seen.set(h, w);
    }
    const [one, two] = pair;
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('Light rain', `Light ${one}`));
    git(dir, 'commit', '-q', '-am', 'One');
    const a = await connect('notes.md');
    expect(a.read().textContent).toContain(`Light ${one}`);
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('Light rain', `Light ${two}`));
    await until(() => a.read().textContent.includes(`Light ${two}`), 15_000, 'the outside change in the room');
  });

  it('M4: commits with co-authors, lists history and shows an earlier version', async () => {
    const a = await connect('notes.md', ALICE);
    const b = await connect('notes.md', BOB);
    a.write(insertAt(a.read(), 'Light rain', 'Alice: '));
    await until(() => b.read().textContent.includes('Alice: '));
    b.write(insertAt(b.read(), 'The tide', 'Bob: '));
    await until(() => git(dir, 'log', '-1', '--format=%B').includes('Co-authored-by: Bob'), 15_000, 'commit');
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
    await until(() => a.read().textContent.includes('edited in RStudio'), 15_000, 'outside change in room');
    await until(() => file().includes('edited in RStudio') && file().includes('Typing: Light rain'), 15_000, 'both on disk');
    expect(a.read().textContent).toContain('Typing: Light rain');
  });

  it('M5: an outside edit with no live edits applies as a minimal difference', async () => {
    const a = await connect('notes.md');
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('Light rain all morning.', 'Light rain all morning, sun after two.'));
    await until(() => a.read().textContent.includes('sun after two'), 15_000, 'outside change');
    expect(a.messages.some((m) => m.type === 'outside-change')).toBe(true);
  });

  it('M5: a conflicting outside edit keeps the live version and saves the outside one', async () => {
    const a = await connect('notes.md');
    a.write(insertAt(a.read(), 'Light rain', 'LIVE '));
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('Light rain all morning.', 'OUTSIDE rain all morning.'));
    await until(() => a.messages.some((m) => m.type === 'conflict'), 15_000, 'conflict notice');
    const saved = readdirSync(dir).find((f) => f.startsWith('notes.md.outside-'));
    expect(saved).toBeTruthy();
    expect(readFileSync(join(dir, saved!), 'utf8')).toContain('OUTSIDE rain');
    await until(() => file().includes('LIVE Light rain'), 15_000, 'live version on disk');
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
      await until(() => a.read().textContent.includes('Day two (pushed)'), 15_000, 'pushed change in room');
      expect(file()).toContain('# Day two (pushed)');

      // Wrong token is refused.
      const bad = running.url.replace('://', '://kuraa:nope@') + '/git';
      await expect(gitAsync(tmpdir(), 'ls-remote', bad)).rejects.toThrow();

      // The host can also sync with an online copy: here, the clone as a bare mirror, an existing remote named as one.
      const syncRemote = mkdtempSync(join(tmpdir(), 'kuraa-remote-'));
      execFileSync('git', ['clone', '-q', '--bare', dir, syncRemote]);
      git(dir, 'remote', 'add', 'origin', syncRemote);
      git(dir, 'config', '--add', 'kuraa.online', 'origin');
      const work = mkdtempSync(join(tmpdir(), 'kuraa-work-'));
      execFileSync('git', ['clone', '-q', syncRemote, work]);
      git(work, 'config', 'user.name', 'Elsewhere');
      git(work, 'config', 'user.email', 'up@example.org');
      writeFileSync(join(work, 'notes.md'), readFileSync(join(work, 'notes.md'), 'utf8').replace('The tide', 'From the remote: the tide'));
      git(work, 'commit', '-q', '-am', 'Edit elsewhere');
      git(work, 'push', '-q');
      const sync = await (await api('/api/sync', { method: 'POST' })).json();
      expect(sync.ok).toBe(true);
      await until(() => a.read().textContent.includes('From the remote: the tide'), 15_000, 'merged change in room');
      rmSync(syncRemote, { recursive: true, force: true });
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
    expect(typeOf('clean.R')).toBe('text');
    expect(typeOf('rebuild')).toBe('text');

    const c = await connect('clean.R');
    expect(c.read().childCount).toBe(5);
    // Type inside line 3, before its closing parenthesis, as an editor would.
    let pos = 0;
    for (let i = 0; i < 2; i++) pos += c.read().child(i).nodeSize;
    const at = pos + 1 + c.read().child(2).textContent.indexOf(')');
    c.write(new Transform(c.read()).insert(at, textSchema.text(', 4')).doc);
    await until(() => file('clean.R').includes('c(1, 2, 3, 4)'), 15_000, 'flush');
    expect(file('clean.R')).toBe('library(dplyr)\r\n\r\nx <- c(1, 2, 3, 4)\r\nmean(x)\r\n');

    // Another program edits a different line.
    writeFileSync(join(dir, 'clean.R'), file('clean.R').replace('mean(x)', 'median(x)'));
    await until(() => c.read().child(3).textContent === 'median(x)', 15_000, 'outside edit in the room');
    expect(c.read().child(2).textContent).toBe('x <- c(1, 2, 3, 4)');
    await until(() => git(dir, 'status', '--porcelain', '--', 'clean.R') === '', 15_000, 'commit');
    expect(git(dir, 'show', 'HEAD:clean.R')).toBe('library(dplyr)\r\n\r\nx <- c(1, 2, 3, 4)\r\nmedian(x)');
  });

  it('lists documents by title, and gives them new ones, live in open rooms', async () => {
    writeFileSync(join(dir, 'clean.R'), 'x <- 1\n');
    const tree = async () => ((await (await api('/api/tree')).json()) as { files: { path: string; title?: string | null }[] }).files;
    const titleOf = async (p: string) => (await tree()).find((f) => f.path === p)?.title;
    expect(await titleOf('notes.md')).toBe('Field notes');
    expect(await titleOf('other.md')).toBe(null);
    expect((await tree()).find((f) => f.path === 'clean.R')).not.toHaveProperty('title');

    // A new title for an open document: everyone editing it sees it, and it is committed.
    const c = await connect('notes.md');
    const patch = (body: object) => api('/api/files', { method: 'PATCH', body: JSON.stringify(body) });
    expect((await patch({ from: 'notes.md', to: 'notes.md', title: 'Harbour notes: day one' })).status).toBe(200);
    await until(() => c.read().firstChild!.textContent === 'title: "Harbour notes: day one"', 15_000, 'title in the room');
    expect(file()).toMatch(/^---\ntitle: "Harbour notes: day one"\n---\n\n# Day one/);
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Retitle notes.md: Harbour notes: day one');
    expect(await titleOf('notes.md')).toBe('Harbour notes: day one');
    // The open room's title is the live one.
    c.write(insertAt(c.read(), 'Harbour notes', 'Big '));
    await until(async () => (await titleOf('notes.md')) === 'Big Harbour notes: day one', 15_000, 'live title');

    // Renamed and titled at once: one commit.
    expect((await patch({ from: 'other.md', to: 'other-things.md', title: 'Other things' })).status).toBe(200);
    expect(file('other-things.md')).toBe('---\ntitle: Other things\n---\n\n# Other\n');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Rename other.md to other-things.md');
    expect(git(dir, 'status', '--porcelain', '--', 'other.md', 'other-things.md')).toBe('');

    // No empty titles, and no titles for files that are not documents.
    expect((await patch({ from: 'other-things.md', to: 'other-things.md', title: '  ' })).status).toBe(400);
    expect((await patch({ from: 'clean.R', to: 'clean.R', title: 'A script' })).status).toBe(400);
    expect((await patch({ from: 'other-things.md', to: 'other-things.txt', title: 'Text' })).status).toBe(400);
    expect(existsSync(join(dir, 'other-things.md'))).toBe(true);
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

  it('renames a folder or a file in case alone, and git keeps the new case', async () => {
    expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path: 'drama/play.md', content: '# Play\n' }) })).status).toBe(201);
    let res = await api('/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'drama', to: 'Drama' }) });
    expect(res.status).toBe(200);
    expect(readdirSync(dir)).toContain('Drama');
    expect(readdirSync(dir)).not.toContain('drama');
    res = await api('/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'Drama/play.md', to: 'Drama/Play.md' }) });
    expect(res.status).toBe(200);
    expect(readdirSync(join(dir, 'Drama'))).toEqual(['Play.md']);
    expect(git(dir, 'ls-files', 'Drama')).toBe('Drama/Play.md');
    expect(git(dir, 'ls-tree', '-r', '--name-only', 'HEAD')).not.toMatch(/drama\//);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    // Another file of that name is still a clash.
    expect((await api('/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'notes.md', to: 'other.md' }) })).status).toBe(409);
  });

  it('closes a file’s room when it is renamed, here or on another device, and never writes the old path again', async () => {
    const gone = (c: HeadlessClient) => c.messages.find((m) => m.type === 'gone') as { to: string | null } | undefined;
    // Here: whoever has it open is told where it went.
    const a = await connect('notes.md');
    expect((await api('/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'notes.md', to: 'field-notes.md' }) })).status).toBe(200);
    await until(() => !!gone(a), 5000, 'told of the rename');
    expect(gone(a)!.to).toBe('field-notes.md');

    // On another device: its commit comes in while the file is open here.
    const b = await connect('other.md');
    const clone = mkdtempSync(join(tmpdir(), 'kuraa-clone-'));
    try {
      await gitAsync(tmpdir(), 'clone', '-q', running.url.replace('://', `://kuraa:${running.token}@`) + '/git', clone);
      git(clone, 'config', 'user.name', 'Elsewhere');
      git(clone, 'config', 'user.email', 'elsewhere@example.org');
      git(clone, 'mv', 'other.md', 'moved.md');
      git(clone, 'commit', '-q', '-m', 'Rename other.md to moved.md');
      await gitAsync(clone, 'push', '-q', 'origin', 'main');
      await until(() => !!gone(b), 15_000, 'told of the rename from elsewhere');
      expect(gone(b)!.to).toBe('moved.md');
      // An edit still on its way from the old room writes nothing back.
      b.write(insertAt(b.read(), 'Other', 'Late: '));
      await new Promise((r) => setTimeout(r, FAST.flushMs + FAST.idleCommitMs + 400));
      expect(existsSync(join(dir, 'other.md'))).toBe(false);
      expect(file('moved.md')).toBe('# Other\n');
      expect(git(dir, 'log', '--format=%s')).not.toMatch(/Create other\.md/);
    } finally {
      rmSync(clone, { recursive: true, force: true });
    }
  });

  it('refuses .git however it is written, and new names Windows could not hold', async () => {
    for (const path of ['.GIT/config', '.git./config', '.Git']) {
      expect((await api(`/api/files?path=${encodeURIComponent(path)}`)).status).toBe(400);
    }
    for (const path of ['nul.txt', 'notes/aux', 'what?.txt', 'a:b.txt', 'trailing.', 'folder /x.txt']) {
      const res = await api('/api/files', { method: 'POST', body: JSON.stringify({ path, content: '' }) });
      expect(res.status, path).toBe(400);
    }
    expect((await api('/api/folders', { method: 'POST', body: JSON.stringify({ path: 'con' }) })).status).toBe(400);
    expect(git(dir, 'status', '--porcelain')).toBe('');
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
        // Made a workspace, it is named, by its folder's name (0061).
        expect(git(dir, 'ls-files')).toBe('.kuraa/workspace.json\nnotes.md');
        const res = await fetch(`${running.url}/api/tree`, { headers: { authorization: `Bearer ${running.token}` } });
        expect(res.status).toBe(200);
        const info = await (await fetch(`${running.url}/api/workspace`, { headers: { authorization: `Bearer ${running.token}` } })).json();
        expect(info).toMatchObject({ name: basename(dir), named: true });
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

describe('this computer’s person’s key, through the host', () => {
  it('is managed from the app only where the one running the host allows it', async () => {
    const was = process.env.KURAA_PERSON;
    process.env.KURAA_PERSON = join(mkdtempSync(join(tmpdir(), 'kuraa-person-')), 'person.json');
    const dir = mkdtempSync(join(tmpdir(), 'kuraa-person-ws-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
    const shared = await startHost({ dir, init: true });
    const own = await startHost({ dir: mkdtempSync(join(tmpdir(), 'kuraa-person-own-')), init: true, managePerson: true });
    try {
      const call = (h: RunningHost, path: string, init: RequestInit = {}) => fetch(h.url + path, { ...init, headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' } });
      // A shared host: its key is its operator's.
      expect((await call(shared, '/api/person')).status).toBe(404);
      expect((await call(shared, '/api/person', { method: 'POST', body: JSON.stringify({ name: 'Mallory' }) })).status).toBe(404);
      // One's own: this computer's signing key, and no identity yet; then one made, shown, and exported as one line.
      const before = ((await (await call(own, '/api/person')).json()) as { person: { signing: string; identity: unknown } }).person;
      expect(before).toMatchObject({ identity: null, keys: [{ key: before.signing, thisComputer: true }] });
      expect((await call(own, '/api/person', { method: 'POST', body: JSON.stringify({ name: 'Ada Lovelace' }) })).status).toBe(201);
      const { person } = (await (await call(own, '/api/person')).json()) as { person: { signing: string; identity: { name: string } } };
      expect(person.identity.name).toBe('Ada Lovelace');
      expect(person.signing).toBe(before.signing);
      // This computer's own key is not one to revoke here.
      expect((await call(own, '/api/person/revoke', { method: 'POST', body: JSON.stringify({ key: before.signing }) })).status).toBe(400);
      expect(((await (await call(own, '/api/person/export')).json()) as { line: string }).line).toMatch(/^kuraa-id:/);
      // Not made twice: the first would be lost.
      expect((await call(own, '/api/person', { method: 'POST', body: JSON.stringify({ name: 'Ada again' }) })).status).toBe(400);
    } finally {
      await shared.close();
      await own.close();
      if (was === undefined) delete process.env.KURAA_PERSON;
      else process.env.KURAA_PERSON = was;
    }
  });
});

describe('the online copy: a git server each save is pushed to, and work is fetched and merged from', () => {
  it('says how many saves it lacks, and gets the last ones as the host stops', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'kuraa-online-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
    const dir = mkdtempSync(join(tmpdir(), 'kuraa-copied-'));
    // Pushes wait a minute after a save: none goes before the host stops, unless stopping sends it.
    const own = await startHost({ dir, init: true, manageOnline: true, run: ONLINE, timings: { flushMs: 100, idleCommitMs: 60_000, maxCommitMs: 60_000, dropMs: 60_000, onlineMs: 60_000 } });
    let closed = false;
    try {
      const call = (path: string, init: RequestInit = {}) => fetch(own.url + path, { ...init, headers: { authorization: `Bearer ${own.token}`, 'content-type': 'application/json' } });
      const list = async () => ((await (await call('/api/syncs')).json()) as { syncs: { id: string; targets: { lastSync: string | null; pending: number | null }[] }[] }).syncs.find((s) => s.id === 'online')!.targets;
      const branch = execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).trim();
      const there = () => execFileSync('git', ['log', '--format=%s', branch], { cwd: bare, encoding: 'utf8' }).trim();
      expect((await call('/api/syncs/online', { method: 'POST', body: JSON.stringify({ target: bare }) })).status).toBe(201);
      await until(async () => (await list())[0]?.lastSync !== null, 10_000, 'the first push');
      expect((await list())[0]!.pending).toBe(0);
      expect((await call('/api/files', { method: 'POST', body: JSON.stringify({ path: 'notes.md', content: '# Notes\n' }) })).status).toBe(201);
      expect((await list())[0]!.pending).toBe(1);
      // An edit written but not yet committed: committed as the host stops, then pushed with the rest.
      const { room } = (await (await call('/api/rooms?path=notes.md')).json()) as { room: string };
      const c = connectHeadless({ url: own.url.replace(/^http/, 'ws') + '/collab', room, token: own.token, user: ALICE, schema });
      await c.ready;
      c.write(insertAt(c.read(), 'Notes', 'Last '));
      await until(() => readFileSync(join(dir, 'notes.md'), 'utf8').includes('Last Notes'), 5000, 'the edit written');
      c.destroy();
      await own.close();
      closed = true;
      expect(there()).toMatch(/^Edit notes\.md[^\n]*\nCreate notes\.md/);
    } finally {
      if (!closed) await own.close();
    }
  });

  it('push each save, and when another device pushed first, fetch, merge and push, never forcing', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'kuraa-online-'));
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main'], { cwd: bare });
    const dir = mkdtempSync(join(tmpdir(), 'kuraa-copied-'));
    const own = await startHost({ dir, init: true, manageOnline: true, run: ONLINE, timings: { flushMs: 100, idleCommitMs: 300, maxCommitMs: 3000, dropMs: 300, onlineMs: 200 } });
    const shared = await startHost({ dir: mkdtempSync(join(tmpdir(), 'kuraa-shared-')), init: true, run: ONLINE });
    try {
      const call = (h: RunningHost, path: string, init: RequestInit = {}) => fetch(h.url + path, { ...init, headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' } });
      const list = async () => ((await (await call(own, '/api/syncs')).json()) as { syncs: { id: string; targets: { name: string; url: string; lastSync: string | null; error: string | null }[] }[] }).syncs.find((s) => s.id === 'online')!.targets;
      const branch = execFileSync('git', ['branch', '--show-current'], { cwd: dir, encoding: 'utf8' }).trim();
      const there = () => execFileSync('git', ['log', '--format=%s', branch], { cwd: bare, encoding: 'utf8' }).trim();
      const here = () => execFileSync('git', ['log', '--format=%s'], { cwd: dir, encoding: 'utf8' });

      // Added by its address: synced with at once.
      expect((await call(own, '/api/syncs/online', { method: 'POST', body: JSON.stringify({ target: bare }) })).status).toBe(201);
      await until(async () => (await list())[0]?.lastSync !== null, 10_000, 'the first push');
      expect(there()).toBe('Initialise workspace');
      // Each save follows, a moment later.
      expect((await call(own, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'notes.md', content: '# Notes\n' }) })).status).toBe(201);
      await until(() => there().startsWith('Create notes.md'), 10_000, 'the save pushed');

      // Another device pushed first: the next push is refused, so this one fetches, merges and pushes. Nothing is forced.
      const elsewhere = mkdtempSync(join(tmpdir(), 'kuraa-elsewhere-'));
      execFileSync('git', ['clone', '-q', '-b', branch, bare, elsewhere]);
      const commitThere = (path: string, message: string) => {
        execFileSync('git', ['pull', '-q', '--ff-only', 'origin', branch], { cwd: elsewhere });
        writeFileSync(join(elsewhere, path), `${message}\n`);
        execFileSync('git', ['add', '-A'], { cwd: elsewhere });
        execFileSync('git', ['-c', 'user.name=Bo', '-c', 'user.email=bo@example.org', 'commit', '-q', '-m', message], { cwd: elsewhere });
        execFileSync('git', ['push', '-q', 'origin', `HEAD:${branch}`], { cwd: elsewhere });
      };
      commitThere('bo.md', 'From another device');
      const theirs = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: elsewhere, encoding: 'utf8' }).trim();
      expect((await call(own, '/api/files', { method: 'POST', body: JSON.stringify({ path: 'more.md', content: '# More\n' }) })).status).toBe(201);
      await until(() => there().includes('Create more.md') && existsSync(join(dir, 'bo.md')), 15_000, 'merged both ways');
      expect(here()).toContain('From another device');
      execFileSync('git', ['merge-base', '--is-ancestor', theirs, branch], { cwd: bare });
      expect((await list())[0]!.error).toBeNull();

      // Sync fetches and merges too, with no save here.
      commitThere('bo2.md', 'More from another device');
      const sync = (await (await call(own, '/api/sync', { method: 'POST' })).json()) as { ok: boolean; message: string };
      expect(sync.ok).toBe(true);
      expect(sync.message).toMatch(/^Synced with online-/);
      expect(existsSync(join(dir, 'bo2.md'))).toBe(true);

      // A shared host: everyone sees the online copy (Sync uses it); adding and removing are its operator's.
      expect((await call(shared, '/api/syncs')).status).toBe(200);
      expect((await call(shared, '/api/syncs/online', { method: 'POST', body: JSON.stringify({ target: bare }) })).status).toBe(403);

      // Removed: the remote made for it goes; the repository there stays as it is.
      const { name } = (await list())[0]!;
      expect((await call(own, `/api/syncs/online/${name}`, { method: 'DELETE' })).status).toBe(200);
      expect(await list()).toEqual([]);
      expect(execFileSync('git', ['remote'], { cwd: dir, encoding: 'utf8' }).trim()).toBe('');
      expect(there()).toContain('From another device');
    } finally {
      await own.close();
      await shared.close();
    }
  });

  it('show addresses without the passwords in them, and name copies after them', async () => {
    const { shownUrl, copyName } = await import('@kuraa/sync-git');
    expect(shownUrl('https://ada:s3cret@github.com/ada/notes.git')).toBe('https://github.com/ada/notes.git');
    expect(shownUrl('git@github.com:ada/notes.git')).toBe('git@github.com:ada/notes.git');
    expect(copyName('git@github.com:ada/notes.git')).toBe('online-ada-notes');
    expect(copyName('https://gitlab.com/team/field-notes')).toBe('online-team-field-notes');
  });
});
