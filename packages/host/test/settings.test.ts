// The owner's settings (settings.ts): one model for the desktop app and the
// browser, kept by the hub, applied by reopening its workspaces (decision 0047).
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Transform } from 'prosemirror-transform';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { connectHeadless } from '@kuraa/session/testing';
import { DATA_MARKER, DEFAULT_SETTINGS, SettingsStore, checkDataDir, fromSettings, settingsFrom, startHub, type RunningHub } from '../src/index.js';

const FAST = { flushMs: 100, idleCommitMs: 60_000, maxCommitMs: 120_000, dropMs: 300 };
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const dirs: string[] = [];
const running: RunningHub[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) await r.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
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

describe('settings', () => {
  it('fill in what an older file lacks with the defaults, and pass over what is no longer a setting', () => {
    expect(settingsFrom({ syncDevices: true, runCode: false, rImages: ['a'], workspaces: '/w', podman: '/opt/podman' })).toEqual({
      ...DEFAULT_SETTINGS, syncDevices: true, runCode: false, rImages: ['a'], workspaces: '/w',
    });
    expect(settingsFrom(null)).toEqual(DEFAULT_SETTINGS);
    // Installs are allowed unless turned off, everywhere.
    expect(DEFAULT_SETTINGS.allowInstalls).toBe(true);
    expect('podman' in DEFAULT_SETTINGS).toBe(false);
  });

  it('keep what the dialog sets', () => {
    const s = settingsFrom({
      ...DEFAULT_SETTINGS,
      memory: '6g', cpus: '1.5', disk: '500m', allowWrite: true, allowNetwork: true, allowInstalls: false,
      dataDir: '/data', environment: 'podman',
      formats: ['pandoc-markdown', 'text'], bootstrap: ['node.example.org:49737', 'node.example.org:49737'],
      saveSeconds: '0.5', versionSeconds: 60,
    }, true);
    expect(s).toMatchObject({
      memory: '6g', cpus: 1.5, disk: '500m', allowWrite: true, allowNetwork: true, allowInstalls: false,
      dataDir: '/data', environment: 'podman',
      formats: ['pandoc-markdown', 'text'], bootstrap: ['node.example.org:49737'], saveSeconds: 0.5, versionSeconds: 60,
    });
  });

  it('read empty fields as the defaults', () => {
    expect(settingsFrom({ memory: '', cpus: '', disk: ' ', saveSeconds: '', dataDir: '' }, true)).toMatchObject({
      memory: null, cpus: null, disk: null, saveSeconds: null, dataDir: null,
    });
  });

  it('refuse, when saved, what is wrong, saying what', () => {
    expect(() => settingsFrom({ memory: 'lots' }, true)).toThrow(/memory limit should be a size/);
    expect(() => settingsFrom({ disk: '0' }, true)).toThrow(/disk limit/);
    expect(() => settingsFrom({ cpus: 0 }, true)).toThrow(/at least 0.1/);
    expect(() => settingsFrom({ bootstrap: ['https://node.example.org'] }, true)).toThrow(/host:port/);
    expect(() => settingsFrom({ formats: [] }, true)).toThrow(/at least one kind/);
    expect(() => settingsFrom({ versionSeconds: 0 }, true)).toThrow(/Saving a version/);
    expect(() => settingsFrom({ workspaces: 'Documents/kuraa' }, true)).toThrow(/whole path/);
    expect(() => settingsFrom({ dataDir: 'data' }, true)).toThrow(/whole path/);
  });

  it('pass over, when read from disk, what is wrong', () => {
    expect(settingsFrom({ memory: 'lots', cpus: -1, bootstrap: ['nope', 'a.b:1'], formats: [], workspaces: 'relative' })).toMatchObject({
      memory: null, cpus: null, bootstrap: ['a.b:1'], formats: null, workspaces: null,
    });
  });

  it('are kept in a file, read leniently, written strictly, with the flags winning', async () => {
    const file = join(temp('kuraa-settings-'), 'deeper', 'settings.json');
    expect(new SettingsStore(file).current).toEqual(DEFAULT_SETTINGS);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify({ memory: 'lots', allowWrite: true, runCode: false }));
    const store = new SettingsStore(file, { runCode: true, formats: ['text'] });
    expect(store.saved).toMatchObject({ memory: null, allowWrite: true, runCode: false });
    expect(store.current).toMatchObject({ allowWrite: true, runCode: true, formats: ['text'] });
    expect(store.fromFlags.sort()).toEqual(['formats', 'runCode']);
    await expect(store.save({ ...store.saved, memory: 'lots' })).rejects.toMatchObject({ status: 400, message: expect.stringContaining('memory limit') });
    // Nothing is kept from a refused save.
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ memory: 'lots' });
    // A flag's setting may be saved, but the flag still wins; changing only it changes nothing that applies.
    expect(await store.save({ ...store.saved, runCode: true })).toBe(false);
    expect(await store.save({ ...store.saved, memory: '2g' })).toBe(true);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ memory: '2g', runCode: true });
    // A file that is not JSON is the defaults.
    writeFileSync(file, '{ nope');
    expect(new SettingsStore(file).current).toEqual(DEFAULT_SETTINGS);
  });

  it('keep packages and tools only in an empty folder, a new one, or one already used for them', async () => {
    const base = temp('kuraa-data-');
    const app = join(base, 'app');
    mkdirSync(app);
    writeFileSync(join(app, 'settings.json'), '{}');
    // The app's own data folder, whatever is in it.
    await checkDataDir(app, app);
    // An empty folder, and one not there yet: made, and marked.
    mkdirSync(join(base, 'empty'));
    await checkDataDir(join(base, 'empty'), app);
    expect(existsSync(join(base, 'empty', DATA_MARKER))).toBe(true);
    await checkDataDir(join(base, 'new', 'packages'), app);
    expect(existsSync(join(base, 'new', 'packages', DATA_MARKER))).toBe(true);
    // Marked, it may be chosen again once it holds packages.
    writeFileSync(join(base, 'empty', 'cache.db'), '');
    await checkDataDir(join(base, 'empty'), app);
    // Not a folder with other things in it.
    mkdirSync(join(base, 'papers'));
    writeFileSync(join(base, 'papers', 'thesis.md'), '# Thesis\n');
    await expect(checkDataDir(join(base, 'papers'), app)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('already has other things in it') });
    expect(existsSync(join(base, 'papers', DATA_MARKER))).toBe(false);
    // Saving: checked only when it changes.
    const store = new SettingsStore(join(base, 'settings.json'), {}, app);
    await expect(store.save({ dataDir: join(base, 'papers') })).rejects.toMatchObject({ status: 400 });
    await store.save({ dataDir: join(base, 'fresh') });
    expect(store.current.dataDir).toBe(join(base, 'fresh'));
  });

  it('become host options, with what only flags set kept apart', () => {
    const o = fromSettings({ ...DEFAULT_SETTINGS, runCode: true, environment: 'gone', memory: '2g', saveSeconds: 0.5, formats: ['text', 'old'], syncDevices: true, bootstrap: ['a.b:1'] }, {
      run: { components: ['x'], allowUnsandboxed: true, options: { podman: { podman: '/p' } } },
      timings: { flushMs: 50 },
      environments: ['podman'],
      formats: ['text', 'pandoc-markdown'],
    });
    expect(o.run).toMatchObject({ engines: ['r'], environment: undefined, memory: '2g', allowInstalls: true, components: ['x'], allowUnsandboxed: true, options: { podman: { podman: '/p' }, r: { images: [] } } });
    expect(o.formats).toEqual(['text']);
    expect(o.timings).toEqual({ flushMs: 50 });
    expect(o.peers).toEqual({ everywhere: true, bootstrap: ['a.b:1'] });
    expect(fromSettings({ ...DEFAULT_SETTINGS, runCode: false }).run.engines).toEqual([]);
    // Engines named with --engine win.
    expect(fromSettings({ ...DEFAULT_SETTINGS, runCode: true }, { run: { engines: ['none'] } }).run.engines).toEqual([]);
  });
});

