// Tools (decision 0045) through run components the host does not know: a tool,
// an environment and a renderer from outside the packages (fixtures/tools.mjs),
// which run nothing in a container. TinyTeX for real is in tinytex-podman.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DATA_MARKER, startHost, type RunningHost, type RunOptions } from '../src/index.js';
import type { RenderInfo, RenderState } from '../src/renders.js';
import type { ToolInfo } from '../src/tools.js';

const TOOLS = join(import.meta.dirname, 'fixtures/tools.mjs');
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const ADA = { name: 'Ada', email: 'ada@example.org', color: '#123456' };
const calls = () => ((globalThis as { __toolbox?: { argv: string[]; env: Record<string, string>; mounts: { host: string; inside: string; access: string }[]; policy: { network: boolean; workspace: string } }[] }).__toolbox ??= []);

const dirs: string[] = [];
const hosts: RunningHost[] = [];
const temp = (name: string) => {
  const d = mkdtempSync(join(tmpdir(), `kuraa-tools-${name}-`));
  dirs.push(d);
  return d;
};

function workspace(files: Record<string, string> = {}): string {
  const dir = temp('ws');
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'user.email', 't@example.org');
  writeFileSync(join(dir, 'plain.md'), '# Plain\n');
  writeFileSync(join(dir, 'latex.md'), '# LaTeX\n\nNEEDS-PDF-TOOL\n');
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(join(dir, name, '..'), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  return dir;
}

async function host(dir: string, o: Partial<RunOptions> & { arch?: string; slowMs?: number } = {}): Promise<{ running: RunningHost; api: (path: string, init?: RequestInit) => Promise<Response> }> {
  const { arch, slowMs, ...run } = o;
  const running = await startHost({
    dir, port: 0,
    run: { engines: ['typeset'], environment: 'toolbox', components: [TOOLS], allowInstalls: true, dataDir: temp('data'), options: { toolbox: { arch, slowMs } }, ...run },
    timings: { flushMs: 60_000, idleCommitMs: 60_000, maxCommitMs: 60_000, dropMs: 60_000 },
  });
  hosts.push(running);
  const api = (path: string, init: RequestInit = {}) => fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' } });
  return { running, api };
}

type Api = Awaited<ReturnType<typeof host>>['api'];
const post = (api: Api, path: string, body: unknown) => api(path, { method: 'POST', body: JSON.stringify(body) });

async function tool(api: Api): Promise<ToolInfo> {
  const list = (await (await api('/api/tools')).json()) as { tools: ToolInfo[] };
  return list.tools.find((t) => t.id === 'fakepdf')!;
}

async function until(api: Api, ok: (t: ToolInfo) => boolean): Promise<ToolInfo> {
  for (let i = 0; i < 300; i++) {
    const t = await tool(api);
    if (ok(t)) return t;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`the tool never got there: ${JSON.stringify(await tool(api))}`);
}

async function render(api: Api, path: string, format = 'pdf'): Promise<RenderState> {
  const res = await post(api, '/api/renders', { path, format, by: ADA });
  const state = (await res.json()) as RenderState;
  if (res.status !== 202) return state;
  for (let i = 0; i < 400; i++) {
    const info = (await (await api(`/api/renders?path=${encodeURIComponent(path)}`)).json()) as RenderInfo;
    const r = info.renders.find((x) => x.format === format);
    if (r && r.state !== 'rendering') return r;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('render did not finish');
}

afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  calls().splice(0);
});

