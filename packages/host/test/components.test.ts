// Run components: engines and environments as separate components meeting only
// through the run-kit contract; loading, the version check, choosing where
// code runs, unsandboxed environments, and what a workspace may ask for. Uses
// components from outside the packages (fixtures/), which start no real process.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord, RunSessionInfo } from '@kuraa/session/model';
import { defineRunComponent } from '@kuraa/run-kit';
import { standardRunComponents } from '@kuraa/run-components';
import { startHost, type RunningHost, type RunOptions } from '../src/index.js';

const ECHO = join(import.meta.dirname, 'fixtures/echo-engine.mjs');
const ENVS = join(import.meta.dirname, 'fixtures/environments.mjs');
const OLD = join(import.meta.dirname, 'fixtures/old-component.mjs');
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

let dir = '';
let running: RunningHost | null = null;

function repo(runJson?: object): string {
  dir = mkdtempSync(join(tmpdir(), 'kuraa-components-'));
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

describe('run components', () => {
  it('an engine and an environment from separate components meet through the contract', async () => {
    await host({ engines: ['echo'], environment: 'fake', components: [ECHO, ENVS] }, { environment: 'bare', echo: { image: 'x' } });
    const ws = (await (await api('/api/workspace')).json()) as { run: unknown };
    expect(ws.run).toMatchObject({ enabled: true, engines: [{ id: 'echo', label: 'Echo', handles: ['echo'] }], environment: { id: 'fake', sandboxed: true, available: true } });
    // The workspace asked for another environment: it does not choose; the operator did.
    expect(await echo()).toEqual({ status: 202, text: 'echo hello [in fake, cwd /work, workspace read-only, network false] (asked {"image":"x"})' });
  });

  it('runs in the only environment loaded; with several, the operator chooses', async () => {
    await host({ engines: ['echo'], components: [ECHO, ...standardRunComponents] });
    expect(((await (await api('/api/workspace')).json()) as { run: { environment: { id: string } } }).run.environment.id).toBe('podman');
    await expect(startHost({ dir, port: 0, run: { engines: ['echo'], components: [ECHO, ENVS] } }))
      .rejects.toThrow('Several environments are loaded (fake, bare, down); choose one with --env.');
    await expect(startHost({ dir, port: 0, run: { engines: ['echo'], components: [ECHO] } }))
      .rejects.toThrow('no environment to run code in is loaded');
  });

  it('uses an environment that is not sandboxed only if the operator allows it', async () => {
    await expect(startHost({ dir: repo(), port: 0, run: { engines: ['echo'], environment: 'bare', components: [ECHO, ENVS] } }))
      .rejects.toThrow('The environment "bare" is not sandboxed: code would run in bare with whatever rights it has there. Use it only with --allow-unsandboxed.');
    running = await startHost({ dir, port: 0, run: { engines: ['echo'], environment: 'bare', components: [ECHO, ENVS], allowUnsandboxed: true } });
    expect(((await (await api('/api/workspace')).json()) as { run: { environment: { sandboxed: boolean } } }).run.environment.sandboxed).toBe(false);
    expect((await echo()).text).toContain('[in bare,');
  });

  it('grants a workspace more access only where the operator allows it', async () => {
    const asks = { access: { workspace: 'read-write', network: true } };
    await host({ engines: ['echo'], environment: 'fake', components: [ECHO, ENVS] }, asks);
    expect((await echo()).text).toContain('workspace read-only, network false');
    await running!.close();
    running = await startHost({ dir, port: 0, run: { engines: ['echo'], environment: 'fake', components: [ECHO, ENVS], allowWorkspaceWrite: true } });
    expect((await echo()).text).toContain('workspace read-write, network false');
  });

  it('does not run when the environment is unavailable, and says why', async () => {
    await host({ engines: ['echo'], environment: 'down', components: [ECHO, ENVS] });
    const ws = (await (await api('/api/workspace')).json()) as { run: { environment: unknown } };
    expect(ws.run.environment).toMatchObject({ available: false, message: 'down is switched off' });
    expect(await echo()).toEqual({ status: 503, text: 'down is switched off' });
  });

  it('is off without engines, refuses chunks no engine runs, and loads no components of its own', async () => {
    await host(undefined);
    expect(((await (await api('/api/workspace')).json()) as { run: { enabled: boolean } }).run.enabled).toBe(false);
    expect((await echo()).status).toBe(403);
    await running!.close();
    await expect(startHost({ dir, port: 0, run: { engines: ['r'] } })).rejects.toThrow('Unknown engine "r". Known: none.');
    running = await startHost({ dir, port: 0, run: { engines: ['r'], components: standardRunComponents } });
    expect(await echo()).toEqual({ status: 400, text: 'Nothing on this host runs echo chunks.' });
  });

  it('refuses components for another version of the API, unknown ids, and environments that do not say if they are sandboxed', async () => {
    await expect(startHost({ dir: repo(), port: 0, run: { engines: ['r'], components: [...standardRunComponents, OLD] } }))
      .rejects.toThrow('was written for version 0 of the run component API; this host speaks version 1');
    await expect(startHost({ dir, port: 0, run: { engines: ['python'], components: standardRunComponents } })).rejects.toThrow('Unknown engine "python". Known: r.');
    await expect(startHost({ dir, port: 0, run: { engines: ['r'], environment: 'docker', components: standardRunComponents } })).rejects.toThrow('Unknown environment "docker". Known: podman.');
    const vague = defineRunComponent({ name: 'vague', environments: [{ id: 'vague', label: 'somewhere', check: async () => ({ available: true, message: '' }), start: async () => { throw new Error('no'); } } as never] });
    await expect(startHost({ dir, port: 0, run: { engines: [], components: [vague] } })).rejects.toThrow('vague: the environment "vague" must say whether it is sandboxed.');
  });

  it('keeps what each session has run, and records it on every run', async () => {
    await host({ engines: ['echo'], environment: 'fake', components: [ECHO, ENVS] });
    const runs = async () => (await (await api('/api/runs?path=doc.Rmd')).json()) as { runs: RunRecord[]; session: RunSessionInfo };
    async function run(index: number, code: string, partial = false): Promise<RunRecord> {
      const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ path: 'doc.Rmd', engine: 'echo', code, chunk: { label: null, index, codeHash: code, partial } }) });
      const { id } = (await res.json()) as RunRecord;
      for (let i = 0; i < 100; i++) {
        const done = (await runs()).runs.find((r) => r.id === id);
        if (done) return done;
        await new Promise((r) => setTimeout(r, 20));
      }
      throw new Error('run did not finish');
    }
    const step = (index: number, codeHash: string, complete = true) => ({ label: null, index, codeHash, complete });

    const first = await run(0, 'a');
    expect(first).toMatchObject({ engine: 'echo', basis: { steps: [] } });
    const second = await run(1, 'b');
    expect(second.basis).toEqual({ session: first.basis!.session, steps: [step(0, 'a')] });
    // Running a chunk again in the same version replaces its earlier step. Part of a
    // chunk that has run in full leaves that standing; part of one that has not is not all of it.
    await run(0, 'a');
    await run(1, 'b', true);
    await run(2, 'c', true);
    expect((await runs()).session).toMatchObject({ id: first.basis!.session, state: 'ready', steps: [step(1, 'b'), step(0, 'a'), step(2, 'c', false)] });

    // A fresh session has run nothing.
    await api('/api/runs/restart', { method: 'POST', body: JSON.stringify({ path: 'doc.Rmd' }) });
    expect((await runs()).session).toMatchObject({ id: null, state: 'none', steps: [] });
    const after = await run(1, 'b');
    expect(after.basis!.steps).toEqual([]);
    expect(after.basis!.session).not.toBe(first.basis!.session);
  });
});

