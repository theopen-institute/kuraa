// The host keeps the files safe (docs/decisions/0037-host-safety.md): it never
// follows links, never writes over an edit made outside the app, never writes one
// branch's room onto another branch or into the middle of a git operation, never
// changes the characters of a file that is not UTF-8, and keeps trying when a save
// fails.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { connectHeadless, type HeadlessClient } from '@kuraa/session/testing';
import { lastResort, startHost, startHub, type RunningHost, type HostTimings } from '../src/index.js';
import syncGit from '@kuraa/sync-git';

const NOTES = `---
title: Field notes
---

# Day one

The tide was already on the turn when we arrived.

## Day two

Light rain all morning.
`;

const ALICE = { name: 'Alice Ng', email: 'alice@example.org', color: '#d33' };
const FAST: Partial<HostTimings> = { flushMs: 150, idleCommitMs: 600, maxCommitMs: 5000, dropMs: 400, gitPollMs: 100 };
const schema = pandocMarkdown.schema;

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' }).trim();
/** Git commands that talk to the in-process host must not block its event loop. */
const gitAsync = async (cwd: string, ...args: string[]) => (await promisify(execFile)('git', args, { cwd })).stdout.trim();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-safety-'));
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
    await sleep(25);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

function insertAt(doc: PMNode, anchor: string, text: string): PMNode {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isTextblock && node.textContent.includes(anchor)) pos = p + 1 + node.textContent.indexOf(anchor);
    return pos < 0;
  });
  if (pos < 0) throw new Error(`anchor not found: ${anchor}`);
  return new Transform(doc).insert(pos, schema.text(text)).doc;
}