describe('tools', () => {
  it('are installed through the environment into a staging folder, renamed into place when done', async () => {
    const { running, api } = await host(workspace(), { slowMs: 1200 });
    const before = await tool(api);
    expect(before).toMatchObject({ state: 'absent', label: 'Fake PDF', downloadBytes: 12_000_000, size: null, unavailable: null });
    expect((await post(api, '/api/tools/download', { id: 'fakepdf' })).status).toBe(202);
    const data = join(running.host.options.run!.dataDir!, 'tools', 'fakepdf');
    // While it installs: progress for everyone, a staging folder, nothing in place.
    const busy = await until(api, (t) => !!t.progress?.includes('50%'));
    expect(busy.state).toBe('downloading');
    expect(busy.progress).toBe('Downloading Fake PDF… 50%');
    expect(readdirSync(data).some((n) => n.startsWith('.staging-'))).toBe(true);
    expect(existsSync(join(data, '1.0-x86_64'))).toBe(false);
    const done = await until(api, (t) => t.state === 'ready');
    expect(done.size).toBeGreaterThan(0);
    expect(readdirSync(data)).toEqual(['1.0-x86_64']);
    const record = JSON.parse(readFileSync(join(data, '1.0-x86_64', 'tool.json'), 'utf8'));
    expect(record).toMatchObject({ id: 'fakepdf', version: '1.0', arch: 'x86_64', parts: ['base'], added: [] });
    expect(existsSync(join(data, '1.0-x86_64', 'files', 'bin', 'x86_64', 'fakepdf'))).toBe(true);
    // The data folder is marked as kuraa's the first time a tool uses it (Preferences accepts it again).
    expect(existsSync(join(running.host.options.run!.dataDir!, DATA_MARKER))).toBe(true);
    // The installer: the network, no workspace, its own image, the tool's folder writable at its place inside.
    const install = calls().find((c) => c.argv[0] === 'fake-install')!;
    expect(install.policy).toMatchObject({ network: true, workspace: 'none' });
    expect(install.mounts).toEqual([{ host: expect.stringContaining('.staging-'), inside: '/opt/kuraa/tools/fakepdf', access: 'read-write' }]);
  });

  it('downloads one at a time: asking again joins the download under way', async () => {
    const { api } = await host(workspace(), { slowMs: 400 });
    const answers = await Promise.all([1, 2, 3].map(() => post(api, '/api/tools/download', { id: 'fakepdf' })));
    expect(answers.map((r) => r.status)).toEqual([202, 202, 202]);
    await until(api, (t) => t.state === 'ready');
    expect(await post(api, '/api/tools/download', { id: 'fakepdf' }).then((r) => r.status)).toBe(202);
    await until(api, (t) => t.state === 'ready');
    expect(calls().filter((c) => c.argv[0] === 'fake-install')).toHaveLength(1);
  });

  it('are downloaded only where installs are allowed; renders then do without, saying why', async () => {
    const { api } = await host(workspace(), { allowInstalls: false });
    const list = (await (await api('/api/tools')).json()) as { allowInstalls: boolean; tools: ToolInfo[] };
    expect(list.allowInstalls).toBe(false);
    expect(list.tools.map((t) => t.id)).toEqual(['fakepdf']);
    const refused = await post(api, '/api/tools/download', { id: 'fakepdf' });
    expect(refused.status).toBe(403);
    expect((await refused.json()).error).toMatch(/turned off/);
    expect((await post(api, '/api/tools/remove', { id: 'fakepdf' })).status).toBe(403);
    expect((await post(api, '/api/tools/parts', { id: 'fakepdf', names: ['boxes'] })).status).toBe(403);
    const r = await render(api, 'latex.md');
    expect(r.state).toBe('done');
    expect(r.needs).toBeNull();
    expect(r.message).toMatch(/Fake PDF is not on this computer, and downloading it is turned off on this server/);
    expect(calls().some((c) => c.argv[0] === 'fake-install')).toBe(false);
  });

  it('are offered for a kind of computer only if they have a build for it', async () => {
    const { api } = await host(workspace(), { arch: 'riscv64' });
    const t = await tool(api);
    expect(t.unavailable).toBe('Fake PDF is not available for the kind of computer code runs on here (riscv64); it is made for x86_64 and aarch64.');
    const refused = await post(api, '/api/tools/download', { id: 'fakepdf' });
    expect(refused.status).toBe(422);
    expect((await refused.json()).error).toMatch(/not available for the kind of computer code runs on here \(riscv64\)/);
    // A render does without, saying why, rather than offering what cannot work.
    const r = await render(api, 'latex.md');
    expect(r.needs).toBeNull();
    expect(r.message).toMatch(/riscv64/);
  });

  it('installed for another kind of computer are not used here', async () => {
    const dir = workspace();
    const first = await host(dir, { arch: 'aarch64' });
    const data = first.running.host.options.run!.dataDir!;
    await post(first.api, '/api/tools/download', { id: 'fakepdf' });
    await until(first.api, (t) => t.state === 'ready');
    await first.running.close();
    const { api } = await host(dir, { dataDir: data, arch: 'x86_64' });
    const t = await tool(api);
    expect(t.state).toBe('absent');
    expect(t.note).toMatch(/downloaded for aarch64 computers, and code here runs on x86_64/);
    const r = await render(api, 'latex.md');
    expect(r.needs).toMatchObject({ tool: 'fakepdf' });
  });

  it('a render offers the download, and once it is there gets the tool mounted read-only with its PATH', async () => {
    const { api } = await host(workspace());
    const first = await render(api, 'latex.md');
    expect(first.state).toBe('failed');
    expect(first.needs).toEqual({ tool: 'fakepdf', label: 'Fake PDF', downloadBytes: 12_000_000 });
    expect(first.message).toMatch(/needs Fake PDF/);
    // A document that does not need it is not held up.
    expect((await render(api, 'plain.md')).state).toBe('done');
    await post(api, '/api/tools/download', { id: 'fakepdf' });
    await until(api, (t) => t.state === 'ready');
    const second = await render(api, 'latex.md');
    expect(second.state).toBe('done');
    expect(second.needs).toBeNull();
    expect(second.log).toBe('typeset with /opt/kuraa/tools/fakepdf (read-only); PATH /opt/kuraa/tools/fakepdf/bin/x86_64; TEXMFVAR /tmp/fake');
    // Only the render that asked for it sees it.
    expect((await render(api, 'plain.md')).log).toMatch(/^typeset with no tool/);
    const typeset = calls().filter((c) => c.argv[0] === 'typeset');
    expect(typeset.at(-2)!.policy).toMatchObject({ network: false, workspace: 'read-only' });
  });

  it('adds the parts a failed render lacked, renders again, and records them in the workspace', async () => {
    const dir = workspace({ 'boxes.md': '# Boxes\n\nNEEDS-PDF-TOOL \\usepackage{boxes}\n' });
    const { api } = await host(dir);
    await post(api, '/api/tools/download', { id: 'fakepdf' });
    await until(api, (t) => t.state === 'ready');
    const r = await render(api, 'boxes.md');
    expect(r.state).toBe('done');
    expect(r.message).toBe('Rendered to pdf. Added boxes to this computer for it.');
    expect(calls().filter((c) => c.argv[0] === 'typeset')).toHaveLength(2);
    expect(calls().filter((c) => c.argv[0] === 'fake-add').map((c) => c.argv)).toEqual([['fake-add', 'boxes']]);
    expect((await tool(api)).parts).toEqual({ label: 'fake packages', added: 1 });
    // The record, committed crediting Ada.
    expect(JSON.parse(readFileSync(join(dir, '.kuraa/fake-packages.json'), 'utf8'))).toEqual({ packages: ['boxes'] });
    expect(git(dir, 'log', '-1', '--format=%s|%(trailers:key=Co-authored-by,valueonly)', '--', '.kuraa/fake-packages.json')).toBe('fake packages: add boxes|Ada <ada@example.org>');
  });

  it('lists the parts a render lacks where adding them is not allowed', async () => {
    const dir = workspace({ 'boxes.md': '# Boxes\n\nNEEDS-PDF-TOOL \\usepackage{boxes}\n' });
    const first = await host(dir);
    const data = first.running.host.options.run!.dataDir!;
    await post(first.api, '/api/tools/download', { id: 'fakepdf' });
    await until(first.api, (t) => t.state === 'ready');
    await first.running.close();
    const { api } = await host(dir, { dataDir: data, allowInstalls: false });
    const r = await render(api, 'boxes.md');
    expect(r.state).toBe('failed');
    expect(r.message).toBe('LaTeX failed. It needs fake packages this computer does not have: boxes. Adding them is turned off in this server’s Preferences (Let documents install packages and download tools).');
    expect(calls().some((c) => c.argv[0] === 'fake-add')).toBe(false);
  });

  it('adds what the workspace records before a render on a fresh computer', async () => {
    const dir = workspace({
      'boxes.md': '# Boxes\n\nNEEDS-PDF-TOOL \\usepackage{boxes} \\usepackage{tables}\n',
      '.kuraa/fake-packages.json': '{ "packages": ["boxes", "tables", "../../etc"] }\n',
    });
    const { api } = await host(dir);
    await post(api, '/api/tools/download', { id: 'fakepdf' });
    await until(api, (t) => t.state === 'ready');
    const r = await render(api, 'boxes.md');
    expect(r.state).toBe('done');
    expect(r.message).toBe('Rendered to pdf.');
    // Added before the first render, which then needed nothing more; a name the tool would not take is left out.
    expect(calls().filter((c) => c.argv[0] === 'fake-add').map((c) => c.argv)).toEqual([['fake-add', 'boxes', 'tables']]);
    expect(calls().filter((c) => c.argv[0] === 'typeset')).toHaveLength(1);
  });

  it('are removed once no render uses them', async () => {
    const dir = workspace({ 'slow.md': '# Slow\n\nNEEDS-PDF-TOOL SLOW\n' });
    const { running, api } = await host(dir);
    await post(api, '/api/tools/download', { id: 'fakepdf' });
    await until(api, (t) => t.state === 'ready');
    const data = join(running.host.options.run!.dataDir!, 'tools', 'fakepdf');
    const rendering = render(api, 'slow.md');
    await new Promise((r) => setTimeout(r, 300));
    expect((await post(api, '/api/tools/remove', { id: 'fakepdf' })).status).toBe(202);
    const waiting = await tool(api);
    expect(waiting.state).toBe('removing');
    expect(existsSync(join(data, '1.0-x86_64', 'files'))).toBe(true);
    expect((await rendering).state).toBe('done');
    await until(api, (t) => t.state === 'absent');
    expect(readdirSync(data)).toEqual([]);
    // Documents still render, offering the download again.
    expect((await render(api, 'latex.md')).needs).toMatchObject({ tool: 'fakepdf' });
  });
});
