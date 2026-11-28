// Importing (0114), through a host: a Word document (made by the built-in
// pandoc) and a Scrivener 3 project with real RTF, sent to Import's routes and
// made into folders of the workspace in one commit each, converted by the
// host's convert (pandoc.wasm), added by its create (new files only).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importFeature } from '@kuraa/import';
import pandocComponent, { pandocRenderer, pandocWasm } from '@kuraa/render-pandoc';
import { startHost, type RunningHost } from '../src/index.js';

const ADA = { name: 'Ada Lima', email: 'ada@example.org', color: '#d33' };
const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();

describe.skipIf(!pandocWasm())('Import', () => {
  let dir: string;
  let running: RunningHost;
  const post = async (route: string, body: object) => {
    const r = await fetch(`${running.url}/api/features/import/${route}`, { method: 'POST', headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ body, by: ADA }) });
    return { status: r.status, body: (await r.json()) as Record<string, unknown> };
  };
  const send = async (session: string, files: Record<string, Uint8Array>) => {
    for (const [path, bytes] of Object.entries(files)) expect((await post('upload', { session, path, data: Buffer.from(bytes).toString('base64'), start: 0 })).status).toBe(200);
  };
  const read = (p: string) => readFileSync(join(dir, p), 'utf8');

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-import-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Test Host');
    git(dir, 'config', 'user.email', 'host@example.org');
    mkdirSync(join(dir, 'books'));
    writeFileSync(join(dir, 'books', 'keep.md'), '# Keep\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    running = await startHost({ dir, features: [importFeature], run: { engines: [], components: [pandocComponent] } });
  });
  afterEach(async () => {
    await running.close().catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  /** A Word file, made from Markdown by the built-in pandoc. */
  async function word(markdown: string): Promise<Uint8Array> {
    const scratch = mkdtempSync(join(tmpdir(), 'kuraa-docx-'));
    try {
      writeFileSync(join(scratch, 'in.md'), markdown);
      writeFileSync(join(scratch, 'pixel.png'), PIXEL);
      const r = await pandocRenderer.render({ scratch: join(scratch, 's'), workspace: scratch, read: async (p) => readFileSync(join(scratch, p)), timeLimitMs: 60_000, signal: new AbortController().signal, log: () => {}, status: () => {} }, { input: join(scratch, 'in.md'), format: 'docx' });
      expect(r.ok).toBe(true);
      return readFileSync(join(scratch, 's', r.output!));
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  it('makes a Word document a folder of chapters, its images in their documents’ own folders, in one commit', async () => {
    const docx = await word('---\ntitle: The Coast\nauthor: Ada Byron\n---\n\n# Arrival\n\nWe came. ![A pixel](pixel.png)\n\n## The quay\n\nBoats.\n\n# Departure\n\nWe left.\n');
    await send('session-word-1', { 'coast.docx': docx });
    const before = git(dir, 'rev-parse', 'HEAD');
    const r = await post('run', { session: 'session-word-1', kind: 'word', into: 'books', name: 'coast', split: 'chapters' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ folder: 'books/The Coast', first: 'books/The Coast/arrival.md', documents: 2, images: 1, left: [] });
    const arrival = read('books/The Coast/arrival.md');
    expect(arrival).toMatch(/^---\ntitle: Arrival\n---\n\nWe came\. !\[A pixel\]\(arrival\.md\.files\/[a-z0-9-]+\.png\)[\s\S]*\n# The quay\n\nBoats\.\n$/);
    expect(existsSync(join(dir, 'books/The Coast', /\((arrival\.md\.files\/[^)]+)\)/.exec(arrival)![1]!))).toBe(true);
    expect(read('books/The Coast/.kuraa-order')).toMatch(/\narrival\.md\ndeparture\.md\n$/);
    expect(read('books/The Coast/.kuraa-compile.yml')).toMatch(/title: The Coast\nauthor: Ada Byron/);
    // One commit, crediting who asked.
    expect(git(dir, 'rev-list', '--count', `${before}..HEAD`)).toBe('1');
    expect(git(dir, 'log', '-1', '--format=%s%n%b')).toMatch(/^Import coast into books\/[\s\S]*Co-authored-by: Ada Lima <ada@example\.org>/);
    // Again: beside it, never over it.
    await send('session-word-2', { 'coast.docx': docx });
    expect((await post('run', { session: 'session-word-2', kind: 'word', into: 'books', name: 'coast', split: 'none' })).body).toMatchObject({ folder: 'books/The Coast 2', documents: 1 });
    expect(read('books/keep.md')).toBe('# Keep\n');
  });

  it('makes a Scrivener project a folder as its binder is, with its details and what goes in its book', async () => {
    const rtf = (s: string) => new TextEncoder().encode(`{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Times;}}\\f0 ${s}\\par}`);
    const scrivx = `<?xml version="1.0" encoding="UTF-8"?>
<ScrivenerProject Version="2.0">
  <Binder>
    <BinderItem UUID="A" Type="DraftFolder"><Title>Draft</Title><Children>
      <BinderItem UUID="B" Type="Text"><Title>Arrival</Title><MetaData><LabelID>1</LabelID><IncludeInCompile>Yes</IncludeInCompile></MetaData></BinderItem>
      <BinderItem UUID="C" Type="Text"><Title>Outtake</Title><MetaData><IncludeInCompile>No</IncludeInCompile></MetaData></BinderItem>
    </Children></BinderItem>
    <BinderItem UUID="D" Type="ResearchFolder"><Title>Research</Title><Children>
      <BinderItem UUID="E" Type="Image"><Title>The pixel</Title></BinderItem>
    </Children></BinderItem>
  </Binder>
  <LabelSettings><Labels><Label ID="1">Scene</Label></Labels></LabelSettings>
  <ProjectProperties><ProjectTitle>Coast Novel</ProjectTitle><FullName>Ada Byron</FullName></ProjectProperties>
</ScrivenerProject>`;
    await send('session-scriv-1', {
      'Coast.scrivx': new TextEncoder().encode(scrivx),
      'Files/Data/B/content.rtf': rtf('We came by \\b sea\\b0 .'),
      'Files/Data/B/synopsis.txt': new TextEncoder().encode('They arrive.'),
      'Files/Data/C/content.rtf': rtf('Not in the book.'),
      'Files/Data/E/content.png': PIXEL,
    });
    const r = await post('run', { session: 'session-scriv-1', kind: 'scrivener', into: '', name: 'Coast', snapshots: false });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ folder: 'Coast Novel', documents: 2, others: 1 });
    expect(read('Coast Novel/Draft/arrival.md')).toBe('---\ntitle: Arrival\nsynopsis: They arrive.\nlabel: Scene\n---\n\nWe came by **sea**.\n');
    expect(read('Coast Novel/Draft/.kuraa-compile.yml')).toMatch(/title: Coast Novel\nauthor: Ada Byron[\s\S]*exclude:\n {2}- outtake\.md/);
    expect(existsSync(join(dir, 'Coast Novel/Research/the-pixel.png'))).toBe(true);
    expect(read('Coast Novel/.kuraa-order')).toMatch(/\nDraft\nResearch\n$/);
  });

  it('refuses what it cannot do, in words', async () => {
    expect((await post('run', { session: 'session-none-1', kind: 'word' })).status).toBe(404);
    await send('session-bad-1', { 'notes.txt': new Uint8Array([65]) });
    expect((await post('run', { session: 'session-bad-1', kind: 'word', into: '' })).body.message).toMatch(/not a kind of file that can be imported/);
    await send('session-bad-2', { 'x.docx': new Uint8Array([1, 2, 3]) });
    expect((await post('run', { session: 'session-bad-2', kind: 'word', into: 'nowhere' })).status).toBe(404);
    expect((await post('upload', { session: 'session-bad-3', path: '../up.txt', data: '' })).status).toBe(400);
  });
});
