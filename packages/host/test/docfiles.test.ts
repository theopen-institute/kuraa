// A document's own files (0107): kept in `report.md.files/` beside it, shown
// with it, renamed, moved and deleted with it; and every reference to what
// moves (in the document that moved, and in others) written again, in the
// move's own commit.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { connectHeadless, type HeadlessClient } from '@kuraa/session/testing';
import { startHost, type RunningHost } from '../src/index.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc0f01f0005000201a1d5e5a90000000049454e44ae426082', 'hex');
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

describe('a document’s own files', () => {
  let dir: string;
  let running: RunningHost;
  const call = (path: string, init: RequestInit = {}) => fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json', ...(init.headers ?? {}) } });
  const read = (p: string) => readFileSync(join(dir, p), 'utf8');
  const move = async (from: string, to: string) => {
    const res = await call('/api/files', { method: 'PATCH', body: JSON.stringify({ from, to }) });
    expect(res.status).toBe(200);
    return res.json() as Promise<{ left?: string[] }>;
  };

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-docfiles-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test Host');
    git(dir, 'config', 'user.email', 'host@example.org');
    mkdirSync(join(dir, 'ch'));
    writeFileSync(join(dir, 'ch', 'report.md'), '# Report\n\n![The bay](report.md.files/bay.png){width=50%}\n\nSee [the data](../data.csv#row-2), [notes](#notes) and `![code](report.md.files/bay.png)`.\n');
    writeFileSync(join(dir, 'index.md'), '# Index\n\nRead [the report](ch/report.md) and look: ![](ch/report.md.files/bay.png)\n\n[elsewhere]: ch/report.md "The report"\n');
    writeFileSync(join(dir, 'data.csv'), 'a,b\n1,2\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    running = await startHost({ dir, timings: { flushMs: 150, idleCommitMs: 600, maxCommitMs: 5000, dropMs: 400 } });
    const res = await call('/api/images?doc=ch/report.md&name=bay.png', { method: 'POST', body: new Uint8Array(PNG), headers: { 'content-type': 'image/png' } });
    expect(await res.json()).toMatchObject({ path: 'ch/report.md.files/bay.png', src: 'report.md.files/bay.png' });
  });

  const clients: HeadlessClient[] = [];
  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    await running.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('are shown with their document, not on their own', async () => {
    const tree = (await (await call('/api/tree')).json()) as { files: { path: string; of?: string }[] };
    expect(tree.files.find((f) => f.path === 'ch/report.md.files/bay.png')?.of).toBe('ch/report.md');
    expect(tree.files.find((f) => f.path === 'ch/report.md')?.of).toBeUndefined();
  });

  it('go with their document when it is renamed, and every reference follows, in one commit', async () => {
    expect(await move('ch/report.md', 'ch/trip.md')).not.toHaveProperty('left');
    expect(existsSync(join(dir, 'ch/trip.md.files/bay.png'))).toBe(true);
    expect(existsSync(join(dir, 'ch/report.md.files'))).toBe(false);
    // Its own references, as written (title, attributes, a place in another file), but code.
    expect(read('ch/trip.md')).toBe('# Report\n\n![The bay](trip.md.files/bay.png){width=50%}\n\nSee [the data](../data.csv#row-2), [notes](#notes) and `![code](report.md.files/bay.png)`.\n');
    // Another document's: links, images and definitions.
    expect(read('index.md')).toBe('# Index\n\nRead [the report](ch/trip.md) and look: ![](ch/trip.md.files/bay.png)\n\n[elsewhere]: ch/trip.md "The report"\n');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe('Rename ch/report.md to ch/trip.md');
    const changes = git(dir, 'show', '--name-status', '--format=', 'HEAD').split('\n');
    expect(changes).toHaveLength(3);
    expect(changes).toEqual(expect.arrayContaining([
      'M\tindex.md',
      'R100\tch/report.md.files/bay.png\tch/trip.md.files/bay.png',
      expect.stringMatching(/^R\d+\tch\/report\.md\tch\/trip\.md$/),
    ]));
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('go with it to another folder, its references to elsewhere written from its new place; and with a folder moved', async () => {
    await move('ch/report.md', 'ch/deep/report.md');
    expect(read('ch/deep/report.md')).toContain('![The bay](report.md.files/bay.png){width=50%}');
    expect(read('ch/deep/report.md')).toContain('[the data](../../data.csv#row-2)');
    expect(read('index.md')).toContain('[the report](ch/deep/report.md) and look: ![](ch/deep/report.md.files/bay.png)');
    await move('ch', 'travel');
    expect(read('index.md')).toContain('[the report](travel/deep/report.md) and look: ![](travel/deep/report.md.files/bay.png)');
    expect(read('travel/deep/report.md')).toContain('[the data](../../data.csv#row-2)');
    expect(existsSync(join(dir, 'travel/deep/report.md.files/bay.png'))).toBe(true);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('a document open in a room takes the references written again, keeping what was being typed', async () => {
    const { room } = (await (await call('/api/rooms?path=index.md')).json()) as { room: string };
    const c = connectHeadless({ url: running.url.replace(/^http/, 'ws') + '/collab', room, token: running.token, user: { name: 'Ada', email: 'ada@example.org', color: '#3366cc' }, schema: pandocMarkdown.schema });
    clients.push(c);
    await c.ready;
    // Typed, not yet in the file.
    const doc = c.read();
    let end = -1;
    doc.descendants((n, p) => {
      if (n.isTextblock && n.textContent.startsWith('Index')) end = p + 1 + n.content.size;
      return end < 0;
    });
    c.write(new Transform(doc).insert(end, pandocMarkdown.schema.text(' and travels')).doc);
    await new Promise((r) => setTimeout(r, 50));
    await move('ch/report.md', 'ch/trip.md');
    expect(read('index.md')).toBe('# Index and travels\n\nRead [the report](ch/trip.md) and look: ![](ch/trip.md.files/bay.png)\n\n[elsewhere]: ch/trip.md "The report"\n');
    // The room has them too: the link's address and the image's.
    const named = (d: PMNode) => {
      const out: string[] = [];
      d.descendants((n) => {
        if (n.type.name === 'image') out.push(String(n.attrs.src));
        for (const m of n.marks) if (m.type.name === 'link') out.push(String(m.attrs.href));
      });
      return [...new Set(out)];
    };
    await expect.poll(() => named(c.read()), { timeout: 5000 }).toEqual(['ch/trip.md', 'ch/trip.md.files/bay.png']);
    expect(c.read().firstChild?.textContent).toBe('Index and travels');
  });

  it('are deleted with their document', async () => {
    const res = await call('/api/files?path=ch/report.md', { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(existsSync(join(dir, 'ch/report.md.files'))).toBe(false);
    expect(git(dir, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort()).toEqual(['D\tch/report.md', 'D\tch/report.md.files/bay.png']);
  });
});