describe('a hub’s settings', () => {
  async function ownHub(flags = {}): Promise<{ h: RunningHub; root: string; file: string }> {
    const base = temp('kuraa-hub-settings-');
    const root = join(base, 'workspaces');
    const file = join(base, 'app', 'settings.json');
    const h = await startHub({ defaultRoot: root, registry: join(base, 'app', 'workspaces.json'), settings: new SettingsStore(file, flags, join(base, 'app')), hosts: { timings: FAST } });
    running.push(h);
    return { h, root, file };
  }

  it('are read and changed through GET and PUT /hub/api/settings, a wrong value refused in plain words', async () => {
    const { h, file } = await ownHub({ allowNetwork: true });
    expect((await fetch(`${h.url}/hub/api/settings`)).status).toBe(401);
    const view = (await (await call(h, '/hub/api/settings')).json()) as Record<string, unknown>;
    expect(view).toMatchObject({
      settings: { ...DEFAULT_SETTINGS, allowNetwork: true },
      fromFlags: ['allowNetwork'],
      defaults: { memory: expect.any(String), saveSeconds: 2, versionSeconds: 30 },
      defaultDataDir: join(file, '..'),
      canAdd: true,
    });
    expect((view.formats as { id: string }[]).map((f) => f.id)).toContain('rmarkdown');
    const bad = await call(h, '/hub/api/settings', { method: 'PUT', body: JSON.stringify({ ...DEFAULT_SETTINGS, memory: 'lots' }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('The memory limit should be a size such as 4g or 512m, not “lots”.');
    expect(existsSync(file)).toBe(false);
    const good = await call(h, '/hub/api/settings', { method: 'PUT', body: JSON.stringify({ ...DEFAULT_SETTINGS, memory: '3g' }) });
    expect(good.status).toBe(200);
    expect(((await good.json()) as { settings: { memory: string } }).settings.memory).toBe('3g');
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ memory: '3g' });
  });

  it('apply at once: every workspace reopens with them, at the same address and access code, its edits committed first', async () => {
    const { h, root } = await ownHub();
    const { url, token } = h;
    const made = (await (await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Notes' }) })).json()) as { workspace: { path: string } };
    const dir = made.workspace.path;
    await call(h, '/w/notes/api/files', { method: 'POST', body: JSON.stringify({ path: 'a.md', content: '# A\n\nTide out.\n' }) });
    const types = async () => ((await (await call(h, '/w/notes/api/workspace')).json()) as { types: { id: string }[] }).types.map((t) => t.id);
    expect(await types()).toContain('rmarkdown');

    // An edit written to the file but not yet a version (the version waits a minute here).
    const { room } = (await (await call(h, '/w/notes/api/rooms?path=a.md')).json()) as { room: string };
    const c = connectHeadless({ url: `${h.url.replace(/^http/, 'ws')}/w/notes/collab`, room, token: h.token, user: { name: 'Ada', email: 'ada@example.org', color: '#d33' }, schema: pandocMarkdown.schema });
    try {
      await c.ready;
      const doc = c.read();
      let pos = -1;
      doc.descendants((n, p) => {
        if (pos < 0 && n.isTextblock && n.textContent.includes('Tide')) pos = p + 1;
        return pos < 0;
      });
      c.write(new Transform(doc).insert(pos, pandocMarkdown.schema.text('Live: ')).doc);
      await until(() => readFileSync(join(dir, 'a.md'), 'utf8').includes('Live: Tide out.'), 15_000, 'the edit on disk');
    } finally {
      c.destroy();
    }
    const versions = () => Number(git(dir, 'rev-list', '--count', 'HEAD'));
    const before = versions();
    expect(git(dir, 'status', '--porcelain')).not.toBe('');

    const elsewhere = join(root, '..', 'elsewhere');
    const res = await call(h, '/hub/api/settings', { method: 'PUT', body: JSON.stringify({ ...DEFAULT_SETTINGS, formats: ['pandoc-markdown', 'text'], workspaces: elsewhere }) });
    expect(res.status).toBe(200);
    // Committed while closing.
    expect(versions()).toBe(before + 1);
    expect(git(dir, 'status', '--porcelain')).toBe('');
    // Reopened with the new settings, at the same address and with the same access code.
    expect(h.url).toBe(url);
    expect(h.hub.token).toBe(token);
    expect(await types()).not.toContain('rmarkdown');
    // New workspaces go in the new folder; the list is kept.
    expect(h.hub.root).toBe(resolve(elsewhere));
    const next = (await (await call(h, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Later' }) })).json()) as { workspace: { path: string } };
    expect(next.workspace.path).toBe(join(resolve(elsewhere), 'later'));
    expect(((await (await call(h, '/hub/api/workspaces')).json()) as { workspaces: { id: string }[] }).workspaces.map((w) => w.id)).toEqual(['notes', 'later']);
  });

  it('lists folders to choose from: folders only, no links, hidden ones only if asked', async () => {
    const { h } = await ownHub();
    const base = temp('kuraa-folders-');
    mkdirSync(join(base, 'Beta'));
    mkdirSync(join(base, 'alpha'));
    mkdirSync(join(base, '.hidden'));
    writeFileSync(join(base, 'file.md'), '');
    const outside = temp('kuraa-outside-');
    symlinkSync(outside, join(base, 'link'));
    const list = async (q: string) => (await (await call(h, `/hub/api/folders${q}`)).json()) as { path: string; parent: string | null; home: string; folders: { name: string; path: string }[] };
    const here = await list(`?path=${encodeURIComponent(base)}`);
    expect(here.folders).toEqual([{ name: 'alpha', path: join(base, 'alpha') }, { name: 'Beta', path: join(base, 'Beta') }]);
    expect(here.parent).toBe(join(base, '..'));
    expect((await list(`?path=${encodeURIComponent(base)}&hidden=1`)).folders.map((f) => f.name)).toEqual(['.hidden', 'alpha', 'Beta']);
    // Starting at home.
    const home = await list('');
    expect(home.path).toBe(home.home);
    // Not into a link, nor a relative path.
    expect((await call(h, `/hub/api/folders?path=${encodeURIComponent(join(base, 'link'))}`)).status).toBe(400);
    expect((await call(h, '/hub/api/folders?path=relative')).status).toBe(400);
    expect((await call(h, `/hub/api/folders?path=${encodeURIComponent(join(base, 'nowhere'))}`)).status).toBe(400);
  });

  it('opens any folder as a workspace: a repository as it is, another only once asked to make it one', async () => {
    const { h } = await ownHub();
    const plain = temp('kuraa-open-plain-');
    writeFileSync(join(plain, 'draft.md'), '# Draft\n');
    const open = (body: object) => call(h, '/hub/api/workspaces/open', { method: 'POST', body: JSON.stringify(body) });
    const asked = await open({ path: plain });
    expect(asked.status).toBe(409);
    expect(await asked.json()).toMatchObject({ notRepository: { name: plain.split('/').pop(), path: plain, entries: 1 } });
    expect(existsSync(join(plain, '.git'))).toBe(false);
    const made = await open({ path: plain, init: true });
    expect(made.status).toBe(201);
    expect(((await made.json()) as { workspace: { path: string } }).workspace.path).toBe(plain);
    expect(git(plain, 'log', '--format=%s')).toBe('Initialise workspace');

    const repo = temp('kuraa-open-repo-');
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, '-c', 'user.name=A', '-c', 'user.email=a@example.org', 'commit', '-q', '--allow-empty', '-m', 'Mine');
    const r = await open({ path: join(repo) });
    expect(r.status).toBe(201);
    expect(git(repo, 'log', '--format=%s')).toBe('Mine');
    expect((await open({ path: join(repo, 'nowhere') })).status).toBe(400);
    expect((await open({ path: 'relative' })).status).toBe(400);
  });
});

describe('pnpm host', () => {
  it('with no folder flags serves your workspaces, in the settings’ folder for them, its list beside the settings', async () => {
    const base = temp('kuraa-cli-');
    const root = join(base, 'my workspaces');
    const settings = join(base, 'app', 'settings.json');
    mkdirSync(join(base, 'app'));
    writeFileSync(settings, JSON.stringify({ workspaces: root, runCode: false }));
    const child = spawn(join(import.meta.dirname, '../../../node_modules/.bin/tsx'), ['packages/host/src/cli.ts', '--settings', settings, '--port', '0', '--token', 'cli-token'], {
      cwd: join(import.meta.dirname, '../../..'),
      env: { ...process.env },
    });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    try {
      await until(() => /url: +http/.test(out), 30_000, 'the host to start');
      expect(out).toContain(`workspaces: ${root}`);
      const url = /url: +(\S+)/.exec(out)![1]!;
      const res = await fetch(`${url}/hub/api/workspaces`, { headers: { authorization: 'Bearer cli-token', 'content-type': 'application/json' } });
      expect(await res.json()).toMatchObject({ canAdd: true, canOpenFolder: true, canChangeSettings: true });
      const made = await fetch(`${url}/hub/api/workspaces`, { method: 'POST', body: JSON.stringify({ kind: 'new', name: 'Thesis' }), headers: { authorization: 'Bearer cli-token', 'content-type': 'application/json' } });
      expect(made.status).toBe(201);
      expect(existsSync(join(root, 'thesis', '.git'))).toBe(true);
      expect(existsSync(join(base, 'app', 'host-workspaces.json'))).toBe(true);
      const view = (await (await fetch(`${url}/hub/api/settings`, { headers: { authorization: 'Bearer cli-token' } })).json()) as { settings: { runCode: boolean }; fromFlags: string[] };
      expect(view.settings.runCode).toBe(false);
      expect(view.fromFlags).toEqual([]);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.once('exit', r));
    }
  });

  it('refuses the flags that are gone, saying why', () => {
    const r = (() => {
      try {
        execFileSync(join(import.meta.dirname, '../../../node_modules/.bin/tsx'), ['packages/host/src/cli.ts', '--manage-person'], { cwd: join(import.meta.dirname, '../../..'), encoding: 'utf8', stdio: 'pipe' });
        return '';
      } catch (e) {
        return String((e as { stderr: string }).stderr);
      }
    })();
    expect(r).toContain('--manage-person is no longer needed');
  });
});
