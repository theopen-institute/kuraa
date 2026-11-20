// Merging commits as every device does: by document, never stopping on a
// conflict, and the same commit wherever it is made.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeRegistry } from '@kuraa/kernel';
import { standardTypes } from '@kuraa/formats';
import { Git } from '../src/git.js';
import { mergeCommits } from '../src/merging.js';
import { startHost, type RunningHost } from '../src/index.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const registry = new TypeRegistry();
for (const t of standardTypes) registry.register(t);
const dirs: string[] = [];
let running: RunningHost | null = null;

afterEach(async () => {
  await running?.close();
  running = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kuraa-merge-'));
  dirs.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'Base');
  git(dir, 'config', 'user.email', 'base@example.org');
  writeFileSync(join(dir, 'notes.md'), '# Notes\n\nThe tide was out.\n\nWe counted crabs.\n\nIt rained.\n');
  writeFileSync(join(dir, 'plot.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  writeFileSync(join(dir, 'gone.md'), 'Soon gone.\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Base');
  return dir;
}

/** Commit on a new branch from main, as `who`. */
function branch(dir: string, name: string, who: string, files: Record<string, string | Buffer | null>): string {
  git(dir, 'checkout', '-q', '-b', name, 'main');
  for (const [f, content] of Object.entries(files)) {
    if (content === null) git(dir, 'rm', '-q', f);
    else writeFileSync(join(dir, f), content);
  }
  git(dir, 'add', '-A');
  git(dir, '-c', `user.name=${who}`, '-c', `user.email=${who.toLowerCase()}@example.org`, 'commit', '-q', '-m', `${who}'s edit`);
  const head = git(dir, 'rev-parse', 'HEAD');
  git(dir, 'checkout', '-q', 'main');
  return head;
}

const opts = (dir: string) => ({ typeFor: (p: string, h: string) => registry.resolve(p, h), tmpDir: join(dir, '.git', 'kuraa', 'tmp') });
const show = (dir: string, rev: string) => git(dir, 'show', rev);

describe('mergeCommits', () => {
  it('merges documents by words, keeps a clash as a conflict block, and makes the same commit either way round', async () => {
    const dir = repo();
    const ada = branch(dir, 'ada', 'Ada', { 'notes.md': '# Notes\n\nThe tide was far out.\n\nWe counted 40 crabs.\n\nIt rained.\n' });
    const bo = branch(dir, 'bo', 'Bo', { 'notes.md': '# Notes\n\nThe tide was out, at noon.\n\nWe counted 41 crabs.\n\nIt rained hard.\n' });
    const g = new Git(dir);
    const one = await mergeCommits(g, ada, bo, opts(dir));
    const two = await mergeCommits(g, bo, ada, opts(dir));
    expect(one.kind).toBe('merge');
    expect(two.commit).toBe(one.commit);
    expect(one.conflicts).toEqual([{ path: 'notes.md', count: 1 }]);
    const [first, second] = [ada, bo].sort();
    const by = (c: string) => (c === ada ? 'Ada' : 'Bo');
    const crabs = (c: string) => (c === ada ? '40' : '41');
    expect(show(dir, `${one.commit}:notes.md`)).toBe([
      '# Notes', '', 'The tide was far out, at noon.', '',
      ':::: {.conflict}', `::: {.version by="${by(first!)}" commit="${first!.slice(0, 7)}"}`, `We counted ${crabs(first!)} crabs.`, ':::', '',
      `::: {.version by="${by(second!)}" commit="${second!.slice(0, 7)}"}`, `We counted ${crabs(second!)} crabs.`, ':::', '::::', '',
      'It rained hard.',
    ].join('\n'));
    expect(git(dir, 'log', '-1', '--format=%an <%ae>%n%P%n%s', one.commit)).toBe(`Kuraa <merge@kuraa.invalid>\n${first} ${second}\nMerge ${first!.slice(0, 7)} and ${second!.slice(0, 7)}`);
    // The working tree and branches are untouched.
    expect(git(dir, 'status', '--porcelain')).toBe('');
    expect(git(dir, 'rev-parse', 'main')).not.toBe(one.commit);
  });

  it('keeps a file changed on one side and deleted on the other, and saves the other version of a binary file beside it', async () => {
    const dir = repo();
    const ada = branch(dir, 'ada', 'Ada', { 'gone.md': null, 'plot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9]) });
    const bo = branch(dir, 'bo', 'Bo', { 'gone.md': 'Kept, and changed.\n', 'plot.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 7]) });
    const r = await mergeCommits(new Git(dir), ada, bo, opts(dir));
    expect(show(dir, `${r.commit}:gone.md`)).toBe('Kept, and changed.');
    const second = [ada, bo].sort()[1]!;
    expect(r.copies).toEqual([`plot.conflict-${second.slice(0, 7)}.png`]);
    expect(git(dir, 'ls-tree', '--name-only', r.commit).split('\n')).toEqual(['gone.md', 'notes.md', 'plot.conflict-' + second.slice(0, 7) + '.png', 'plot.png']);
  });

  it('fast-forwards when one contains the other', async () => {
    const dir = repo();
    const ada = branch(dir, 'ada', 'Ada', { 'notes.md': '# Notes\n' });
    const main = git(dir, 'rev-parse', 'main');
    expect(await mergeCommits(new Git(dir), main, ada, opts(dir))).toMatchObject({ commit: ada, kind: 'fast-forward' });
    expect(await mergeCommits(new Git(dir), ada, main, opts(dir))).toMatchObject({ commit: ada, kind: 'same' });
  });
});

describe('Sync', () => {
  it('keeps a conflict in the document instead of stopping, and the tree counts it', async () => {
    const dir = repo();
    const remote = mkdtempSync(join(tmpdir(), 'kuraa-remote-'));
    const work = mkdtempSync(join(tmpdir(), 'kuraa-work-'));
    dirs.push(remote, work);
    execFileSync('git', ['clone', '-q', '--bare', dir, remote]);
    git(dir, 'remote', 'add', 'origin', remote);
    git(dir, 'config', '--add', 'kuraa.online', 'origin');
    execFileSync('git', ['clone', '-q', remote, work]);
    writeFileSync(join(work, 'notes.md'), readFileSync(join(work, 'notes.md'), 'utf8').replace('It rained.', 'It rained all day.'));
    git(work, '-c', 'user.name=Bo', '-c', 'user.email=bo@example.org', 'commit', '-q', '-am', 'Edit elsewhere');
    git(work, 'push', '-q');
    writeFileSync(join(dir, 'notes.md'), readFileSync(join(dir, 'notes.md'), 'utf8').replace('It rained.', 'It poured.'));
    git(dir, 'commit', '-q', '-am', 'Local edit');

    running = await startHost({ dir, port: 0 });
    const api = (p: string, init: RequestInit = {}) => fetch(running!.url + p, { ...init, headers: { authorization: `Bearer ${running!.token}` } });
    const sync = (await (await api('/api/sync', { method: 'POST' })).json()) as { ok: boolean; message: string };
    expect(sync).toEqual({ ok: true, message: 'Synced with origin/main; 1 conflict kept in notes.md, to choose between in the document', head: expect.any(String), brought: expect.any(Number), conflicts: 1 });
    expect(readFileSync(join(dir, 'notes.md'), 'utf8')).toContain(':::: {.conflict}');
    expect(git(dir, 'status', '--porcelain')).toBe('');
    // Pushed: the remote has the merge.
    expect(git(remote, 'rev-parse', 'main')).toBe(git(dir, 'rev-parse', 'HEAD'));
    const tree = (await (await api('/api/tree')).json()) as { files: { path: string; conflicts?: number }[] };
    expect(tree.files.find((f) => f.path === 'notes.md')?.conflicts).toBe(1);
    expect(tree.files.find((f) => f.path === 'gone.md')).not.toHaveProperty('conflicts');
  });

  it('merges the same way whichever formats are on here', async () => {
    const dir = repo();
    const ada = branch(dir, 'ada', 'Ada', { 'notes.md': '# Notes\n\nThe low tide was out.\n\nWe counted crabs.\n\nIt rained.\n' });
    // The same sentence: by words, both edits stay; line by line, it would be a conflict.
    const bo = branch(dir, 'bo', 'Bo', { 'notes.md': '# Notes\n\nThe tide was out today.\n\nWe counted crabs.\n\nIt rained.\n' });
    const everything = await mergeCommits(new Git(dir), ada, bo, opts(dir));
    // Markdown off: notes.md opens as a Text file here, but is merged as the document it is.
    running = await startHost({ dir, port: 0, formats: ['text'] });
    expect(running.host.registry.resolve('notes.md')?.id).toBe('text');
    expect(everything.conflicts).toEqual([]);
    expect((await running.host.merge(ada, bo)).commit).toBe(everything.commit);
    expect(running.host.mergeSignature).toBe((await startSignature(dir)));
  });
});

/** The merge signature of a host with every format on. */
async function startSignature(dir: string): Promise<string> {
  const other = await startHost({ dir, port: 0 });
  try {
    return other.host.mergeSignature;
  } finally {
    await other.close();
  }
}
