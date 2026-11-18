// Run plugins: loading, the version check, the sandbox every engine runs in,
// and what a workspace may ask for. Uses plugins from outside the packages
// (fixtures/). The engine starts no process, but runs only where Podman does.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord } from '@kuraa/session/model';
import { podmanWorks } from '@kuraa/env-podman';
import { startHost, type RunningHost, type RunOptions } from '../src/index.js';

const PLUGIN = join(import.meta.dirname, 'fixtures/echo-plugin.mjs');
const OLD = join(import.meta.dirname, 'fixtures/old-plugin.mjs');
const ENV = join(import.meta.dirname, 'fixtures/env-plugin.mjs');
const PODMAN_OK = podmanWorks();
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

let dir = '';
let running: RunningHost | null = null;

function repo(runJson?: object): string {
  dir = mkdtempSync(join(tmpdir(), 'kuraa-plugins-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'user.email', 't@example.org');
  writeFileSync(join(dir, 'doc.Rmd'), '# Doc\n\n```{echo}\nhello\n```\n');
  if (runJson) {
    mkdirSync(join(dir, '.kuraa'));
    writeFileSync(join(dir, '.kuraa/run.json'), JSON.stringify(runJson));
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  return dir;
}

async function host(run: RunOptions | undefined, runJson?: object): Promise<RunningHost> {
  running = await startHost({ dir: repo(runJson), port: 0, run });
  return running;
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(running!.url + path, { ...init, headers: { authorization: `Bearer ${running!.token}`, 'content-type': 'application/json' } });

async function echo(code = 'hello'): Promise<{ status: number; text: string }> {
  const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ path: 'doc.Rmd', engine: 'echo', code, chunk: { label: null, index: 0, codeHash: code } }) });
  if (res.status !== 202) return { status: res.status, text: ((await res.json()) as { error: string }).error };
  const { id } = (await res.json()) as RunRecord;
  for (let i = 0; i < 100; i++) {
    const { runs } = (await (await api('/api/runs?path=doc.Rmd')).json()) as { runs: RunRecord[] };
    const done = runs.find((r) => r.id === id);
    if (done) return { status: 202, text: done.outputs.map((o) => ('text' in o ? o.text : '')).join('') };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('run did not finish');
}

afterEach(async () => {
  await running?.close().catch(() => undefined);
  running = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('run plugins', () => {
  it.skipIf(!PODMAN_OK)('loads a plugin by path, and runs its engine in the sandbox, whatever the workspace asks', async () => {
    await host({ engines: ['echo'], plugins: [PLUGIN] }, { environment: 'local', echo: { image: 'x' } });
    const ws = (await (await api('/api/workspace')).json()) as { run: unknown };
    expect(ws.run).toMatchObject({ enabled: true, engines: [{ id: 'echo', label: 'Echo', handles: ['echo'] }], environment: { id: 'podman', available: true } });
    expect(await echo()).toEqual({ status: 202, text: 'hello (podman, workspace read-only, network false; asked {"image":"x"})' });
  });

  it.skipIf(!PODMAN_OK)('grants a workspace more access only where the operator allows it', async () => {
    const asks = { access: { workspace: 'read-write', network: true } };
    await host({ engines: ['echo'], plugins: [PLUGIN] }, asks);
    expect((await echo()).text).toContain('workspace read-only, network false');
    await running!.close();
    running = await startHost({ dir, port: 0, run: { engines: ['echo'], plugins: [PLUGIN], allowWorkspaceWrite: true } });
    expect((await echo()).text).toContain('workspace read-write, network false');
  });

  it('does not run when the sandbox is unavailable, and says why', async () => {
    await host({ engines: ['echo'], plugins: [PLUGIN], options: { podman: { podman: '/nonexistent/podman' } } });
    const ws = (await (await api('/api/workspace')).json()) as { run: { environment: { available: boolean; message: string } } };
    expect(ws.run.environment).toMatchObject({ available: false, message: expect.stringContaining('Podman is not installed') });
    expect(await echo()).toMatchObject({ status: 503, text: expect.stringContaining('Podman is not installed') });
  });

  it('is off without engines, and refuses chunks no engine runs', async () => {
    await host(undefined);
    expect(((await (await api('/api/workspace')).json()) as { run: { enabled: boolean } }).run.enabled).toBe(false);
    expect((await echo()).status).toBe(403);
    await running!.close();
    running = await startHost({ dir, port: 0, run: { engines: ['r'] } });
    expect(await echo()).toEqual({ status: 400, text: 'Nothing on this host runs echo chunks.' });
  });

  it('refuses plugins for another version of the API, unknown engines, and plugins that bring places to run', async () => {
    await expect(startHost({ dir: repo(), port: 0, run: { engines: ['r'], plugins: [OLD] } }))
      .rejects.toThrow('was written for version 0 of the run plugin API; this host speaks version 1');
    await expect(startHost({ dir, port: 0, run: { engines: ['python'] } })).rejects.toThrow('Unknown engine "python". Known: r.');
    await expect(startHost({ dir, port: 0, run: { engines: ['r'], plugins: [ENV] } })).rejects.toThrow(/brings environments of its own.*only in the host's Podman sandbox/);
  });
});

describe('formats', () => {
  it('only those the host turns on; a file whose format is off opens as text; the app can only look', async () => {
    running = await startHost({ dir: repo(), port: 0, formats: ['pandoc-markdown', 'text'] });
    const tree = (await (await api('/api/tree')).json()) as { files: { path: string; type: string }[] };
    expect(tree.files).toContainEqual({ path: 'doc.Rmd', type: 'text' });
    const ws = (await (await api('/api/workspace')).json()) as { types: { id: string }[] };
    expect(ws.types.map((t) => t.id)).toEqual(['pandoc-markdown', 'text']);
    const p = (await (await api('/api/plugins')).json()) as { formats: { id: string; on: boolean }[]; environment: { id: string } };
    expect(p.formats.map((f) => [f.id, f.on])).toEqual([['pandoc-markdown', true], ['rmarkdown', false], ['text', true]]);
    expect(p.environment.id).toBe('podman');
    // Nothing about the host changes from the app.
    for (const method of ['PUT', 'POST', 'PATCH']) {
      expect((await api('/api/plugins', { method, body: JSON.stringify({ formats: { rmarkdown: true } }) })).status).toBe(404);
    }
    await expect(startHost({ dir, port: 0, formats: ['asciidoc'] })).rejects.toThrow('Unknown format "asciidoc". Known: pandoc-markdown, rmarkdown, text.');
  });
});
