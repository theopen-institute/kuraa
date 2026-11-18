// Run plugins: engines and environments as separate plugins meeting only
// through the run-kit contract; loading, the version check, choosing where
// code runs, unsandboxed environments, and what a workspace may ask for. Uses
// plugins from outside the packages (fixtures/), which start no real process.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord } from '@kuraa/session/model';
import { definePlugin } from '@kuraa/run-kit';
import { standardRunPlugins } from '@kuraa/run-plugins';
import { startHost, type RunningHost, type RunOptions } from '../src/index.js';

const ECHO = join(import.meta.dirname, 'fixtures/echo-engine.mjs');
const ENVS = join(import.meta.dirname, 'fixtures/environments.mjs');
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
  it('an engine and an environment from separate plugins meet through the contract', async () => {
    await host({ engines: ['echo'], environment: 'fake', plugins: [ECHO, ENVS] }, { environment: 'bare', echo: { image: 'x' } });
    const ws = (await (await api('/api/workspace')).json()) as { run: unknown };
    expect(ws.run).toMatchObject({ enabled: true, engines: [{ id: 'echo', label: 'Echo', handles: ['echo'] }], environment: { id: 'fake', sandboxed: true, available: true } });
    // The workspace asked for another environment: it does not choose; the operator did.
    expect(await echo()).toEqual({ status: 202, text: 'echo hello [in fake, cwd /work, workspace read-only, network false] (asked {"image":"x"})' });
  });

  it('runs in the only environment loaded; with several, the operator chooses', async () => {
    await host({ engines: ['echo'], plugins: [ECHO, ...standardRunPlugins] });
    expect(((await (await api('/api/workspace')).json()) as { run: { environment: { id: string } } }).run.environment.id).toBe('podman');
    await expect(startHost({ dir, port: 0, run: { engines: ['echo'], plugins: [ECHO, ENVS] } }))
      .rejects.toThrow('Several environments are loaded (fake, bare, down); choose one with --env.');
    await expect(startHost({ dir, port: 0, run: { engines: ['echo'], plugins: [ECHO] } }))
      .rejects.toThrow('no environment to run code in is loaded');
  });

  it('uses an environment that is not sandboxed only if the operator allows it', async () => {
    await expect(startHost({ dir: repo(), port: 0, run: { engines: ['echo'], environment: 'bare', plugins: [ECHO, ENVS] } }))
      .rejects.toThrow('The environment "bare" is not sandboxed: code would run in bare with whatever rights it has there. Use it only with --allow-unsandboxed.');
    running = await startHost({ dir, port: 0, run: { engines: ['echo'], environment: 'bare', plugins: [ECHO, ENVS], allowUnsandboxed: true } });
    expect(((await (await api('/api/workspace')).json()) as { run: { environment: { sandboxed: boolean } } }).run.environment.sandboxed).toBe(false);
    expect((await echo()).text).toContain('[in bare,');
  });

  it('grants a workspace more access only where the operator allows it', async () => {
    const asks = { access: { workspace: 'read-write', network: true } };
    await host({ engines: ['echo'], environment: 'fake', plugins: [ECHO, ENVS] }, asks);
    expect((await echo()).text).toContain('workspace read-only, network false');
    await running!.close();
    running = await startHost({ dir, port: 0, run: { engines: ['echo'], environment: 'fake', plugins: [ECHO, ENVS], allowWorkspaceWrite: true } });
    expect((await echo()).text).toContain('workspace read-write, network false');
  });

  it('does not run when the environment is unavailable, and says why', async () => {
    await host({ engines: ['echo'], environment: 'down', plugins: [ECHO, ENVS] });
    const ws = (await (await api('/api/workspace')).json()) as { run: { environment: unknown } };
    expect(ws.run.environment).toMatchObject({ available: false, message: 'down is switched off' });
    expect(await echo()).toEqual({ status: 503, text: 'down is switched off' });
  });

  it('is off without engines, refuses chunks no engine runs, and loads no plugins of its own', async () => {
    await host(undefined);
    expect(((await (await api('/api/workspace')).json()) as { run: { enabled: boolean } }).run.enabled).toBe(false);
    expect((await echo()).status).toBe(403);
    await running!.close();
    await expect(startHost({ dir, port: 0, run: { engines: ['r'] } })).rejects.toThrow('Unknown engine "r". Known: none.');
    running = await startHost({ dir, port: 0, run: { engines: ['r'], plugins: standardRunPlugins } });
    expect(await echo()).toEqual({ status: 400, text: 'Nothing on this host runs echo chunks.' });
  });

  it('refuses plugins for another version of the API, unknown ids, and environments that do not say if they are sandboxed', async () => {
    await expect(startHost({ dir: repo(), port: 0, run: { engines: ['r'], plugins: [...standardRunPlugins, OLD] } }))
      .rejects.toThrow('was written for version 0 of the run plugin API; this host speaks version 1');
    await expect(startHost({ dir, port: 0, run: { engines: ['python'], plugins: standardRunPlugins } })).rejects.toThrow('Unknown engine "python". Known: r.');
    await expect(startHost({ dir, port: 0, run: { engines: ['r'], environment: 'docker', plugins: standardRunPlugins } })).rejects.toThrow('Unknown environment "docker". Known: podman.');
    const vague = definePlugin({ name: 'vague', environments: [{ id: 'vague', label: 'somewhere', check: async () => ({ available: true, message: '' }), start: async () => { throw new Error('no'); } } as never] });
    await expect(startHost({ dir, port: 0, run: { engines: [], plugins: [vague] } })).rejects.toThrow('vague: the environment "vague" must say whether it is sandboxed.');
  });
});

describe('formats', () => {
  it('only those the host turns on; a file whose format is off opens as text; the app can only look', async () => {
    running = await startHost({ dir: repo(), port: 0, formats: ['pandoc-markdown', 'text'] });
    const tree = (await (await api('/api/tree')).json()) as { files: { path: string; type: string }[] };
    expect(tree.files).toContainEqual({ path: 'doc.Rmd', type: 'text' });
    const ws = (await (await api('/api/workspace')).json()) as { types: { id: string }[] };
    expect(ws.types.map((t) => t.id)).toEqual(['pandoc-markdown', 'text']);
    const p = (await (await api('/api/plugins')).json()) as { formats: { id: string; on: boolean }[]; environments: unknown[] };
    expect(p.formats.map((f) => [f.id, f.on])).toEqual([['pandoc-markdown', true], ['rmarkdown', false], ['text', true]]);
    expect(p.environments).toEqual([]); // no run plugins loaded
    // Nothing about the host changes from the app.
    for (const method of ['PUT', 'POST', 'PATCH']) {
      expect((await api('/api/plugins', { method, body: JSON.stringify({ formats: { rmarkdown: true } }) })).status).toBe(404);
    }
    await expect(startHost({ dir, port: 0, formats: ['asciidoc'] })).rejects.toThrow('Unknown format "asciidoc". Known: pandoc-markdown, rmarkdown, text.');
  });
});
