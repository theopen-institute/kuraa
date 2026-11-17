// Run plugins: loading, the version check, choosing an environment, and what a
// workspace may ask for. Uses a plugin from outside the packages (fixtures/).
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord } from '@kuraa/session/model';
import { startHost, type RunningHost, type RunOptions } from '../src/index.js';

const PLUGIN = join(import.meta.dirname, 'fixtures/echo-plugin.mjs');
const OLD = join(import.meta.dirname, 'fixtures/old-plugin.mjs');
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
  it('loads a plugin by path, and runs its engine in the default environment', async () => {
    await host({ engines: ['echo'], environments: ['fake-a', 'fake-b'], plugins: [PLUGIN] });
    const ws = (await (await api('/api/workspace')).json()) as { run: { enabled: boolean; engines: { id: string }[]; environment: { id: string; available: boolean } } };
    expect(ws.run).toMatchObject({ enabled: true, engines: [{ id: 'echo', label: 'Echo', handles: ['echo'] }], environment: { id: 'fake-a', sandboxed: true, available: true } });
    expect(await echo()).toEqual({ status: 202, text: 'hello (fake-a, workspace read-only, network false; asked null)' });
  });

  it('gives a workspace the environment it asks for only if the operator allows it', async () => {
    await host({ engines: ['echo'], environments: ['fake-a', 'fake-b'], plugins: [PLUGIN] }, { environment: 'fake-b', echo: { image: 'x' } });
    expect((await echo()).text).toBe('hello (fake-b, workspace read-only, network false; asked {"image":"x"})');
    await running!.close();
    running = await startHost({ dir, port: 0, run: { engines: ['echo'], environments: ['fake-a'], plugins: [PLUGIN] } });
    // fake-b is not allowed here: the operator's default, never the workspace's pick.
    expect((await echo()).text).toContain('(fake-a,');
  });

  it('grants a workspace more access only where the operator allows it', async () => {
    const asks = { access: { workspace: 'read-write', network: true } };
    await host({ engines: ['echo'], environments: ['fake-a'], plugins: [PLUGIN] }, asks);
    expect((await echo()).text).toContain('workspace read-only, network false');
    await running!.close();
    running = await startHost({ dir, port: 0, run: { engines: ['echo'], environments: ['fake-a'], plugins: [PLUGIN], allowWorkspaceWrite: true } });
    expect((await echo()).text).toContain('workspace read-write, network false');
  });

  it('does not run when the environment is unavailable, and says why', async () => {
    await host({ engines: ['echo'], environments: ['fake-down'], plugins: [PLUGIN] });
    const ws = (await (await api('/api/workspace')).json()) as { run: { environment: { available: boolean; message: string } } };
    expect(ws.run.environment).toMatchObject({ available: false, message: 'fake-down is switched off' });
    expect(await echo()).toEqual({ status: 503, text: 'fake-down is switched off' });
  });

  it('is off without engines or environments, and refuses chunks no engine runs', async () => {
    await host(undefined);
    expect(((await (await api('/api/workspace')).json()) as { run: { enabled: boolean } }).run.enabled).toBe(false);
    expect((await echo()).status).toBe(403);
    await running!.close();
    running = await startHost({ dir, port: 0, run: { engines: ['r'], environments: ['local'] } });
    expect(await echo()).toEqual({ status: 400, text: 'Nothing on this host runs echo chunks.' });
  });

  it('refuses plugins for another version of the API, and unknown ids', async () => {
    await expect(startHost({ dir: repo(), port: 0, run: { engines: ['r'], environments: ['local'], plugins: [OLD] } }))
      .rejects.toThrow('was written for version 0 of the run plugin API; this host speaks version 1');
    await expect(startHost({ dir, port: 0, run: { engines: ['python'], environments: ['local'] } })).rejects.toThrow('Unknown engine "python". Known: r.');
    await expect(startHost({ dir, port: 0, run: { engines: ['r'], environments: ['docker'] } })).rejects.toThrow('Unknown environment "docker". Known: local, podman.');
  });
});
