// Turning plugins on and off: run plugins and formats, from the Plugins panel
// on a host its owner runs; kept in the host's settings file, never a workspace.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'prosemirror-transform';
import { rmarkdown } from '@kuraa/format-rmarkdown';
import { connectHeadless, type HeadlessClient } from '@kuraa/session/testing';
import { startHost, type RunningHost } from '../src/index.js';
import { orderEnvironments, resolveOn } from '../src/plugin-settings.js';

const FAST = { flushMs: 150, idleCommitMs: 600, maxCommitMs: 5000, dropMs: 400 };
const RMD = '# Chunks\n\n```{r}\n1 + 1\n```\n';
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

async function until(cond: () => boolean | Promise<boolean>, ms = 5000, what = 'condition'): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

describe('which plugins are on', () => {
  it('choices win over the options; the default environment goes first', () => {
    expect(resolveOn(['r', 'py'], ['r'], undefined)).toEqual(['r']);
    expect(resolveOn(['r', 'py'], ['r'], { r: false, py: true })).toEqual(['py']);
    expect(orderEnvironments(['local', 'podman'], ['podman'], undefined)).toEqual(['podman', 'local']);
    expect(orderEnvironments(['local', 'podman'], ['podman'], 'local')).toEqual(['local', 'podman']);
  });
});

describe('the Plugins panel on the host', () => {
  let dir: string;
  let data: string;
  let settings: string;
  let running: RunningHost;
  const clients: HeadlessClient[] = [];

  const api = (path: string, init: RequestInit = {}) =>
    fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' } });
  const put = (body: object) => api('/api/plugins', { method: 'PUT', body: JSON.stringify(body) });
  const start = (allowChanges = true) => startHost({
    dir,
    timings: FAST,
    run: { engines: ['r'], environments: ['local'], dataDir: data },
    pluginSettings: allowChanges ? settings : undefined,
  });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-plugins-'));
    data = mkdtempSync(join(tmpdir(), 'kuraa-plugins-data-'));
    settings = join(data, 'plugins.json');
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test Host');
    git(dir, 'config', 'user.email', 'host@example.org');
    writeFileSync(join(dir, 'analysis.Rmd'), RMD);
    writeFileSync(join(dir, 'notes.md'), '# Notes\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    running = await start();
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    await running.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  });

  it('lists every plugin, and what is on', async () => {
    const p = await (await api('/api/plugins')).json();
    expect(p.canChange).toBe(true);
    expect(p.engines).toEqual([expect.objectContaining({ id: 'r', label: 'R', on: true })]);
    expect(p.environments.map((e: { id: string; on: boolean; default: boolean }) => [e.id, e.on, e.default])).toEqual([['local', true, true], ['podman', false, false]]);
    expect(p.formats.map((f: { id: string; on: boolean }) => [f.id, f.on])).toEqual([['pandoc-markdown', true], ['rmarkdown', true], ['text', true]]);
  });

  it('a format turned off: its files open as text, open rooms close after writing, and the choice is kept', async () => {
    const { room } = await (await api('/api/rooms?path=analysis.Rmd')).json();
    const c = connectHeadless({ url: running.url.replace(/^http/, 'ws') + '/collab', room, token: running.token, user: { name: 'Ada', email: 'ada@example.org', color: '#d33' }, schema: rmarkdown.schema });
    clients.push(c);
    await c.ready;
    const doc = c.read();
    let at = -1;
    doc.descendants((n, pos) => {
      if (at < 0 && n.isTextblock && n.textContent === 'Chunks') at = pos + 1;
      return at < 0;
    });
    c.write(new Transform(doc).insert(at, rmarkdown.schema.text('More ')).doc);
    await until(async () => (await (await api('/api/rooms?path=analysis.Rmd')).json()).dirty === true, 5000, 'the edit');

    expect((await put({ formats: { rmarkdown: false } })).status).toBe(200);
    // Everyone with a file open hears of it; the edit reached the file before the room closed.
    await until(() => c.messages.some((m) => m.type === 'plugins'), 5000, 'the plugins message');
    expect(readFileSync(join(dir, 'analysis.Rmd'), 'utf8')).toContain('# More Chunks');
    const ws = await (await api('/api/workspace')).json();
    expect(ws.types.map((t: { id: string }) => t.id)).toEqual(['pandoc-markdown', 'text']);
    const tree = await (await api('/api/tree')).json();
    expect(tree.files).toContainEqual({ path: 'analysis.Rmd', type: 'text' });
    expect((await (await api('/api/rooms?path=analysis.Rmd')).json()).type).toBe('text');
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toMatchObject({ formats: { rmarkdown: false } });
    expect(existsSync(join(dir, '.kuraa'))).toBe(false); // nothing in the workspace

    // A new host with the same settings starts that way.
    await running.close();
    running = await start();
    expect((await (await api('/api/tree')).json()).files).toContainEqual({ path: 'analysis.Rmd', type: 'text' });
    expect((await put({ formats: { rmarkdown: true } })).status).toBe(200);
    expect((await (await api('/api/tree')).json()).files).toContainEqual({ path: 'analysis.Rmd', type: 'rmarkdown' });
  });

  it('run plugins: an environment as the default, and the engine off', async () => {
    let p = await (await put({ environments: { podman: true }, defaultEnvironment: 'podman' })).json();
    expect(p.environments.map((e: { id: string; on: boolean; default: boolean }) => [e.id, e.on, e.default])).toEqual([['local', true, false], ['podman', true, true]]);
    expect((await (await api('/api/workspace')).json()).run.environment.id).toBe('podman');

    p = await (await put({ engines: { r: false } })).json();
    expect(p.engines[0].on).toBe(false);
    expect((await (await api('/api/workspace')).json()).run.enabled).toBe(false);
    const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ path: 'analysis.Rmd', engine: 'r', code: '1', header: 'r', chunk: { index: 0, label: null } }) });
    expect(res.status).toBe(403);
  });

  it('refuses unknown plugins, and changes on a host that does not allow them', async () => {
    expect((await put({ engines: { julia: true } })).status).toBe(400);
    expect((await put({ defaultEnvironment: 'docker' })).status).toBe(400);
    await running.close();
    running = await start(false);
    const p = await (await api('/api/plugins')).json();
    expect(p.canChange).toBe(false);
    expect((await put({ formats: { rmarkdown: false } })).status).toBe(403);
    expect((await (await api('/api/tree')).json()).files).toContainEqual({ path: 'analysis.Rmd', type: 'rmarkdown' });
  });

  it('only a host on this computer alone may allow changes', async () => {
    await expect(startHost({ dir, host: '0.0.0.0', pluginSettings: settings })).rejects.toThrow(/127\.0\.0\.1/);
  });
});