describe('host safety', () => {
  let dir: string;
  let outside: string;
  let running: RunningHost;
  const clients: HeadlessClient[] = [];
  const dirs: string[] = [];

  const api = (path: string, init: RequestInit = {}) =>
    fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const connect = async (path: string) => {
    const res = await api(`/api/rooms?path=${encodeURIComponent(path)}`);
    if (res.status !== 200) throw new Error(`room ${path}: ${res.status}`);
    const { room } = (await res.json()) as { room: string };
    const c = connectHeadless({ url: running.url.replace(/^http/, 'ws') + '/collab', room, token: running.token, user: ALICE, schema });
    clients.push(c);
    await c.ready;
    return c;
  };
  const file = (name = 'notes.md') => readFileSync(join(dir, name), 'utf8');
  /** The host's record of a room (private): to save it now, or to see that an edit reached it. */
  const record = (path = 'notes.md') => (running.host as unknown as { records: Map<string, Parameters<RunningHost['host']['commitRoom']>[0]> }).records.get(`main:${path}`)!;
  const start = async (timings: Partial<HostTimings> = FAST) => {
    // With the online copy, a component (decision 0059), as every program that starts a host gives it.
    running = await startHost({ dir, timings, run: { engines: [], components: [syncGit] } });
  };

  beforeEach(async () => {
    dir = makeRepo();
    outside = mkdtempSync(join(tmpdir(), 'kuraa-outside-'));
    writeFileSync(join(outside, 'secret.md'), '# Secret\n');
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    await running?.close().catch(() => undefined);
    for (const d of [dir, outside, ...dirs.splice(0)]) rmSync(d, { recursive: true, force: true });
  });

  it('never follows a link to a file: not read, opened or written, listed as one, and deleted itself', async () => {
    symlinkSync(join(outside, 'secret.md'), join(dir, 'secret.md'));
    await start();
    expect((await api('/api/files?path=secret.md')).status).toBe(403);
    expect((await api('/api/rooms?path=secret.md')).status).toBe(403);
    expect((await api('/api/files', { method: 'PATCH', body: JSON.stringify({ from: 'secret.md', to: 'secret.md', title: 'Mine' }) })).status).toBe(403);
    const tree = (await (await api('/api/tree')).json()) as { files: { path: string; type: string | null; cannotOpen?: string }[] };
    const entry = tree.files.find((f) => f.path === 'secret.md')!;
    expect(entry.type).toBeNull();
    expect(entry.cannotOpen).toMatch(/link/);
    // Deleting it takes the link away, not what it points to.
    expect((await api('/api/files?path=secret.md', { method: 'DELETE' })).status).toBe(200);
    expect(existsSync(join(dir, 'secret.md'))).toBe(false);
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('# Secret\n');
  });

  it('never follows a link to a folder', async () => {
    symlinkSync(outside, join(dir, 'elsewhere'));
    await start();
    expect((await api('/api/files?path=elsewhere/secret.md')).status).toBe(403);
    expect((await api('/api/rooms?path=elsewhere/secret.md')).status).toBe(403);
    expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path: 'elsewhere/new.md', content: 'x' }) })).status).toBe(403);
    expect((await api('/api/folders', { method: 'POST', body: JSON.stringify({ path: 'elsewhere/sub' }) })).status).toBe(403);
    expect(readdirSync(outside)).toEqual(['secret.md']);
  });

  it('never follows a link pushed over git, even in place of a file open in a room', async () => {
    await start();
    const a = await connect('notes.md');
    const clone = mkdtempSync(join(tmpdir(), 'kuraa-clone-'));
    dirs.push(clone);
    const url = running.url.replace('http://', `http://kuraa:${running.token}@`) + '/git';
    await gitAsync(tmpdir(), 'clone', '-q', url, clone);
    git(clone, 'config', 'user.name', 'Pusher');
    git(clone, 'config', 'user.email', 'pusher@example.org');
    rmSync(join(clone, 'notes.md'));
    symlinkSync(join(outside, 'secret.md'), join(clone, 'notes.md'));
    symlinkSync(join(outside, 'secret.md'), join(clone, 'evil.md'));
    git(clone, 'add', '-A');
    git(clone, 'commit', '-q', '-m', 'Links');
    await gitAsync(clone, 'push', '-q', 'origin', 'HEAD:main');
    expect((await api('/api/files?path=evil.md')).status).toBe(403);
    expect((await api('/api/rooms?path=evil.md')).status).toBe(403);
    // Edits to the open room are not written through the link.
    a.write(insertAt(a.read(), 'Light rain', 'Pushed over: '));
    await until(() => a.messages.some((m) => m.type === 'save-status' && m.state === 'failing'), 15_000, 'a save failure said');
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('# Secret\n');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Links');
  });

  it('saving a room with nothing changed since it was committed runs no git; anything changed is still committed', async () => {
    // Changed before the host started: not the committed version, so it is committed like any change.
    writeFileSync(join(dir, 'other.md'), '# Other\n\nChanged before.\n');
    await start({ ...FAST, idleCommitMs: 600_000, maxCommitMs: 600_000 });
    const host = running.host as unknown as { git: { run: (args: string[], o?: object) => Promise<unknown> } };
    const ran: string[] = [];
    const run = host.git.run.bind(host.git);
    host.git.run = (args, o) => {
      ran.push(args[0]!);
      return run(args, o);
    };
    const a = await connect('notes.md');
    await until(() => record().committedHash !== null, 15_000, 'the file known to be committed');
    ran.length = 0;
    expect(await running.host.commitRoom(record())).toBeNull();
    expect(ran).toEqual([]);

    // An outside change: committed.
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('The tide', 'Outside: The tide'));
    await until(() => a.read().textContent.includes('Outside: The tide'), 15_000, 'the outside change in the room');
    expect(await running.host.commitRoom(record())).not.toBeNull();
    expect(git(dir, 'show', 'HEAD:notes.md')).toContain('Outside: The tide');
    ran.length = 0;
    expect(await running.host.commitRoom(record())).toBeNull();
    expect(ran).toEqual([]);

    // An edit: committed.
    a.write(insertAt(a.read(), 'Light rain', 'Live: '));
    await until(() => record().dirty, 15_000, 'the edit at the host');
    expect(await running.host.commitRoom(record())).not.toBeNull();
    expect(git(dir, 'show', 'HEAD:notes.md')).toContain('Live: Light rain');

    await connect('other.md');
    expect(await running.host.commitRoom(record('other.md'))).not.toBeNull();
    expect(git(dir, 'show', 'HEAD:other.md')).toContain('Changed before.');
  });

  it('keeps rooms nobody is in warm for a while, at most so many, and closes one asked for ahead that nobody joined', async () => {
    for (let i = 0; i < 30; i++) writeFileSync(join(dir, `f${i}.md`), `# File ${i}\n`);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'More files');
    const records = () => (running.host as unknown as { records: Map<string, unknown> }).records;
    // Asked for ahead (the pointer rested on the file), never joined: closed after dropMs.
    await start({ ...FAST, dropMs: 300 });
    expect((await api('/api/rooms?path=f0.md')).status).toBe(200);
    expect(records().has('main:f0.md')).toBe(true);
    await until(() => !records().has('main:f0.md'), 15_000, 'the room asked for ahead closed');
    await running.close();
    // Kept warm long after (dropMs), but no more than 24 with nobody in them: the ones used longest ago close.
    await start({ ...FAST, dropMs: 600_000 });
    for (let i = 0; i < 30; i++) expect((await api(`/api/rooms?path=f${i}.md`)).status).toBe(200);
    await until(() => records().size === 24, 15_000, 'the idle rooms past 24 closed');
    expect(records().has('main:f29.md')).toBe(true);
    expect(records().has('main:f0.md')).toBe(false);
  });

  it('opens a room without waiting behind the host’s other work, unless an outside change must be merged into it', async () => {
    await start({ ...FAST, dropMs: 600_000 });
    const host = running.host as unknown as { serial<T>(f: () => Promise<T>): Promise<T> };
    const busy = (ms: number) => void host.serial(() => sleep(ms));
    const timed = async (path: string) => {
      const t = Date.now();
      const res = await api(`/api/rooms?path=${encodeURIComponent(path)}`);
      expect(res.status).toBe(200);
      return Date.now() - t;
    };
    // A new room, and one kept warm, while the queue is busy for 3s.
    busy(3000);
    expect(await timed('notes.md')).toBeLessThan(1500);
    expect(await timed('notes.md')).toBeLessThan(1500);
    // Errors are said as before.
    expect((await api('/api/rooms?path=missing.md')).status).toBe(404);
    // Its edits reach the file as ever.
    const a = await connect('notes.md');
    a.write(insertAt(a.read(), 'Light rain', 'Apart: '));
    await until(() => file().includes('Apart: Light rain'), 15_000, 'the edit written');

    // A room kept from before, whose file changed while the host was away: merged in the queue, then given.
    await connect('other.md');
    for (const c of clients.splice(0)) c.destroy();
    await running.close();
    writeFileSync(join(dir, 'other.md'), '# Other\n\nChanged while away.\n');
    await start({ ...FAST, dropMs: 600_000 });
    const b = await connect('other.md');
    expect(b.read().textContent).toContain('Changed while away.');
  });

  it('merges an outside save it was not told of before writing over it', async () => {
    await start({ ...FAST, flushMs: 600_000, idleCommitMs: 600_000 });
    const a = await connect('notes.md');
    // The watcher misses the outside save.
    (running.host as unknown as { watcher: { close(): void } }).watcher.close();
    a.write(insertAt(a.read(), 'Light rain', 'Live: '));
    await until(() => record().dirty, 15_000, 'the edit at the host');
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('The tide', 'Outside: The tide'));
    await running.host.commitRoom(record());
    expect(file()).toContain('Outside: The tide');
    expect(file()).toContain('Live: Light rain');
    await until(() => a.read().textContent.includes('Outside: The tide'), 15_000, 'the outside save in the room');
  });

  it('a room follows a branch switched outside the app; its edits are committed onto its own branch', async () => {
    git(dir, 'checkout', '-q', '-b', 'feature');
    writeFileSync(join(dir, 'notes.md'), NOTES.replace('Day two', 'Day two on feature'));
    git(dir, 'commit', '-q', '-am', 'Feature');
    git(dir, 'checkout', '-q', 'main');
    // Nothing is written or committed by itself in this test: the edit waits in the room.
    await start({ ...FAST, flushMs: 600_000, idleCommitMs: 600_000 });
    const a = await connect('notes.md');
    a.write(insertAt(a.read(), 'Light rain', 'On main: '));
    await until(() => a.read().textContent.includes('On main: '));
    await gitAsync(dir, 'checkout', '-q', 'feature');
    await until(() => a.messages.some((m) => m.type === 'reseeded'), 15_000, 'the room moves');
    const moved = a.messages.find((m) => m.type === 'reseeded') as { why?: string };
    expect(moved.why).toMatch(/feature/);
    // The edit went onto main, by its ref; the working tree is feature's, untouched.
    expect(git(dir, 'show', 'main:notes.md')).toContain('On main: Light rain');
    expect(git(dir, 'log', '-1', '--format=%s', 'main')).toMatch(/^Edit Field notes/);
    expect(file()).toBe(NOTES.replace('Day two', 'Day two on feature'));
    expect(git(dir, 'status', '--porcelain')).toBe('');
    // The room for feature has feature's text.
    const b = await connect('notes.md');
    expect(b.read().textContent).toContain('Day two on feature');
    expect(b.read().textContent).not.toContain('On main: ');
    // Edits still made in main's room go to main, never into feature's file.
    a.write(insertAt(a.read(), 'The tide', 'Late on main: '));
    await sleep(300);
    await running.host.commitAll();
    expect(file()).not.toContain('Late on main');
    expect(git(dir, 'show', 'main:notes.md')).toContain('Late on main: The tide');
  });

  it('pauses saving while a rebase is under way outside the app, and saves when it is done', async () => {
    git(dir, 'checkout', '-q', '-b', 'other');
    writeFileSync(join(dir, 'other.md'), '# Other, theirs\n');
    git(dir, 'commit', '-q', '-am', 'Theirs');
    git(dir, 'checkout', '-q', 'main');
    writeFileSync(join(dir, 'other.md'), '# Other, ours\n');
    git(dir, 'commit', '-q', '-am', 'Ours');
    await start();
    const a = await connect('notes.md');
    const before = git(dir, 'rev-parse', 'main');
    // Stops on the conflict in other.md: HEAD detached, .git/rebase-merge there.
    await gitAsync(dir, 'rebase', 'other').catch(() => undefined);
    expect(existsSync(join(dir, '.git', 'rebase-merge'))).toBe(true);
    await until(() => a.messages.some((m) => m.type === 'save-status' && m.state === 'paused'), 15_000, 'paused');
    a.write(insertAt(a.read(), 'Light rain', 'Mid-rebase: '));
    await sleep(1500);
    expect(file()).not.toContain('Mid-rebase');
    expect(git(dir, 'rev-parse', 'main')).toBe(before);
    // Nothing new opens, and files are not changed from the app meanwhile.
    expect((await api('/api/rooms?path=other.md')).status).toBe(409);
    expect((await api('/api/files', { method: 'POST', body: JSON.stringify({ path: 'new.md', content: 'x' }) })).status).toBe(409);
    await gitAsync(dir, 'rebase', '--abort');
    await until(() => a.messages.some((m) => m.type === 'save-status' && m.state === 'ok'), 15_000, 'resumed');
    await until(() => git(dir, 'show', 'main:notes.md').includes('Mid-rebase: Light rain'), 15_000, 'saved after');
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('main');
  });

  it('a file not in UTF-8 is not opened, keeps its bytes, and merges as binary', async () => {
    const latin1 = Buffer.from('@book{caf\xe9,\n  title = {Caf\xe9 society},\n}\n', 'latin1');
    writeFileSync(join(dir, 'refs.bib'), latin1);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Refs');
    await start();
    const room = await api('/api/rooms?path=refs.bib');
    expect(room.status).toBe(415);
    expect(((await room.json()) as { error: string }).error).toMatch(/UTF-8/);
    const tree = (await (await api('/api/tree')).json()) as { files: { path: string; type: string | null; cannotOpen?: string }[] };
    expect(tree.files.find((f) => f.path === 'refs.bib')!.cannotOpen).toMatch(/UTF-8/);
    expect(readFileSync(join(dir, 'refs.bib'))).toEqual(latin1);
    // Changed on two sides: kept as bytes, the other side's beside it, never decoded and re-encoded.
    const base = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'refs.bib'), Buffer.from('@book{caf\xe9,\n  title = {Caf\xe9 soci\xe9t\xe9},\n}\n', 'latin1'));
    git(dir, 'commit', '-q', '-am', 'Ours');
    const ours = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'theirs', base);
    writeFileSync(join(dir, 'refs.bib'), Buffer.from('@book{caf\xe9,\n  title = {Le caf\xe9},\n}\n', 'latin1'));
    git(dir, 'commit', '-q', '-am', 'Theirs');
    const theirs = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');
    const outcome = await running.host.merge(ours, theirs);
    expect(outcome.copies).toHaveLength(1);
    const kept = execFileSync('git', ['cat-file', 'blob', `${outcome.commit}:refs.bib`], { cwd: dir });
    expect(kept.toString('latin1')).toContain('\xe9');
    expect(kept.includes(Buffer.from('\xc3\xa9', 'latin1'))).toBe(false);
  });

  it('merges files whose names hold a newline', async () => {
    const name = 'odd\nname.bin';
    const bytes = (s: string) => Buffer.concat([Buffer.from([0]), Buffer.from(s)]);
    writeFileSync(join(dir, name), bytes('base'));
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Odd');
    const base = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, name), bytes('ours'));
    git(dir, 'commit', '-q', '-am', 'Ours');
    const ours = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'theirs', base);
    writeFileSync(join(dir, name), bytes('theirs'));
    git(dir, 'commit', '-q', '-am', 'Theirs');
    const theirs = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');
    await start();
    // Both changed a binary file: one version kept, the other beside it, both under names with the newline.
    const outcome = await running.host.merge(ours, theirs);
    expect(outcome.kind).toBe('merge');
    expect(outcome.copies).toHaveLength(1);
    const files = git(dir, 'ls-tree', '-r', '-z', '--name-only', outcome.commit).split('\0').filter(Boolean);
    expect(files.sort()).toEqual(['notes.md', name, outcome.copies[0]!, 'other.md'].sort());
  });

  it('tries a commit again while another program holds git, and says so', async () => {
    await start();
    const a = await connect('notes.md');
    writeFileSync(join(dir, '.git', 'index.lock'), '');
    a.write(insertAt(a.read(), 'Light rain', 'Locked out: '));
    await until(() => a.messages.some((m) => m.type === 'save-status' && m.state === 'failing'), 15_000, 'the failure said');
    const said = a.messages.find((m) => m.type === 'save-status' && m.state === 'failing') as { message: string };
    expect(said.message).toMatch(/another program is using git/);
    rmSync(join(dir, '.git', 'index.lock'));
    await until(() => git(dir, 'show', 'HEAD:notes.md').includes('Locked out: '), 15_000, 'committed after');
    await until(() => a.messages.some((m) => m.type === 'save-status' && m.state === 'ok'), 15_000, 'said ok');
  });

  it('saves every room it can when one cannot be saved', async () => {
    await start({ ...FAST, flushMs: 600_000, idleCommitMs: 600_000 });
    const a = await connect('notes.md');
    const b = await connect('other.md');
    a.write(insertAt(a.read(), 'Light rain', 'A: '));
    b.write(insertAt(b.read(), 'Other', 'B: '));
    await until(() => a.read().textContent.includes('A: ') && b.read().textContent.includes('B: '));
    await sleep(100);
    // notes.md becomes a link: it cannot be written; other.md still is.
    rmSync(join(dir, 'notes.md'));
    symlinkSync(join(outside, 'secret.md'), join(dir, 'notes.md'));
    await expect(running.host.commitAll()).rejects.toThrow(/link/);
    expect(git(dir, 'show', 'HEAD:other.md')).toContain('B: Other');
    expect(readFileSync(join(outside, 'secret.md'), 'utf8')).toBe('# Secret\n');
  });

  it('deleting a folder closes the rooms of the files in it', async () => {
    mkdirSync(join(dir, 'drafts'));
    writeFileSync(join(dir, 'drafts', 'a.md'), '# A\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Drafts');
    await start();
    const a = await connect('drafts/a.md');
    a.write(insertAt(a.read(), 'A', 'Edited '));
    await until(() => a.read().textContent.includes('Edited '));
    expect((await api('/api/files?path=drafts', { method: 'DELETE' })).status).toBe(200);
    expect(running.host.openRooms().some((r) => r.path.startsWith('drafts/'))).toBe(false);
    a.write(insertAt(a.read(), 'Edited', 'Again '));
    await sleep(500);
    expect(existsSync(join(dir, 'drafts'))).toBe(false);
  });

  it('syncing talks to its remote outside the save queue: a slow remote holds up no saving', async () => {
    git(dir, 'config', 'protocol.ext.allow', 'always');
    git(dir, 'remote', 'add', 'origin', 'ext::sleep 3');
    git(dir, 'config', '--add', 'kuraa.online', 'origin');
    await start();
    const a = await connect('notes.md');
    const syncing = api('/api/sync', { method: 'POST' });
    await sleep(300);
    a.write(insertAt(a.read(), 'Light rain', 'While syncing: '));
    await until(() => record().dirty, 15_000, 'the edit at the host');
    const t0 = Date.now();
    await running.host.commitRoom(record());
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(git(dir, 'show', 'HEAD:notes.md')).toContain('While syncing: ');
    // Not synced: said, not thrown (the online copy, @kuraa/sync-git).
    expect((await syncing).status).toBe(409);
  });

  it('removes temporary files a stopped write left behind', async () => {
    writeFileSync(join(dir, '.notes.md.kuraa-tmp-0123abcd'), 'half');
    await start();
    expect(existsSync(join(dir, '.notes.md.kuraa-tmp-0123abcd'))).toBe(false);
  });
});

