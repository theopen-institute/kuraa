// A hub: many workspaces behind one address and token, added from the app.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { Transform } from 'prosemirror-transform';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { connectHeadless } from '@kuraa/session/testing';
import { Hub, OWNER_OFF, SettingsStore, slugOf, startHost, startHub, type RunningHost, type RunningHub } from '../src/index.js';
import { isLoopback } from '../src/hub.js';
import { gateFor, hostAllowed } from '../src/origins.js';

const FAST = { flushMs: 100, idleCommitMs: 400, maxCommitMs: 3000, dropMs: 300 };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const dirs: string[] = [];
const running: (RunningHub | RunningHost)[] = [];
let testnet: Testnet;

beforeAll(async () => {
  testnet = await createTestnet(3);
});
afterAll(async () => {
  await testnet.destroy();
});
afterEach(async () => {
  for (const r of running.splice(0)) await r.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

async function hub(root = temp('kuraa-hub-'), token?: string): Promise<RunningHub> {
  const h = await startHub({ root, token, hosts: { timings: FAST }, peers: { bootstrap: testnet.bootstrap as never } });
  running.push(h);
  return h;
}

const call = (h: RunningHub, path: string, init: RequestInit = {}) =>
  fetch(h.url + path, { ...init, headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' } });

async function until(cond: () => boolean | Promise<boolean>, ms = 10_000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('a hub', () => {
  it('names folders from workspace names', () => {
    expect(slugOf('Field notes, 2026')).toBe('field-notes-2026');
    expect(slugOf('Café Ålesund')).toBe('cafe-alesund');
    expect(slugOf('  ')).toBe('workspace');
    expect(slugOf('Nul')).toBe('nul-workspace');
  });

  it('makes a new workspace as a git folder, and serves it under /w/<id> like a host of its own', async () => {
    const h = await hub();
    expect((await fetch(`${h.url}/hub/api/workspaces`)).status).toBe(401);
    expect(await (await call(h, '/hub/api/workspaces')).json()).toEqual({ workspaces: [], canAdd: true, canInvite: true, canOpenFolder: true, canChangeSettings: false, folder: h.hub.root });
    const made = await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Field notes' }) });
    expect(made.status).toBe(201);
    const { workspace } = (await made.json()) as { workspace: { id: string; path: string; name: string } };
    expect(workspace).toMatchObject({ id: 'field-notes', name: 'Field notes', peers: false });
    expect(git(workspace.path, 'log', '--format=%s')).toBe('Initialise workspace');
    // A second of the same name gets its own folder.
    const again = (await (await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Field notes' }) })).json()) as { workspace: { id: string } };
    expect(again.workspace.id).toBe('field-notes-2');

    // The workspace's API, through the hub: its name is the one given.
    expect(await (await call(h, '/w/field-notes/api/workspace')).json()).toMatchObject({ name: 'Field notes', branch: git(workspace.path, 'branch', '--show-current') });
    expect((await call(h, '/w/field-notes/api/files', { method: 'POST', body: JSON.stringify({ path: 'day-one.md', content: '---\ntitle: Day one\n---\n\nTide out.\n' }) })).status).toBe(201);
    expect(readFileSync(join(workspace.path, 'day-one.md'), 'utf8')).toContain('Tide out.');
    expect((await call(h, '/w/nowhere/api/workspace')).status).toBe(404);
    expect((await call(h, '/api/workspace')).status).toBe(404);

    // Its rooms too: a live client through the hub's address.
    const { room } = (await (await call(h, '/w/field-notes/api/rooms?path=day-one.md')).json()) as { room: string };
    const c = connectHeadless({ url: `${h.url.replace(/^http/, 'ws')}/w/field-notes/collab`, room, token: h.token, user: { name: 'Ada', email: 'ada@example.org', color: '#d33' }, schema: pandocMarkdown.schema });
    try {
      await c.ready;
      const doc = c.read();
      let pos = -1;
      doc.descendants((n, p) => {
        if (pos < 0 && n.isTextblock && n.textContent.includes('Tide')) pos = p + 1;
        return pos < 0;
      });
      c.write(new Transform(doc).insert(pos, pandocMarkdown.schema.text('Live: ')).doc);
      await until(() => readFileSync(join(workspace.path, 'day-one.md'), 'utf8').includes('Live: Tide out.'), 15_000, 'the edit on disk');
    } finally {
      c.destroy();
    }
    // Git, too.
    const clone = temp('kuraa-hub-clone-');
    // Not execFileSync: the hub answers from this same process.
    await promisify(execFile)('git', ['clone', '-q', `${h.url.replace('://', `://kuraa:${h.token}@`)}/w/field-notes/git`, join(clone, 'c')]);
    expect(existsSync(join(clone, 'c', 'day-one.md'))).toBe(true);
  });

  it('closes while people are still connected to a workspace', async () => {
    const h = await hub();
    await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Open' }) });
    await call(h, '/w/open/api/files', { method: 'POST', body: JSON.stringify({ path: 'a.md', content: '# A\n' }) });
    const { room } = (await (await call(h, '/w/open/api/rooms?path=a.md')).json()) as { room: string };
    const c = connectHeadless({ url: `${h.url.replace(/^http/, 'ws')}/w/open/collab`, room, token: h.token, user: { name: 'Ada', email: '', color: '#d33' }, schema: pandocMarkdown.schema });
    await c.ready;
    running.splice(running.indexOf(h), 1);
    await Promise.race([h.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('the hub did not close')), 5000))]);
    c.destroy();
  });

  it('keeps its list across restarts, and takes a workspace off it without touching its folder', async () => {
    const root = temp('kuraa-hub-');
    const first = await hub(root);
    await call(first, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Thesis' }) });
    await first.close();
    running.splice(running.indexOf(first), 1);
    const second = await hub(root, first.token);
    expect(((await (await call(second, '/hub/api/workspaces')).json()) as { workspaces: { id: string }[] }).workspaces.map((w) => w.id)).toEqual(['thesis']);
    expect((await call(second, '/w/thesis/api/tree')).status).toBe(200);
    expect((await call(second, '/hub/api/workspaces/thesis', { method: 'DELETE' })).status).toBe(200);
    expect((await call(second, '/w/thesis/api/tree')).status).toBe(404);
    expect(existsSync(join(root, 'thesis', '.git'))).toBe(true);
    // A workspace whose folder went away is listed, with why.
    await call(second, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Gone' }) });
    await second.close();
    running.splice(running.indexOf(second), 1);
    rmSync(join(root, 'gone'), { recursive: true, force: true });
    const third = await hub(root, first.token);
    const list = ((await (await call(third, '/hub/api/workspaces')).json()) as { workspaces: { id: string; error?: string }[] }).workspaces;
    expect(list).toEqual([expect.objectContaining({ id: 'gone', error: expect.stringContaining('Its folder is gone') })]);
    expect((await call(third, '/w/gone/api/tree')).status).toBe(503);
  });

  it('of one folder: serves it as its only workspace, and lets no one add or remove workspaces', async () => {
    const dir = temp('kuraa-one-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Ada');
    git(dir, 'config', 'user.email', 'ada@example.org');
    writeFileSync(join(dir, 'notes.md'), '# Notes\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    const h = await startHub({ folder: { dir }, hosts: { timings: FAST } });
    running.push(h);
    const id = slugOf(basename(dir));
    // Invites are always on: every member has the same say (0038). Opening other folders is not (one folder).
    expect(await (await call(h, '/hub/api/workspaces')).json()).toEqual({
      workspaces: [{ id, name: basename(dir), path: dir, peers: false }], canAdd: false, canInvite: true, canOpenFolder: false, canChangeSettings: false,
    });
    expect(((await (await call(h, `/w/${id}/api/tree`)).json()) as { files: { path: string }[] }).files.map((f) => f.path)).toContain('notes.md');
    expect((await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'More' }) })).status).toBe(403);
    expect((await call(h, `/hub/api/workspaces/${id}`, { method: 'DELETE' })).status).toBe(403);
    expect((await call(h, '/hub/api/workspaces/open', { method: 'POST', body: JSON.stringify({ path: dir }) })).status).toBe(403);
    // It keeps no list beside the folder.
    expect(existsSync(join(dir, '.kuraa-workspaces.json'))).toBe(false);
  });

  it('gives the owner’s features only listening on this computer alone, and says why not', async () => {
    expect(isLoopback('127.0.0.1')).toBe(true);
    expect(isLoopback('::1')).toBe(true);
    expect(isLoopback('localhost')).toBe(true);
    expect(isLoopback('0.0.0.0')).toBe(false);
    expect(isLoopback('192.168.1.4')).toBe(false);
    const root = temp('kuraa-hub-net-');
    const settings = new SettingsStore(join(temp('kuraa-hub-net-settings-'), 'settings.json'));
    // Not started: listening on the network is not needed to see what it would allow.
    const open = new Hub({ root, host: '0.0.0.0', settings });
    expect(open.owner).toBe(false);
    expect(open.listing()).toMatchObject({ canAdd: true, canInvite: true, canOpenFolder: false, canChangeSettings: false, ownerOff: OWNER_OFF });
    expect(OWNER_OFF).toContain('open to other computers on the network');
    for (const refused of [open.settingsView(), open.saveSettings({}), open.folders(null), open.openFolder(root, true)]) {
      await expect(refused).rejects.toMatchObject({ status: 403, message: OWNER_OFF });
    }
    const own = new Hub({ root, settings });
    expect(own.owner).toBe(true);
    expect(own.listing()).toMatchObject({ canOpenFolder: true, canChangeSettings: true });
    expect(own.listing().ownerOff).toBeUndefined();
  });

  it('answers pages only at a name for this computer, and lets other origins read it or open rooms only if named', async () => {
    const dir = temp('kuraa-hub-gate-');
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, 'notes.md'), '# Notes\n');
    git(dir, 'add', '-A');
    git(dir, '-c', 'user.name=A', '-c', 'user.email=a@a', 'commit', '-qm', 'Initial');
    const h = await startHub({ folder: { dir }, hosts: { timings: FAST }, allowOrigins: ['http://dev.example:5173/'] });
    running.push(h);
    const id = slugOf(basename(dir));
    const { port } = new URL(h.url);
    /** A request with the headers a browser would send (fetch cannot set Host). */
    const ask = (path: string, headers: Record<string, string>, method = 'GET') => new Promise<{ status: number; headers: IncomingHttpHeaders }>((done, fail) => {
      request({ host: '127.0.0.1', port, path, method, headers: { authorization: `Bearer ${h.token}`, ...headers } }, (res) => {
        res.resume();
        done({ status: res.statusCode!, headers: res.headers });
      }).on('error', fail).end();
    });
    // A name made to point here (DNS rebinding) is turned away, by the hub and by its workspaces.
    expect((await ask('/hub/api/workspaces', { host: `evil.example:${port}` })).status).toBe(421);
    expect((await ask(`/w/${id}/api/tree`, { host: `evil.example:${port}` })).status).toBe(421);
    for (const host of [`localhost:${port}`, `127.0.0.1:${port}`, 'localhost:5173']) expect((await ask(`/w/${id}/api/tree`, { host })).status).toBe(200);
    // Another origin reads nothing unless named: no CORS headers for it.
    const other = await ask(`/w/${id}/api/tree`, { host: `127.0.0.1:${port}`, origin: 'https://evil.example' }, 'OPTIONS');
    expect(other.headers['access-control-allow-origin']).toBeUndefined();
    const named = await ask(`/w/${id}/api/tree`, { host: `127.0.0.1:${port}`, origin: 'http://dev.example:5173' }, 'OPTIONS');
    expect(named.headers['access-control-allow-origin']).toBe('http://dev.example:5173');
    expect((await ask('/hub/api/workspaces', { host: `127.0.0.1:${port}`, origin: 'http://dev.example:5173' })).headers['access-control-allow-origin']).toBe('http://dev.example:5173');
    // Rooms: from its own origin, one named and the desktop app's files; not from another, nor at another name.
    const opens = (headers: Record<string, string>) => new Promise<boolean>((done) => {
      request({ host: '127.0.0.1', port, path: `/w/${id}/collab`, headers: { connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==', ...headers } })
        .on('upgrade', (_res, socket) => {
          socket.destroy();
          done(true);
        })
        .on('response', () => done(false))
        .on('error', () => done(false))
        .end();
    });
    expect(await opens({ host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}` })).toBe(true);
    expect(await opens({ host: `127.0.0.1:${port}`, origin: 'http://dev.example:5173' })).toBe(true);
    expect(await opens({ host: `127.0.0.1:${port}`, origin: 'file://' })).toBe(true);
    expect(await opens({ host: `127.0.0.1:${port}`, origin: 'https://evil.example' })).toBe(false);
    expect(await opens({ host: `evil.example:${port}`, origin: `http://evil.example:${port}` })).toBe(false);
  });

  it('on the network, answers at any name', () => {
    const asking = (host: string) => ({ headers: { host } }) as IncomingMessage;
    expect(hostAllowed(asking('kuraa.example.org'), gateFor('0.0.0.0'))).toBe(true);
    expect(hostAllowed(asking('kuraa.example.org'), gateFor('127.0.0.1'))).toBe(false);
    expect(hostAllowed(asking('[::1]:4321'), gateFor('::1'))).toBe(true);
  });

  it('a host started on its own says it is not a hub, so a client shows it as one workspace', async () => {
    const dir = temp('kuraa-host-');
    const h = await startHost({ dir, init: true, timings: FAST, staticDir: dir });
    running.push(h);
    const res = await fetch(`${h.url}/hub/api/workspaces`, { headers: { authorization: `Bearer ${h.token}` } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.stringContaining('not a hub') });
  });

  it('of one folder: makes it a repository with init, and will not start on a folder it cannot open', async () => {
    const dir = temp('kuraa-one-new-');
    const h = await startHub({ folder: { dir, init: true }, hosts: { timings: FAST } });
    running.push(h);
    expect(existsSync(join(dir, '.git'))).toBe(true);
    await expect(startHub({ folder: { dir: join(dir, 'not-there') }, hosts: { timings: FAST } })).rejects.toThrow();
  });

  it('syncs a workspace once it is shared, and only then: one on this computer alone has nothing to sync with', async () => {
    const root = temp('kuraa-hub-');
    const syncing = async (h: RunningHub) => ((await (await call(h, '/hub/api/workspaces')).json()) as { workspaces: { peers: boolean }[] }).workspaces.map((w) => w.peers);
    // Once its workspaces have opened: the hub answers before (0103), and says which are opening.
    const restart = async (h: RunningHub) => {
      await h.close();
      running.splice(running.indexOf(h), 1);
      const next = await hub(root, h.token);
      await next.hub.opened();
      return next;
    };
    let h = await hub(root);
    await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Thesis' }) });
    await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Diary' }) });
    expect(await syncing(h)).toEqual([false, false]);
    // Not shared, not syncing, after a restart too: nothing is announced for them.
    h = await restart(h);
    expect(await syncing(h)).toEqual([false, false]);
    expect(existsSync(join(root, 'thesis', '.git', 'kuraa', 'bin', 'git-remote-kuraa'))).toBe(false);
    // Made shared outside the hub (kuraa-host invite, say): it syncs from its next start on, and the other still does not.
    git(join(root, 'thesis'), 'config', 'kuraa.workspace', 'ab'.repeat(16));
    git(join(root, 'thesis'), 'config', 'kuraa.secret', 'cd'.repeat(32));
    h = await restart(h);
    expect(await syncing(h)).toEqual([true, false]);
    await until(() => existsSync(join(root, 'thesis', '.git', 'kuraa', 'bin', 'git-remote-kuraa')), 10_000, 'syncing started');
  });

  it('answers as soon as it listens, its workspaces opening meanwhile: what is asked of one waits for it (0103)', async () => {
    const root = temp('kuraa-hub-');
    let h = await hub(root);
    for (const name of ['Thesis', 'Diary']) await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name }) });
    await h.close();
    running.splice(running.indexOf(h), 1);
    h = await hub(root, h.token);
    // Asked at once: each is opening or open, and one asked of is answered once it has opened (never 503).
    const list = ((await (await call(h, '/hub/api/workspaces')).json()) as { workspaces: { id: string; opening?: boolean; error?: string }[] }).workspaces;
    expect(list.map((w) => w.id)).toEqual(['thesis', 'diary']);
    expect(list.every((w) => !w.error)).toBe(true);
    const asked = await call(h, '/w/diary/api/workspace');
    expect(asked.status).toBe(200);
    await h.hub.opened();
    const after = ((await (await call(h, '/hub/api/workspaces')).json()) as { workspaces: { opening?: boolean }[] }).workspaces;
    expect(after.some((w) => w.opening)).toBe(false);
  });

  it('says which workspaces a cloud storage service keeps, and moves one out, into its folder, where it opens again (0103)', async () => {
    const home = temp('kuraa-home-');
    const was = process.env.HOME;
    process.env.HOME = home;
    try {
      const kept = join(home, 'Dropbox', 'Notes');
      mkdirSync(kept, { recursive: true });
      git(kept, 'init', '-q', '-b', 'main');
      git(kept, 'config', 'user.name', 'Ada');
      git(kept, 'config', 'user.email', 'ada@example.org');
      writeFileSync(join(kept, 'a.md'), '---\ntitle: A\n---\n\nHello.\n');
      git(kept, 'add', '-A');
      git(kept, 'commit', '-q', '-m', 'Initial');
      const root = join(home, 'Kuraa Workspaces');
      const h = await hub(root);
      const added = (await (await call(h, '/hub/api/workspaces/open', { method: 'POST', body: JSON.stringify({ path: kept }) })).json()) as { workspace: { id: string; cloud?: string } };
      expect(added.workspace.cloud).toBe('Dropbox');
      const { id } = added.workspace;
      // One no service keeps is not moved.
      await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Here' }) });
      expect((await call(h, '/hub/api/workspaces/here/move', { method: 'POST' })).status).toBe(400);
      const moved = await call(h, `/hub/api/workspaces/${id}/move`, { method: 'POST' });
      expect(moved.status).toBe(200);
      const { workspace } = (await moved.json()) as { workspace: { path: string; cloud?: string; error?: string } };
      expect(workspace).toMatchObject({ path: join(root, 'Notes') });
      expect(workspace.cloud).toBeUndefined();
      expect(workspace.error).toBeUndefined();
      expect(existsSync(kept)).toBe(false);
      expect(git(join(root, 'Notes'), 'log', '--format=%s')).toBe('Initial');
      // Served from where it is now, and kept so on the list.
      expect((await call(h, `/w/${id}/api/workspace`)).status).toBe(200);
      expect(JSON.parse(readFileSync(join(root, '.kuraa-workspaces.json'), 'utf8')).find((e: { id: string }) => e.id === id).dir).toBe(join(root, 'Notes'));
    } finally {
      process.env.HOME = was;
    }
  });

  it('joins a workspace from an invite link, as a device that syncs, called what it calls itself; a rename on either reaches the other', async () => {
    const source = temp('kuraa-hub-src-');
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'user.name', 'Ada');
    git(source, 'config', 'user.email', 'ada@example.org');
    writeFileSync(join(source, 'notes.md'), '---\ntitle: Notes\n---\n\nHello.\n');
    // Its name, as whoever made it gave it (0061).
    mkdirSync(join(source, '.kuraa'));
    writeFileSync(join(source, '.kuraa', 'workspace.json'), '{"name":"Ada’s notes"}\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'Initial');
    const a = await startHost({ dir: source, timings: FAST, peers: { bootstrap: testnet.bootstrap as never } });
    running.push(a);
    const link = await a.host.peers!.inviteLink({ hours: 1, once: true });
    const h = await hub();
    const bad = await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'join', invitation: 'kuraa-invite:nonsense', name: 'X' }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('damaged');
    // How it is going, asked by the id given, while it goes; nothing once it is over.
    const id = 'join-progress-1';
    const steps = new Set<string>();
    let done = false;
    const posted = call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'join', invitation: link, progress: id }) }).finally(() => {
      done = true;
    });
    while (!done) {
      const s = await call(h, `/hub/api/joins/${id}`);
      if (s.status === 200) steps.add(((await s.json()) as { step: string }).step);
      await new Promise((r) => setTimeout(r, 10));
    }
    const res = await posted;
    expect(steps.size).toBeGreaterThan(0);
    for (const step of steps) expect(['waiting', 'looking', 'letting-in', 'copying', 'opening']).toContain(step);
    expect((await call(h, `/hub/api/joins/${id}`)).status).toBe(404);
    expect(res.status).toBe(201);
    const { workspace } = (await res.json()) as { workspace: { id: string; path: string; peers: boolean; name: string } };
    // Called what it calls itself: nobody joining names it.
    expect(workspace).toMatchObject({ id: 'shared-workspace', name: 'Ada’s notes', peers: true });
    expect(await (await call(h, `/w/${workspace.id}/api/workspace`)).json()).toMatchObject({ name: 'Ada’s notes', named: true });
    expect(readFileSync(join(workspace.path, 'notes.md'), 'utf8')).toContain('Hello.');
    // It syncs: a file made through the hub reaches Ada's device.
    await call(h, `/w/${workspace.id}/api/files`, { method: 'POST', body: JSON.stringify({ path: 'reply.md', content: '# Reply\n' }) });
    await until(() => existsSync(join(source, 'reply.md')), 20_000, 'the reply on Ada’s device');

    // Renamed here, for everyone: a commit crediting who did it, which reaches Ada's device.
    const renamed = await call(h, `/w/${workspace.id}/api/workspace/name`, { method: 'PATCH', body: JSON.stringify({ name: '  Field   notes ', by: { name: 'Bo', email: 'bo@example.org' } }) });
    expect(await renamed.json()).toEqual({ name: 'Field notes' });
    expect(git(workspace.path, 'log', '-1', '--format=%s%n%b')).toMatch(/^Rename the workspace to “Field notes”[\s\S]*Co-authored-by: Bo <bo@example\.org>/);
    expect(((await (await call(h, '/hub/api/workspaces')).json()) as { workspaces: { name: string }[] }).workspaces[0]!.name).toBe('Field notes');
    await until(() => a.host.sharedName === 'Field notes', 20_000, 'the new name on Ada’s device');
    // And renamed there: the hub's list follows.
    await a.host.rename('Shore survey');
    const listed = async () => ((await (await call(h, '/hub/api/workspaces')).json()) as { workspaces: { name: string }[] }).workspaces[0]!.name;
    await until(async () => (await listed()) === 'Shore survey', 20_000, 'Ada’s rename in the hub’s list');
    // A name must be something, and not too long.
    expect((await call(h, `/w/${workspace.id}/api/workspace/name`, { method: 'PATCH', body: JSON.stringify({ name: '   ' }) })).status).toBe(400);
    expect((await call(h, `/w/${workspace.id}/api/workspace/name`, { method: 'PATCH', body: JSON.stringify({ name: 'x'.repeat(101) }) })).status).toBe(400);
  });

  it('names a new workspace in it, for whoever joins it later; a workspace made before is named when it is first shared', async () => {
    const h = await hub();
    const made = (await (await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Field notes' }) })).json()) as { workspace: { path: string } };
    expect(readFileSync(join(made.workspace.path, '.kuraa', 'workspace.json'), 'utf8')).toBe('{"name":"Field notes"}\n');
    expect(git(made.workspace.path, 'ls-files')).toContain('.kuraa/workspace.json');
    expect((await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: ' ' }) })).status).toBe(400);

    // A workspace that names itself nowhere (made before 0061) goes by what this device calls it, until it is shared.
    const old = temp('kuraa-hub-old-');
    git(old, 'init', '-q', '-b', 'main');
    writeFileSync(join(old, 'notes.md'), '# Notes\n');
    git(old, 'add', '-A');
    git(old, '-c', 'user.name=Ada', '-c', 'user.email=ada@example.org', 'commit', '-q', '-m', 'Initial');
    const opened = (await (await call(h, '/hub/api/workspaces/open', { method: 'POST', body: JSON.stringify({ path: old }) })).json()) as { workspace: { id: string } };
    expect(await (await call(h, `/w/${opened.workspace.id}/api/workspace`)).json()).toMatchObject({ name: basename(old), named: false });
    expect(existsSync(join(old, '.kuraa', 'workspace.json'))).toBe(false);
    // Its first invite link names it, so whoever joins sees that name.
    expect((await call(h, `/w/${opened.workspace.id}/api/peers/links`, { method: 'POST', body: JSON.stringify({ hours: 1 }) })).status).toBe(201);
    expect(git(old, 'log', '-1', '--format=%s')).toBe(`Name the workspace “${basename(old)}”`);
    expect(await (await call(h, `/w/${opened.workspace.id}/api/workspace`)).json()).toMatchObject({ name: basename(old), named: true });
  });
});