describe('formats', () => {
  it('only those the host turns on; a file whose format is off opens as text; the app can only look', async () => {
    running = await startHost({ dir: repo(), port: 0, formats: ['pandoc-markdown', 'text'] });
    const tree = (await (await api('/api/tree')).json()) as { files: { path: string; type: string }[] };
    expect(tree.files).toContainEqual({ path: 'doc.Rmd', type: 'text' });
    const ws = (await (await api('/api/workspace')).json()) as { types: { id: string }[] };
    expect(ws.types.map((t) => t.id)).toEqual(['pandoc-markdown', 'text']);
    const p = (await (await api('/api/components')).json()) as { formats: { id: string; on: boolean }[]; environments: unknown[] };
    expect(p.formats.map((f) => [f.id, f.on])).toEqual([['pandoc-markdown', true], ['rmarkdown', false], ['text', true]]);
    expect(p.environments).toEqual([]); // no run components loaded
    // Nothing about the host changes from the app.
    for (const method of ['PUT', 'POST', 'PATCH']) {
      expect((await api('/api/components', { method, body: JSON.stringify({ formats: { rmarkdown: true } }) })).status).toBe(404);
    }
    await expect(startHost({ dir, port: 0, formats: ['asciidoc'] })).rejects.toThrow('Unknown format "asciidoc". Known: pandoc-markdown, rmarkdown, text.');
  });
});
