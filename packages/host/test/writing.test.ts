// What the editor needs while people write: workspace files served as they are
// (never outside the workspace, never through a link), images added beside a
// document, and who made a commit and when.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32 } from 'node:zlib';
import { startHost, type RunningHost } from '../src/index.js';
import { safeImageName, sniffImage } from '../src/writing.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1d5e5a90000000049454e44ae426082', 'hex');
/** The PNG with a chunk added after its header. */
const withChunk = (type: string, data: string) => {
  const body = Buffer.from(type + data, 'latin1');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length - 4);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([PNG.subarray(0, 33), len, body, crc, PNG.subarray(33)]);
};
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"><rect width="4" height="4"/></svg>');
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

describe('writing: images and files', () => {
  let dir: string;
  let outside: string;
  let running: RunningHost;
  const call = (path: string, init: RequestInit = {}) => fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, ...(init.headers ?? {}) } });

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-writing-'));
    outside = mkdtempSync(join(tmpdir(), 'kuraa-outside-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test Host');
    git(dir, 'config', 'user.email', 'host@example.org');
    mkdirSync(join(dir, 'chapters'));
    writeFileSync(join(dir, 'chapters', 'one.md'), '# One\n');
    writeFileSync(join(dir, 'plot.png'), PNG);
    writeFileSync(join(dir, 'refs.bib'), '@book{a, title = {A}}\n');
    writeFileSync(join(outside, 'secret.txt'), 'secret');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    running = await startHost({ dir, timings: { flushMs: 150, idleCommitMs: 600, maxCommitMs: 5000, dropMs: 400 } });
  });

  afterEach(async () => {
    await running.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('serves a workspace file with its type, and nothing outside the workspace', async () => {
    const png = await call('/api/raw?path=plot.png');
    expect(png.status).toBe(200);
    expect(png.headers.get('content-type')).toBe('image/png');
    expect(png.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await png.arrayBuffer()).equals(PNG)).toBe(true);
    expect((await call('/api/raw?path=refs.bib')).headers.get('content-type')).toBe('application/octet-stream');

    expect((await call('/api/raw?path=../' + encodeURIComponent(outside.split('/').pop()!) + '/secret.txt')).status).toBe(400);
    expect((await call('/api/raw?path=.git/config')).status).toBe(400);
    expect((await call('/api/raw?path=missing.png')).status).toBe(404);
    expect((await call('/api/raw?path=chapters')).status).toBe(404);
    expect((await fetch(`${running.url}/api/raw?path=plot.png`)).status).toBe(401);
  });

  it('never follows a symbolic link', async () => {
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'link.txt'));
    symlinkSync(outside, join(dir, 'linked'));
    expect((await call('/api/raw?path=link.txt')).status).toBe(403);
    const res = await call('/api/raw?path=linked/secret.txt');
    expect([400, 403]).toContain(res.status);
    expect(await res.text()).not.toContain('secret"');
  });

  it('keeps an image in images/ beside the document, with a safe name, committed', async () => {
    const add = (name: string, body: Buffer) => call(`/api/images?doc=chapters/one.md&name=${encodeURIComponent(name)}&by=Ada&email=ada@example.org`, { method: 'POST', body: new Uint8Array(body) });
    const first = await add('My Plot (final).PNG', PNG);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ path: 'chapters/images/my-plot-final.png', src: 'images/my-plot-final.png', size: PNG.length, removed: [] });
    expect(readFileSync(join(dir, 'chapters/images/my-plot-final.png')).equals(PNG)).toBe(true);
    expect(git(dir, 'log', '-1', '--format=%s%n%b')).toContain('Add image chapters/images/my-plot-final.png');
    expect(git(dir, 'log', '-1', '--format=%b')).toContain('Co-authored-by: Ada <ada@example.org>');

    // The same image again is the same file; another under that name gets a new one.
    expect(await (await add('My Plot (final).png', PNG)).json()).toMatchObject({ src: 'images/my-plot-final.png' });
    expect(await (await add('my-plot-final.svg', SVG)).json()).toMatchObject({ src: 'images/my-plot-final.svg' });
    const png2 = withChunk('pHYs', '\0\0\x0b\x13\0\0\x0b\x13\x01');
    expect(await (await add('my plot final.png', png2)).json()).toMatchObject({ src: 'images/my-plot-final-2.png' });
  });

  it('keeps an image without its details (0106): the same picture with them is the same file', async () => {
    const add = (name: string, body: Buffer) => call(`/api/images?doc=chapters/one.md&name=${encodeURIComponent(name)}`, { method: 'POST', body: new Uint8Array(body) });
    const signed = withChunk('tEXt', 'Author\0Ada Lovelace');
    const res = await add('portrait.png', Buffer.concat([signed, Buffer.from('appended')]));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ path: 'chapters/images/portrait.png', src: 'images/portrait.png', size: PNG.length, removed: ['author', 'appended'] });
    expect(readFileSync(join(dir, 'chapters/images/portrait.png')).equals(PNG)).toBe(true);
    expect(await (await add('portrait.png', PNG)).json()).toMatchObject({ src: 'images/portrait.png', removed: [] });
    // One that cannot be read (cut short) is refused: what it carries could not be found.
    const cut = await add('cut.png', PNG.subarray(0, 40));
    expect(cut.status).toBe(415);
    expect(await cut.text()).toContain('damaged');
  });

  it('says how much the workspace\'s history takes', async () => {
    const res = await call('/api/storage');
    expect(res.status).toBe(200);
    const { history } = (await res.json()) as { history: number };
    expect(history).toBeGreaterThan(0);
  });

  it('refuses what is not an image, too large, or for a document outside the workspace', async () => {
    const post = (q: string, body: Buffer) => call(`/api/images?${q}`, { method: 'POST', body: new Uint8Array(body) });
    expect((await post('doc=chapters/one.md&name=x.png', Buffer.from('<html><script>alert(1)</script>'))).status).toBe(415);
    expect((await post('doc=chapters/one.md&name=x.png', Buffer.alloc(0))).status).toBe(400);
    expect((await post('doc=chapters/one.md&name=x.png', Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]))).status).toBe(413);
    expect((await post('doc=../elsewhere/one.md&name=x.png', PNG)).status).toBe(400);
  });

  it('says who made a commit and when', async () => {
    const head = git(dir, 'rev-parse', 'HEAD');
    const res = await call(`/api/commits/${head.slice(0, 7)}`);
    expect(res.status).toBe(200);
    const info = (await res.json()) as { author: string; date: string };
    expect(info.author).toBe('Test Host');
    expect(Number.isNaN(Date.parse(info.date))).toBe(false);
    expect((await call('/api/commits/0000000')).status).toBe(404);
    expect((await call('/api/commits/HEAD')).status).toBe(404);
  });
});

describe('image names and types', () => {
  it('makes names safe and knows images by their bytes', () => {
    expect(safeImageName('Café Plot #2.jpeg', 'jpg')).toBe('cafe-plot-2.jpg');
    expect(safeImageName('…', 'png')).toBe('image.png');
    expect(safeImageName('con.png', 'png')).toBe('image-con.png');
    expect(sniffImage(PNG)).toBe('png');
    expect(sniffImage(SVG)).toBe('svg');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('gif');
    expect(sniffImage(Buffer.from('hello'))).toBe(null);
  });
});