describe('the last resort', () => {
  it('logs an error nothing caught, saves, and stops only when errors come too fast', async () => {
    const on = new EventEmitter();
    const logs: string[] = [];
    let saves = 0;
    let stops = 0;
    const off = lastResort({ log: (m) => logs.push(m), save: async () => void saves++, stop: () => void stops++, limit: 3, on: on as never });
    on.emit('unhandledRejection', new Error('one workspace failed'));
    await sleep(10);
    expect(logs[0]).toMatch(/one workspace failed/);
    expect(saves).toBe(1);
    expect(stops).toBe(0);
    for (let i = 0; i < 3; i++) on.emit('uncaughtException', new Error('again'));
    expect(stops).toBe(1);
    off();
    expect(on.listenerCount('uncaughtException')).toBe(0);
  });
});

describe('the hub list', () => {
  it('is never taken for empty when it cannot be read: set aside, not written over', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kuraa-hub-'));
    try {
      writeFileSync(join(root, '.kuraa-workspaces.json'), '[{"id": "notes", "name": "Notes", "dir": ');
      const hub = await startHub({ root });
      try {
        expect(hub.hub.list()).toEqual([]);
        const aside = readdirSync(root).filter((f) => f.startsWith('.kuraa-workspaces.json.unreadable-'));
        expect(aside).toHaveLength(1);
        expect(readFileSync(join(root, aside[0]!), 'utf8')).toContain('"Notes"');
      } finally {
        await hub.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
