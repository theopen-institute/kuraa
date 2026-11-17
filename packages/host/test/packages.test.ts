// R packages per workspace, stored once per host: real installs from CRAN with
// the local environment (Podman is covered in runner.test.ts). Skipped without R,
// pak or the network. hellno: small, no dependencies, and not usually installed.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRscript } from '@kuraa/engine-r';
import type { RunRecord } from '@kuraa/session/model';
import { startHost, type RunningHost } from '../src/index.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const READY = (() => {
  const r = findRscript();
  if (!r) return false;
  try {
    execFileSync(r, ['-e', 'stopifnot(requireNamespace("pak", quietly = TRUE))'], { stdio: 'ignore' });
    execFileSync('curl', ['-sSf', '--max-time', '10', '-o', '/dev/null', 'https://cloud.r-project.org/web/packages/hellno/index.html'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!READY)('R packages', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'kuraa-rdata-'));
  const hosts: RunningHost[] = [];
  const dirs: string[] = [];

  function repo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'kuraa-pkgws-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Host');
    git(dir, 'config', 'user.email', 'host@example.org');
    writeFileSync(join(dir, 'a.Rmd'), '# A\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    dirs.push(dir);
    return dir;
  }

  async function host(dir: string, allowInstalls = true): Promise<RunningHost> {
    const h = await startHost({ dir, port: 0, run: { engines: ['r'], environments: ['local'], allowInstalls, dataDir } });
    hosts.push(h);
    return h;
  }

  const call = (h: RunningHost, path: string, body?: object) =>
    fetch(h.url + path, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${h.token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(async (res) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> }));

  async function run(h: RunningHost, code: string): Promise<string> {
    const { body } = await call(h, '/api/runs', { path: 'a.Rmd', engine: 'r', code, chunk: { label: null, index: 0, codeHash: code } });
    for (let i = 0; i < 1200; i++) {
      const runs = (await call(h, '/api/runs?path=a.Rmd')).body.runs as RunRecord[];
      const r = runs.find((x) => x.id === body.id);
      if (r) return r.outputs.map((o) => ('text' in o ? o.text : '')).join('');
      await new Promise((res) => setTimeout(res, 100));
    }
    throw new Error('timed out');
  }

  const cacheEntries = () => readdirSync(join(dataDir, 'engines/r/cache')).filter((n) => n.startsWith('hellno_'));

  beforeAll(() => undefined);
  afterAll(async () => {
    for (const h of hosts) await h.close().catch(() => undefined);
    for (const d of [...dirs, dataDir]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  });

  it('installs into the workspace, records it, and the next chunk can use it', async () => {
    const dir = repo();
    const h = await host(dir);
    const result = await call(h, '/api/packages/install', { engine: 'r', refs: ['hellno'], by: { name: 'Ada', email: 'ada@example.org' } });
    expect(result.body).toMatchObject({ ok: true, message: 'Installed hellno.' });
    expect(cacheEntries()).toHaveLength(1);

    // The manifest, committed and credited.
    const manifest = JSON.parse(readFileSync(join(dir, '.kuraa/r-packages.json'), 'utf8'));
    expect(manifest.requested).toEqual(['hellno']);
    expect(manifest.packages.hellno.ref).toMatch(/^hellno@\d/);
    expect(git(dir, 'log', '-1', '--format=%s%n%b')).toMatch(/^R packages: install hellno\nCo-authored-by: Ada <ada@example.org>/);

    // The library is a link into the shared cache.
    const libs = join(dataDir, 'engines/r/libs');
    const wsLib = join(libs, readdirSync(libs).find((n) => !n.endsWith('.verified'))!);
    expect(lstatSync(join(wsLib, 'hellno')).isSymbolicLink()).toBe(true);
    expect(await run(h, 'suppressPackageStartupMessages(library(hellno)); is.function(hellno::data.frame)')).toBe('[1] TRUE\n');
    expect((await call(h, '/api/packages?engine=r')).body.packages).toEqual([{ name: 'hellno', version: manifest.packages.hellno.version, source: 'workspace' }]);
  }, 300_000);

  it('install.packages() in a chunk asks the host, and another workspace reuses the cache', async () => {
    const h = await host(repo());
    expect(await run(h, 'install.packages("hellno"); suppressPackageStartupMessages(library(hellno)); "loaded"')).toContain('[1] "loaded"');
    expect(cacheEntries()).toHaveLength(1); // the same version, stored once
  }, 300_000);

  it('a fresh machine gets the manifest’s packages before the first run', async () => {
    const dir = repo();
    let h = await host(dir);
    await call(h, '/api/packages/install', { engine: 'r', refs: ['hellno'] });
    // Lose this workspace's library (as on another computer), keep the manifest.
    await h.close();
    const libs = join(dataDir, 'engines/r/libs');
    for (const n of readdirSync(libs)) rmSync(join(libs, n), { recursive: true, force: true });
    h = await host(dir);
    expect(await run(h, 'suppressPackageStartupMessages(library(hellno)); "back"')).toBe('[1] "back"\n');
  }, 300_000);

  it('removes from the workspace only, and refuses what it should', async () => {
    const dir = repo();
    const h = await host(dir);
    await call(h, '/api/packages/install', { engine: 'r', refs: ['hellno'] });
    const removed = await call(h, '/api/packages/remove', { engine: 'r', names: ['hellno'] });
    expect(removed.body).toMatchObject({ ok: true });
    expect(JSON.parse(readFileSync(join(dir, '.kuraa/r-packages.json'), 'utf8')).requested).toEqual([]);
    expect(cacheEntries()).toHaveLength(1); // other workspaces may use it
    expect(await run(h, 'print(requireNamespace("hellno", quietly = TRUE))')).toBe('[1] FALSE\n');

    const bad = await call(h, '/api/packages/install', { engine: 'r', refs: ['https://evil.example/pkg.tar.gz'] });
    expect(bad).toMatchObject({ status: 422, body: { ok: false } });
    expect(String(bad.body.message)).toContain('Not a package name this host installs');

    const off = await host(repo(), false);
    expect((await call(off, '/api/packages/install', { engine: 'r', refs: ['hellno'] })).body.message).toContain('turned off');
    expect(existsSync(join(dir, '.kuraa/r-packages.json'))).toBe(true);
  }, 300_000);
});