describe('invite links from the app', () => {
  it('a hub’s workspace makes invite links, turning syncing on, and revokes them', async () => {
    const root = temp('kuraa-hub-');
    const h = await hub(root);
    await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Shared' }) });
    await call(h, '/w/shared/api/files', { method: 'POST', body: JSON.stringify({ path: 'plan.md', content: '# Plan\n' }) });
    expect(await (await call(h, '/w/shared/api/peers')).json()).toEqual({ enabled: false, canInvite: true });
    const made = await call(h, '/w/shared/api/peers/links', { method: 'POST', body: JSON.stringify({ hours: 24 }) });
    expect(made.status).toBe(201);
    const { link, id, once } = (await made.json()) as { link: string; id: string; once: boolean };
    expect(link).toMatch(/^kuraa-invite:/);
    expect(once).toBe(false);
    // Syncing is on now, and stays on.
    expect(await (await call(h, '/w/shared/api/peers')).json()).toMatchObject({ enabled: true, canInvite: true });
    expect(((await (await call(h, '/hub/api/workspaces')).json()) as { workspaces: { peers: boolean }[] }).workspaces[0]!.peers).toBe(true);
    // The hub's list says nothing of it: the repository does (it is shared now).
    expect(JSON.parse(readFileSync(join(root, '.kuraa-workspaces.json'), 'utf8'))[0]).not.toHaveProperty('peers');
    expect(git(join(root, 'shared'), 'config', 'kuraa.workspace')).toMatch(/^[0-9a-f]+$/);
    // Someone joins with it, on another hub.
    const other = await hub();
    const joined = await call(other, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'join', invitation: link, name: 'From a friend' }) });
    expect(joined.status).toBe(201);
    const path = ((await joined.json()) as { workspace: { path: string } }).workspace.path;
    expect(readFileSync(join(path, 'plan.md'), 'utf8')).toBe('# Plan\n');
    // One for one person, with no expiry.
    const one = (await (await call(h, '/w/shared/api/peers/links', { method: 'POST', body: JSON.stringify({ hours: null, once: true }) })).json()) as { once: boolean; expires: number };
    expect(one).toMatchObject({ once: true, expires: 0 });
    // Revoked: listed so, and refused from then on.
    expect((await call(h, `/w/shared/api/peers/links/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(((await (await call(h, '/w/shared/api/peers/links')).json()) as { links: { id: string; state: string }[] }).links[0]).toEqual(expect.objectContaining({ id, state: 'revoked' }));
    const late = await call(other, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'join', invitation: link, name: 'Too late' }) });
    expect(late.status).toBe(400);
    // Nothing half-made is left behind.
    expect(existsSync(join(other.hub.root, 'too-late'))).toBe(false);
  }, 240_000);

  it('a host started on its own (not a hub) makes no invite links unless told to', async () => {
    const dir = temp('kuraa-host-');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'A');
    git(dir, 'config', 'user.email', 'a@example.org');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'Initial');
    const h = await startHost({ dir, timings: FAST });
    running.push(h);
    const api = (p: string, init: RequestInit = {}) => fetch(h.url + p, { ...init, headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' } });
    expect(await (await api('/api/peers')).json()).toEqual({ enabled: false, canInvite: false });
    const r = await api('/api/peers/links', { method: 'POST', body: JSON.stringify({ hours: 24 }) });
    expect(r.status).toBe(403);
    expect(((await r.json()) as { error: string }).error).toContain('turned off for this workspace');
  });
});
