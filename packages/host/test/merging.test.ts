// Merging commits as every device does: by document, never stopping on a
// conflict, and the same commit wherever it is made.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TypeRegistry } from '@kuraa/kernel';
import { standardTypes } from '@kuraa/formats';
import { Git } from '../src/git.js';
import { MERGE_VERSION, mergeCommits, mergeSignature } from '../src/merging.js';
import { startHost, type RunningHost } from '../src/index.js';
import syncGit from '@kuraa/sync-git';

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

describe('merges whatever this computer’s git settings (0025)', () => {
  /** Run `fn` with git set up against merging the same way as others: settings and attributes of the person's, the system's, and the repository's. */
  async function hostile<T>(dir: string, fn: () => Promise<T>): Promise<T> {
    const home = mkdtempSync(join(tmpdir(), 'kuraa-home-'));
    dirs.push(home);
    const union = join(home, 'attributes');
    writeFileSync(union, '* merge=union\n');
    const config = `[core]\n\tattributesFile = ${union}\n[merge]\n\trenames = false\n\tdirectoryRenames = false\n\tconflictStyle = diff3\n[i18n]\n\tcommitEncoding = ISO-8859-1\n\tlogOutputEncoding = ISO-8859-1\n`;
    writeFileSync(join(home, '.gitconfig'), config);
    mkdirSync(join(home, 'xdg', 'git'), { recursive: true });
    writeFileSync(join(home, 'xdg', 'git', 'attributes'), '* merge=union\n');
    writeFileSync(join(home, 'system'), config);
    // The repository's own: its settings, info/attributes, and a .gitattributes not committed.
    git(dir, 'config', 'merge.renames', 'false');
    git(dir, 'config', 'merge.conflictStyle', 'zdiff3');
    git(dir, 'config', 'i18n.commitEncoding', 'ISO-8859-1');
    mkdirSync(join(dir, '.git', 'info'), { recursive: true });
    writeFileSync(join(dir, '.git', 'info', 'attributes'), '* merge=union\n');
    writeFileSync(join(dir, '.gitattributes'), '* merge=union\n');
    const vars = { HOME: home, XDG_CONFIG_HOME: join(home, 'xdg'), GIT_CONFIG_GLOBAL: join(home, '.gitconfig'), GIT_CONFIG_SYSTEM: join(home, 'system'), GIT_CONFIG_PARAMETERS: "'merge.renames'='false'" };
    const was = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
    Object.assign(process.env, vars);
    try {
      return await fn();
    } finally {
      for (const [k, v] of Object.entries(was)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      rmSync(join(dir, '.gitattributes'));
    }
  }

  it('makes the same merge commit with hostile settings and attributes as without', async () => {
    const dir = repo();
    // A clash in one sentence (git: a conflict; with merge=union: both lines), and a file renamed on one side, changed on the other.
    writeFileSync(join(dir, 'a.md'), '# A\n\nOne.\n\nTwo.\n\nThree.\n\nFour.\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'A file');
    git(dir, 'checkout', '-q', '-b', 'ada');
    writeFileSync(join(dir, 'notes.md'), '# Notes\n\nThe tide was low.\n\nWe counted crabs.\n\nIt rained.\n');
    git(dir, 'mv', 'a.md', 'b.md');
    git(dir, 'commit', '-q', '-am', 'Ada');
    const ada = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', '-b', 'bo', 'main');
    writeFileSync(join(dir, 'notes.md'), '# Notes\n\nThe tide was gone.\n\nWe counted crabs.\n\nIt rained.\n');
    writeFileSync(join(dir, 'a.md'), '# A\n\nOne.\n\nTwo.\n\nThree.\n\nFour, and five.\n');
    git(dir, 'commit', '-q', '-am', 'Bo');
    const bo = git(dir, 'rev-parse', 'HEAD');
    git(dir, 'checkout', '-q', 'main');

    const plain = await mergeCommits(new Git(dir), ada, bo, opts(dir));
    const odd = await hostile(dir, () => mergeCommits(new Git(dir), ada, bo, opts(dir)));
    expect(odd).toEqual(plain);
    expect(plain.conflicts).toEqual([{ path: 'notes.md', count: 1 }]);
    expect(show(dir, `${plain.commit}:notes.md`)).toContain(':::: {.conflict}');
    // The change followed the rename.
    expect(git(dir, 'ls-tree', '--name-only', plain.commit).split('\n')).toEqual(['b.md', 'gone.md', 'notes.md', 'plot.png']);
    expect(show(dir, `${plain.commit}:b.md`)).toContain('Four, and five.');
    expect(git(dir, 'cat-file', 'commit', plain.commit)).not.toContain('encoding');
    expect(git(dir, 'log', '-1', '--format=%B', plain.commit)).toContain(`Kuraa-Merge: ${MERGE_VERSION}`);
  });

  it('merges an outside edit with git’s own markers, whatever merge.conflictStyle says', async () => {
    const dir = repo();
    const base = 'a\nb\nc\n';
    const plain = await new Git(dir).mergeFile('a\nX\nc\n', base, 'a\nY\nc\n', join(dir, '.git', 'kuraa'));
    const odd = await hostile(dir, () => new Git(dir).mergeFile('a\nX\nc\n', base, 'a\nY\nc\n', join(dir, '.git', 'kuraa')));
    // The markers name temporary files, different each time.
    const label = (r: { text: string; conflict: boolean }) => ({ ...r, text: r.text.replace(/^(<<<<<<<|>>>>>>>) .*$/gm, '$1') });
    expect(label(odd)).toEqual(label(plain));
    expect(plain.conflict).toBe(true);
    expect(plain.text).not.toContain('|||||||');
  });

  it('merges in a repository with sha256 ids', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kuraa-merge-'));
    dirs.push(dir);
    git(dir, 'init', '-q', '-b', 'main', '--object-format=sha256');
    git(dir, 'config', 'user.name', 'Base');
    git(dir, 'config', 'user.email', 'base@example.org');
    writeFileSync(join(dir, 'notes.md'), '# Notes\n\nThe tide was out.\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Base');
    const ada = branch(dir, 'ada', 'Ada', { 'notes.md': '# Notes\n\nThe tide was low.\n' });
    const bo = branch(dir, 'bo', 'Bo', { 'notes.md': '# Notes\n\nThe tide was gone.\n' });
    const r = await mergeCommits(new Git(dir), ada, bo, opts(dir));
    expect(r.commit).toMatch(/^[0-9a-f]{64}$/);
    expect(r.conflicts).toEqual([{ path: 'notes.md', count: 1 }]);
  });

  it('says which git merges, as part of how this device merges (0038)', () => {
    expect(mergeSignature([], '2.55.0')).toBe(`merge@${MERGE_VERSION} git@2.55.0`);
    expect(mergeSignature([], '2.55.0')).not.toBe(mergeSignature([], '2.39.5-(Apple-Git-154)'));
    expect(mergeSignature([])).toMatch(/ git@\d+\.\d+/);
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

    running = await startHost({ dir, port: 0, run: { engines: [], components: [syncGit] } });
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
    // As a host with every format on merges them (its trailer names how it merges).
    const signature = await startSignature(dir);
    const everything = await mergeCommits(new Git(dir), ada, bo, { ...opts(dir), signature });
    // Markdown off: notes.md opens as a Text file here, but is merged as the document it is.
    running = await startHost({ dir, port: 0, formats: ['text'] });
    expect(running.host.registry.resolve('notes.md')?.id).toBe('text');
    expect(everything.conflicts).toEqual([]);
    expect((await running.host.merge(ada, bo)).commit).toBe(everything.commit);
    expect(running.host.mergeSignature).toBe(signature);
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

describe('merges that keep what was not theirs to change (0066)', () => {
  const opts = (dir: string, keeps: Map<string, string | null>) => ({
    typeFor: (p: string, h: string) => registry.resolve(p, h),
    tmpDir: join(dir, '.git', 'tmp'),
    keeps,
    refused: [{ commit: 'ab'.repeat(20), path: 'notes.md', by: 'Bo' }],
  });

  it('keep this side’s version of a file, even where the other side holds this one (a merge all the same, on record)', async () => {
    const dir = repo();
    const g = new Git(dir);
    const base = git(dir, 'rev-parse', 'HEAD');
    const before = git(dir, 'rev-parse', 'HEAD:notes.md');
    writeFileSync(join(dir, 'notes.md'), '# Notes\n\nBo was here.\n');
    writeFileSync(join(dir, 'extra.md'), 'Bo’s, where anyone may.\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Bo');
    const theirs = git(dir, 'rev-parse', 'HEAD');
    const out = await mergeCommits(g, base, theirs, opts(dir, new Map([['notes.md', before]])));
    expect(out.kind).toBe('merge');
    expect(git(dir, 'rev-parse', `${out.commit}:notes.md`)).toBe(before);
    expect(git(dir, 'show', `${out.commit}:extra.md`)).toBe('Bo’s, where anyone may.');
    const message = git(dir, 'show', '-s', '--format=%B', out.commit);
    expect(message).toContain('Kept notes.md as it was: not Bo to change');
    expect(message).toContain(`Kuraa-Refused: ${'ab'.repeat(20)} notes.md`);
    // The same merge, made again (as another device would).
    expect((await mergeCommits(g, base, theirs, opts(dir, new Map([['notes.md', before]])))).commit).toBe(out.commit);
  });

  it('keep a file away that this side does not have', async () => {
    const dir = repo();
    const g = new Git(dir);
    const base = git(dir, 'rev-parse', 'HEAD');
    writeFileSync(join(dir, 'chapter.md'), 'Not his to add.\n');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Bo');
    const out = await mergeCommits(g, base, git(dir, 'rev-parse', 'HEAD'), opts(dir, new Map([['chapter.md', null]])));
    expect(git(dir, 'ls-tree', '--name-only', out.commit)).not.toContain('chapter.md');
  });
});
