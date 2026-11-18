// Running R chunks through a real host, in real Podman containers. Skipped
// unless Podman is installed and running; the first run builds the R image,
// which takes a few minutes.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashText } from '@kuraa/kernel';
import { rmarkdown } from '@kuraa/format-rmarkdown';
import { connectHeadless } from '@kuraa/session/testing';
import type { ChunkOutput, RunRecord } from '@kuraa/session/model';
import { startHost, type RunningHost } from '../src/index.js';
import { podmanWorks } from '@kuraa/env-podman';

const PODMAN_OK = podmanWorks();
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const DOC = 'reports/analysis.Rmd';

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-run-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Test Host');
  git(dir, 'config', 'user.email', 'host@example.org');
  mkdirSync(join(dir, 'reports'));
  writeFileSync(join(dir, DOC), '# Analysis\n\n```{r setup}\nx <- 1\n```\n');
  writeFileSync(join(dir, 'reports/data.csv'), 'a,b\n1,2\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  return dir;
}

describe.skipIf(!PODMAN_OK)('running R chunks', () => {
  let dir: string;
  let running: RunningHost;
  let index = 0;

  const api = (path: string, init: RequestInit = {}) =>
    fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' } });

  /** Start a run and wait until it has finished. */
  async function run(code: string, header = 'r', label: string | null = null): Promise<RunRecord> {
    const res = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ path: DOC, engine: 'r', code, header, chunk: { label, index: index++, codeHash: hashText(code) }, by: { name: 'Ada', color: '#123456' } }),
    });
    expect(res.status).toBe(202);
    const { id } = (await res.json()) as RunRecord;
    return waitFor(id);
  }

  async function waitFor(id: string, ms = 30_000): Promise<RunRecord> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const { runs } = (await (await api(`/api/runs?path=${encodeURIComponent(DOC)}`)).json()) as { runs: RunRecord[] };
      const r = runs.find((x) => x.id === id);
      if (r) return r;
      await new Promise((r) => setTimeout(r, 50));
    }
    throw new Error(`run ${id} did not finish`);
  }

  const kinds = (o: ChunkOutput[]) => o.map((x) => x.type);
  const text = (o: ChunkOutput[]) => o.filter((x) => 'text' in x).map((x) => (x as { text: string }).text).join('');

  beforeEach(async () => {
    dir = makeRepo();
    index = 0;
    running = await startHost({ dir, port: 0, run: { engines: ['r'] }, timings: { flushMs: 150, idleCommitMs: 600, maxCommitMs: 5000, dropMs: 400 } });
  });

  afterEach(async () => {
    await running.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  it('runs code in order: text, messages, warnings, tables and plots', async () => {
    const r = await run([
      'x <- 21',
      'print(x * 2)',
      'message("note")',
      'warning("careful")',
      'data.frame(a = 1:3, b = c("x", "y", NA))',
      'plot(1:10)',
      'lines(1:10)',
      'invisible(7)',
    ].join('\n'));
    expect(r.state).toBe('done');
    expect(kinds(r.outputs)).toEqual(['text', 'message', 'warning', 'table', 'image']);
    expect(r.outputs[0]).toEqual({ type: 'text', text: '[1] 42\n' });
    expect(r.outputs[1]).toEqual({ type: 'message', text: 'note\n' });
    expect(r.outputs[2]).toMatchObject({ type: 'warning', text: 'Warning: careful' });
    expect(r.outputs[3]).toMatchObject({ type: 'table', columns: ['a', 'b'], types: ['integer', 'character'], data: [['1', '2', '3'], ['x', 'y', 'NA']], nrow: 3, ncol: 2 });
    // plot() and lines() make one figure, 7 x 5 inches by default.
    const img = r.outputs[4] as Extract<ChunkOutput, { type: 'image' }>;
    expect(img).toMatchObject({ mime: 'image/png', width: 672, height: 480 });
    expect(Buffer.from(img.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    expect(r.by.name).toBe('Ada');
    expect(r.ms).toBeGreaterThan(0);
  }, 60_000);

  it('keeps state between runs, runs in the document folder, and honours chunk options', async () => {
    await run('x <- 21');
    expect(text((await run('x')).outputs)).toBe('[1] 21\n');
    expect(text((await run('file.exists("data.csv")')).outputs)).toBe('[1] TRUE\n');
    expect(text((await run('x', 'r skipped, eval = FALSE')).outputs)).toMatch(/eval = FALSE/);
    const fig = await run('plot(1)', 'r small, fig.width = 4, fig.height = 3');
    expect(fig.outputs[0]).toMatchObject({ type: 'image', width: 384, height: 288 });
  }, 60_000);

  it('stops a chunk at its first error', async () => {
    const r = await run('stop("boom")\nprint("not reached")');
    expect(r.state).toBe('failed');
    expect(kinds(r.outputs)).toEqual(['error']);
    expect(text(r.outputs)).toContain('boom');
  }, 60_000);

  it('interrupts a long run, cancels what was queued, and the session survives', async () => {
    await run('kept <- "still here"');
    const post = (code: string) => api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ path: DOC, engine: 'r', code, chunk: { label: null, index: index++, codeHash: hashText(code) } }),
    }).then((res) => res.json() as Promise<RunRecord>);
    const long = await post('Sys.sleep(30)');
    const queued = await post('1 + 1');
    await new Promise((r) => setTimeout(r, 1000));
    await api('/api/runs/interrupt', { method: 'POST', body: JSON.stringify({ path: DOC }) });
    const interrupted = await waitFor(long.id);
    expect(interrupted.state, JSON.stringify(interrupted.outputs)).toBe('interrupted');
    expect(interrupted.ms).toBeLessThan(10_000);
    const { runs } = (await (await api(`/api/runs?path=${encodeURIComponent(DOC)}`)).json()) as { runs: RunRecord[] };
    expect(runs.find((x) => x.id === queued.id)).toBeUndefined(); // cancelled runs are not kept
    expect(text((await run('kept')).outputs)).toBe('[1] "still here"\n');
  }, 60_000);

  it('restarts with an empty session', async () => {
    await run('x <- 1');
    await api('/api/runs/restart', { method: 'POST', body: JSON.stringify({ path: DOC }) });
    expect(text((await run('exists("x")')).outputs)).toBe('[1] FALSE\n');
  }, 60_000);

  it('tells everyone with the document open, and keeps the latest output per chunk across restarts', async () => {
    const { room } = (await (await api(`/api/rooms?path=${encodeURIComponent(DOC)}`)).json()) as { room: string };
    const c = connectHeadless({ url: running.url.replace(/^http/, 'ws') + '/collab', room, token: running.token, user: { name: 'Bo', email: 'bo@example.org', color: '#333' }, schema: rmarkdown.schema });
    await c.ready;
    try {
      await run('1', 'r first', 'first');
      const second = await run('2', 'r first', 'first');
      await new Promise((r) => setTimeout(r, 200));
      const states = c.messages.filter((m) => m.type === 'run').map((m) => (m as { run: RunRecord }).run.state);
      expect(states).toEqual(['queued', 'running', 'done', 'queued', 'running', 'done']);
      expect(c.messages.some((m) => m.type === 'run-session' && m.session.state === 'ready' && m.session.engine === 'r' && m.session.environment === 'podman')).toBe(true);

      await running.close();
      running = await startHost({ dir, port: 0, run: { engines: ['r'] } });
      const { runs } = (await (await api(`/api/runs?path=${encodeURIComponent(DOC)}`)).json()) as { runs: RunRecord[] };
      expect(runs.map((r) => r.id)).toEqual([second.id]); // the same label replaced the earlier run
      expect(git(dir, 'status', '--porcelain')).toBe(''); // nothing written into the workspace
    } finally {
      c.destroy();
    }
  }, 60_000);

  it('refuses to run unless the host allows it', async () => {
    await running.close();
    running = await startHost({ dir, port: 0 });
    const ws = (await (await api('/api/workspace')).json()) as { run: { enabled: boolean } };
    expect(ws.run.enabled).toBe(false);
    const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ path: DOC, engine: 'r', code: '1', chunk: { index: 0, codeHash: 'x' } }) });
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!PODMAN_OK)('the sandbox', () => {
  it('runs R where it cannot see your files, write the workspace, see .git, or reach the network', async () => {
    const dir = makeRepo();
    const running = await startHost({ dir, port: 0, run: { engines: ['r'] } });
    try {
      const api = (path: string, init: RequestInit = {}) =>
        fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' } });
      const run = async (code: string): Promise<string> => {
        const res = await api('/api/runs', { method: 'POST', body: JSON.stringify({ path: DOC, engine: 'r', code, chunk: { label: null, index: 0, codeHash: hashText(code) } }) });
        const { id } = (await res.json()) as RunRecord;
        for (let i = 0; i < 9000; i++) {
          const { runs } = (await (await api(`/api/runs?path=${encodeURIComponent(DOC)}`)).json()) as { runs: RunRecord[] };
          const r = runs.find((x) => x.id === id);
          if (r) return r.outputs.map((o) => ('text' in o ? o.text : `[${o.type}]`)).join('');
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error('timed out');
      };
      expect(await run('x <- 21; x * 2')).toBe('[1] 42\n');
      expect(await run('file.exists("data.csv")')).toBe('[1] TRUE\n'); // the document's folder
      expect(await run('dir.exists("/Users") || dir.exists("/home/runner")')).toBe('[1] FALSE\n');
      expect(await run('tryCatch({ writeLines("x", "new.txt"); "wrote" }, error = function(e) "denied", warning = function(w) "denied")')).toBe('[1] "denied"\n');
      expect(await run('tryCatch(length(list.files("../.git")), error = function(e) 0L, warning = function(w) 0L)')).toBe('[1] 0\n');
      expect(await run('tryCatch({ readLines(url("http://example.org")); "reached" }, error = function(e) "no network", warning = function(w) "no network")')).toBe('[1] "no network"\n');
      expect(await run('plot(1)')).toBe('[image]');
    } finally {
      await running.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15 * 60_000);
});

describe.skipIf(!PODMAN_OK)('R packages in Podman', () => {
  it('installs through a separate container, and sessions see the library read-only', async () => {
    const dir = makeRepo();
    const dataDir = mkdtempSync(join(tmpdir(), 'kuraa-poddata-'));
    const running = await startHost({ dir, port: 0, run: { engines: ['r'], allowInstalls: true, dataDir } });
    try {
      const api = (path: string, body?: object) => fetch(running.url + path, {
        method: body ? 'POST' : 'GET',
        headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      }).then((r) => r.json() as Promise<Record<string, unknown>>);
      const run = async (code: string): Promise<string> => {
        const { id } = await api('/api/runs', { path: DOC, engine: 'r', code, chunk: { label: null, index: 0, codeHash: hashText(code) } });
        for (let i = 0; i < 9000; i++) {
          const r = ((await api(`/api/runs?path=${encodeURIComponent(DOC)}`)).runs as RunRecord[]).find((x) => x.id === id);
          if (r) return r.outputs.map((o) => ('text' in o ? o.text : `[${o.type}]`)).join('');
          await new Promise((res) => setTimeout(res, 100));
        }
        throw new Error('timed out');
      };
      // The starter set: the tidyverse is in the environment.
      expect(await run('suppressPackageStartupMessages(library(dplyr)); nrow(filter(mtcars, cyl == 4))')).toBe('[1] 11\n');
      // install.packages() in a chunk: the installer has the network; the session does not.
      expect(await run('install.packages("hellno"); suppressPackageStartupMessages(library(hellno)); "ok"')).toContain('[1] "ok"');
      expect(await run('tryCatch({ readLines(url("http://example.org")); "reached" }, error = function(e) "no network", warning = function(w) "no network")')).toBe('[1] "no network"\n');
      // The library is read-only here: code cannot change packages behind the host's back.
      expect(await run('lib <- .libPaths()[1]; tryCatch({ writeLines("x", file.path(lib, "planted")); "wrote" }, error = function(e) "denied", warning = function(w) "denied")')).toBe('[1] "denied"\n');
      const manifest = JSON.parse(readFileSync(join(dir, '.kuraa/r-packages.json'), 'utf8'));
      expect(Object.keys(manifest.packages)).toContain('hellno');
      expect(manifest.environment).toHaveProperty('dplyr');

      // Already in the environment: says so at once, and does not reinstall it.
      const tidy = await api('/api/packages/install', { engine: 'r', refs: ['tidyverse'] });
      expect(String(tidy.message)).toMatch(/^Already available: tidyverse \d/);

      // A package whose system libraries the image lacks: they are added, the image is
      // rebuilt, the package installed; after a restart, R loads it.
      const pdf = await api('/api/packages/install', { engine: 'r', refs: ['pdftools'] });
      expect(pdf).toMatchObject({ ok: true, restart: true });
      expect(JSON.parse(readFileSync(join(dir, '.kuraa/r-packages.json'), 'utf8')).system).toContain('libpoppler-cpp-dev');
      await api('/api/runs/restart', { path: DOC });
      expect(await run('suppressPackageStartupMessages(library(pdftools)); is.function(pdf_text)')).toBe('[1] TRUE\n');
    } finally {
      await running.close();
      rmSync(dir, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true, maxRetries: 5 });
    }
  }, 30 * 60_000);
});
