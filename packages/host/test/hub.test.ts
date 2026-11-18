// A hub: many workspaces behind one address and token, added from the app.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'prosemirror-transform';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { connectHeadless } from '@kuraa/session/testing';
import { slugOf, startHost, startHub, type RunningHost, type RunningHub } from '../src/index.js';

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
  });

  it('makes a new workspace as a git folder, and serves it under /w/<id> like a host of its own', async () => {
    const h = await hub();
    expect((await fetch(`${h.url}/hub/api/workspaces`)).status).toBe(401);
    expect(await (await call(h, '/hub/api/workspaces')).json()).toEqual({ workspaces: [] });
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
      await until(() => readFileSync(join(workspace.path, 'day-one.md'), 'utf8').includes('Live: Tide out.'), 5000, 'the edit on disk');
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

  it('joins a workspace from a subscription link, as a device that syncs', async () => {
    const source = temp('kuraa-hub-src-');
    git(source, 'init', '-q', '-b', 'main');
    git(source, 'config', 'user.name', 'Ada');
    git(source, 'config', 'user.email', 'ada@example.org');
    writeFileSync(join(source, 'notes.md'), '---\ntitle: Notes\n---\n\nHello.\n');
    git(source, 'add', '-A');
    git(source, 'commit', '-q', '-m', 'Initial');
    const a = await startHost({ dir: source, timings: FAST, peers: { bootstrap: testnet.bootstrap as never } });
    running.push(a);
    const link = await a.host.peers!.subscriptionLink(1);
    const h = await hub();
    const bad = await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'join', invitation: 'kuraa-link:nonsense', name: 'X' }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toContain('damaged');
    const res = await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'join', invitation: link, name: 'Ada’s notes' }) });
    expect(res.status).toBe(201);
    const { workspace } = (await res.json()) as { workspace: { id: string; path: string; peers: boolean } };
    expect(workspace).toMatchObject({ id: 'ada-s-notes', peers: true });
    expect(readFileSync(join(workspace.path, 'notes.md'), 'utf8')).toContain('Hello.');
    // It syncs: a file made through the hub reaches Ada's device.
    await call(h, `/w/${workspace.id}/api/files`, { method: 'POST', body: JSON.stringify({ path: 'reply.md', content: '# Reply\n' }) });
    await until(() => existsSync(join(source, 'reply.md')), 20_000, 'the reply on Ada’s device');
  });
});

describe('invitations from the app', () => {
  it('a hub’s workspace makes links and invitations, turning syncing on, and revokes them', async () => {
    const root = temp('kuraa-hub-');
    const h = await hub(root);
    await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Shared' }) });
    await call(h, '/w/shared/api/files', { method: 'POST', body: JSON.stringify({ path: 'plan.md', content: '# Plan\n' }) });
    expect(await (await call(h, '/w/shared/api/peers')).json()).toEqual({ enabled: false, canInvite: true });
    const made = await call(h, '/w/shared/api/peers/links', { method: 'POST', body: JSON.stringify({ hours: 24 }) });
    expect(made.status).toBe(201);
    const { link, id } = (await made.json()) as { link: string; id: string };
    expect(link).toMatch(/^kuraa-link:/);
    // Syncing is on now, and stays on.
    expect(await (await call(h, '/w/shared/api/peers')).json()).toMatchObject({ enabled: true, canInvite: true });
    expect(((await (await call(h, '/hub/api/workspaces')).json()) as { workspaces: { peers: boolean }[] }).workspaces[0]!.peers).toBe(true);
    expect(JSON.parse(readFileSync(join(root, '.kuraa-workspaces.json'), 'utf8'))[0].peers).toBe(true);
    // Someone joins with it, on another hub.
    const other = await hub();
    const joined = await call(other, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'join', invitation: link, name: 'From a friend' }) });
    expect(joined.status).toBe(201);
    const path = ((await joined.json()) as { workspace: { path: string } }).workspace.path;
    expect(readFileSync(join(path, 'plan.md'), 'utf8')).toBe('# Plan\n');
    // An invitation, good once.
    const inv = (await (await call(h, '/w/shared/api/peers/invitations', { method: 'POST' })).json()) as { invitation: string };
    expect(inv.invitation).toMatch(/^kuraa-invite:/);
    // Revoked: listed so, and refused from then on.
    expect((await call(h, `/w/shared/api/peers/links/${id}`, { method: 'DELETE' })).status).toBe(200);
    expect(((await (await call(h, '/w/shared/api/peers/links')).json()) as { links: { id: string; state: string }[] }).links).toEqual([expect.objectContaining({ id, state: 'revoked' })]);
    const late = await call(other, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'join', invitation: link, name: 'Too late' }) });
    expect(late.status).toBe(400);
    // Nothing half-made is left behind.
    expect(existsSync(join(other.hub.root, 'too-late'))).toBe(false);
  }, 240_000);

  it('a host of one workspace refuses unless its operator allows it', async () => {
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
    expect(((await r.json()) as { error: string }).error).toContain('--allow-invites');
  });
});
