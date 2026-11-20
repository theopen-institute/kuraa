// Rendering documents through run components: the host knows no renderer, so
// these use one from outside the packages (fixtures/render-engine.mjs) and the
// test environments, which start no real process. Rendering in Podman, with
// R and pandoc, is in render-podman.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'prosemirror-transform';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { connectHeadless, type HeadlessClient } from '@kuraa/session/testing';
import { startHost, type RunningHost, type RunOptions } from '../src/index.js';
import type { RenderInfo, RenderState } from '../src/renders.js';

const PAPER = join(import.meta.dirname, 'fixtures/render-engine.mjs');
const ENVS = join(import.meta.dirname, 'fixtures/environments.mjs');
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const ADA = { name: 'Ada', email: 'ada@example.org', color: '#123456' };

let dir = '';
let running: RunningHost | null = null;
const clients: HeadlessClient[] = [];

async function host(run: RunOptions | undefined): Promise<RunningHost> {
  dir = mkdtempSync(join(tmpdir(), 'kuraa-render-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'user.email', 't@example.org');
  writeFileSync(join(dir, 'notes.md'), '# Notes\n\nThe tide was out.\n');
  writeFileSync(join(dir, 'broken.md'), '# Broken\n\nFAIL\n');
  writeFileSync(join(dir, 'slow.md'), '# Slow\n\nSLOW\n');
  writeFileSync(join(dir, 'link.md'), '# Link\n\nLINK\n');
  writeFileSync(join(dir, 'code.R'), 'x <- 1\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  running = await startHost({ dir, port: 0, run, timings: { flushMs: 60_000, idleCommitMs: 60_000, maxCommitMs: 60_000, dropMs: 60_000 } });
  return running;
}

const api = (path: string, init: RequestInit = {}) =>
  fetch(running!.url + path, { ...init, headers: { authorization: `Bearer ${running!.token}`, 'content-type': 'application/json' } });

async function render(path: string, format = 'html'): Promise<{ status: number; state: RenderState }> {
  const res = await api('/api/renders', { method: 'POST', body: JSON.stringify({ path, format, by: ADA }) });
  const state = (await res.json()) as RenderState;
  if (res.status !== 202) return { status: res.status, state };
  for (let i = 0; i < 200; i++) {
    const info = (await (await api(`/api/renders?path=${encodeURIComponent(path)}`)).json()) as RenderInfo;
    const r = info.renders.find((x) => x.format === format);
    if (r && r.state !== 'rendering') return { status: 202, state: r };
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('render did not finish');
}

afterEach(async () => {
  for (const c of clients.splice(0)) c.destroy();
  await running?.close().catch(() => undefined);
  running = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const PAPER_ON: RunOptions = { engines: ['paper'], environment: 'fake', components: [PAPER, ENVS] };

describe('rendering documents', () => {
  it('renders the document as it is being edited, through the environment, read-only and offline', async () => {
    await host(PAPER_ON);
    // An edit in the open room, not yet written to the file (flushes wait a minute here).
    const { room } = (await (await api('/api/rooms?path=notes.md')).json()) as { room: string };
    const c = connectHeadless({ url: running!.url.replace(/^http/, 'ws') + '/collab', room, token: running!.token, user: ADA, schema: pandocMarkdown.schema });
    clients.push(c);
    await c.ready;
    const doc = c.read();
    let pos = -1;
    doc.descendants((n, p) => {
      if (pos < 0 && n.isTextblock && n.textContent.includes('tide')) pos = p + 1;
      return pos < 0;
    });
    c.write(new Transform(doc).insert(pos, pandocMarkdown.schema.text('Just now: ')).doc);
    await new Promise((r) => setTimeout(r, 200));

    const info = (await (await api('/api/renders?path=notes.md')).json()) as RenderInfo;
    expect(info).toMatchObject({ formats: ['html', 'docx'], unavailable: null, renders: [] });
    const { status, state } = await render('notes.md');
    expect(status).toBe(202);
    expect(state).toMatchObject({ state: 'done', message: 'Rendered to html.', by: 'Ada', output: { size: expect.any(Number) } });

    const res = await api('/api/renders/file?path=notes.md&format=html');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-security-policy')).toContain("sandbox; default-src 'none'");
    expect(res.headers.get('content-disposition')).toBe("attachment; filename*=UTF-8''notes.html");
    const html = await res.text();
    expect(html).toContain('Just now: The tide was out.');
    expect(html).toMatch(/paper \S+notes.md html \[in fake, cwd \/scratch, workspace read-only, network false\]/);

    // Kept under .git/kuraa/renders, never in the working tree; and kept across a restart.
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).not.toContain('html');
    expect(readdirSync(join(dir, '.git', 'kuraa', 'renders')).length).toBe(1);
    await running!.close();
    running = await startHost({ dir, port: 0, run: PAPER_ON });
    expect(((await (await api('/api/renders?path=notes.md')).json()) as RenderInfo).renders[0]).toMatchObject({ format: 'html', state: 'done' });
    expect((await api('/api/renders/file?path=notes.md&format=docx')).status).toBe(404);
  });

  it('says why a render failed, with the log behind it, and keeps the last good output', async () => {
    await host(PAPER_ON);
    const { state } = await render('broken.md');
    expect(state).toMatchObject({ state: 'failed', message: 'The document could not be rendered: it says FAIL.', output: null });
    expect(state.log).toContain('line 3: FAIL');
    // A format the renderer does not make, and a file nothing renders.
    expect((await render('notes.md', 'pdf')).state.message).toBe('This document cannot be rendered to pdf.');
    expect((await render('code.R')).state.message).toBe('Nothing on this server renders this kind of file.');
    expect((await api('/api/renders', { method: 'POST', body: JSON.stringify({ path: 'notes.md', format: 'exe' }) })).status).toBe(400);
  });

  it('stops a render that takes too long', async () => {
    await host({ ...PAPER_ON, renderTimeoutMs: 100 });
    expect((await render('slow.md')).state).toMatchObject({ state: 'failed', message: 'The render took longer than 100 ms, the most this host allows, and was stopped.' });
  });

  it('refuses an output that is a link (to anywhere on this computer)', async () => {
    await host(PAPER_ON);
    const { state } = await render('link.md');
    expect(state).toMatchObject({ state: 'failed', message: 'The render finished, but what it made could not be read.' });
    expect((await api('/api/renders/file?path=link.md&format=html')).status).toBe(404);
  });

  it('says what to do where nothing can render', async () => {
    await host({ engines: ['paper'], environment: 'down', components: [PAPER, ENVS] });
    expect(((await (await api('/api/renders?path=notes.md')).json()) as RenderInfo).unavailable).toBe('down is switched off');
    expect(await render('notes.md')).toMatchObject({ status: 422, state: { state: 'failed', message: 'down is switched off' } });
    await running!.close();
    rmSync(dir, { recursive: true, force: true });
    await host(undefined);
    expect((await render('notes.md')).state.message).toContain('Rendering is turned off on this server');
    expect(existsSync(join(dir, 'notes.html'))).toBe(false);
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toBe('# Notes\n\nThe tide was out.\n');
  });
});
