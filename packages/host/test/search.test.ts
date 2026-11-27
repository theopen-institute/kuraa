// Searching the workspace: tracked and untracked text files as .gitignore leaves
// them, never through links, not binary or large files; open documents as they
// are being edited.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'prosemirror-transform';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { connectHeadless, type HeadlessClient } from '@kuraa/session/testing';
import { startHost, type RunningHost } from '../src/index.js';
import type { SearchResult } from '../src/search.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const ADA = { name: 'Ada', email: 'ada@example.org', color: '#123456' };

describe('search', () => {
  let dir: string;
  let outside: string;
  let running: RunningHost;
  const clients: HeadlessClient[] = [];

  const api = (path: string) => fetch(running.url + path, { headers: { authorization: `Bearer ${running.token}` } });
  const search = async (q: string, caseSensitive = false) => (await (await api(`/api/search?q=${encodeURIComponent(q)}${caseSensitive ? '&case=1' : ''}`)).json()) as SearchResult;
  const paths = (r: SearchResult) => r.files.map((f) => f.path);

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-search-'));
    outside = mkdtempSync(join(tmpdir(), 'kuraa-outside-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'user.email', 't@example.org');
    writeFileSync(join(dir, 'notes.md'), '---\ntitle: Field notes\n---\n\n# Day one\n\nThe Tide was out.\n\nThe tide came back.\n');
    writeFileSync(join(dir, 'code.R'), '# tide model\nx <- 1\n');
    writeFileSync(join(dir, '.gitignore'), '*.log\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    // Untracked, ignored, binary, not UTF-8, large, and a link out of the workspace.
    writeFileSync(join(dir, 'draft.txt'), 'tide tables\n');
    writeFileSync(join(dir, 'run.log'), 'tide in the log\n');
    writeFileSync(join(dir, 'latin.txt'), Buffer.from('tide at the caf\xe9\n', 'latin1'));
    writeFileSync(join(dir, 'data.bin'), Buffer.concat([Buffer.from('tide'), Buffer.alloc(64), Buffer.from('tide')]));
    writeFileSync(join(dir, 'big.csv'), `tide\n${'x'.repeat(3 * 1024 * 1024)}\n`);
    // The app's own, about a folder (0093).
    writeFileSync(join(dir, '.kuraa-order'), 'tide.md\n');
    writeFileSync(join(outside, 'secret.txt'), 'tide secret\n');
    symlinkSync(outside, join(dir, 'elsewhere'));
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'secret.txt'));
    running = await startHost({ dir, port: 0, timings: { flushMs: 60_000, idleCommitMs: 60_000, maxCommitMs: 60_000, dropMs: 60_000 } });
  });

  afterEach(async () => {
    for (const c of clients.splice(0)) c.destroy();
    await running.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it('finds a phrase in text files, tracked or not, and nothing else', async () => {
    const r = await search('tide');
    expect(paths(r)).toEqual(['code.R', 'draft.txt', 'notes.md']);
    expect(r.truncated).toBe(false);
    const notes = r.files.find((f) => f.path === 'notes.md')!;
    expect(notes).toMatchObject({ type: 'pandoc-markdown', title: 'Field notes', live: false });
    expect(notes.matches).toEqual([
      { line: 7, column: 4, at: 4, text: 'The Tide was out.' },
      { line: 9, column: 4, at: 4, text: 'The tide came back.' },
    ]);
    expect(r.files.find((f) => f.path === 'code.R')).toMatchObject({ type: 'text', matches: [{ line: 1, column: 2 }] });
    expect(r.files.find((f) => f.path === 'code.R')).not.toHaveProperty('title');
  });

  it('matches case when asked, and takes phrases that look like options or patterns literally', async () => {
    expect((await search('Tide', true)).files.flatMap((f) => f.matches.map((m) => m.text))).toEqual(['The Tide was out.']);
    expect((await search('--help')).files).toEqual([]);
    expect((await search('x <- 1')).files.map((f) => f.path)).toEqual(['code.R']);
    expect((await search('.*')).files).toEqual([]);
    expect((await api('/api/search?q=')).status).toBe(400);
  });

  it('finds what is being typed in an open document before it reaches the file', async () => {
    const { room } = (await (await api('/api/rooms?path=notes.md')).json()) as { room: string };
    const c = connectHeadless({ url: running.url.replace(/^http/, 'ws') + '/collab', room, token: running.token, user: ADA, schema: pandocMarkdown.schema });
    clients.push(c);
    await c.ready;
    const doc = c.read();
    let pos = -1;
    doc.descendants((n, p) => {
      if (pos < 0 && n.isTextblock && n.textContent.includes('came back')) pos = p + 1;
      return pos < 0;
    });
    c.write(new Transform(doc).insert(pos, pandocMarkdown.schema.text('Seagrass and ')).doc);
    await new Promise((r) => setTimeout(r, 200));
    const r = await search('seagrass');
    expect(r.files).toMatchObject([{ path: 'notes.md', live: true, matches: [{ line: 9, text: 'Seagrass and The tide came back.' }] }]);
  });
});
