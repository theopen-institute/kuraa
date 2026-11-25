// What outputs were made from (0081): the commits of the workspace and its spaces, the files that differ,
// and those files put together again.
import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Git } from '../src/git.js';
import { checkMadeFrom, madeFrom, missingFrom, putTogether, zipOf } from '../src/madefrom.js';

const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const SPACE = 'a'.repeat(32);
const REF = `refs/spaces/${SPACE}/heads/main`;
let dir = '';

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A workspace with a file of its own, and a space holding two (one at a path the workspace also has). */
function workspace(): string {
  dir = mkdtempSync(join(tmpdir(), 'kuraa-made-'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.name', 'T');
  git(dir, 'config', 'user.email', 't@example.org');
  writeFileSync(join(dir, 'paper.md'), '# Paper\n');
  writeFileSync(join(dir, 'clash.md'), 'the workspace’s\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'Initial');
  // The space's commit, made apart from the working tree, as spaces.ts makes them.
  const blob = (text: string) => execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: text, encoding: 'utf8' }).trim();
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, '.git', 'space-index') };
  execFileSync('git', ['update-index', '--add', '--index-info'], { cwd: dir, env, input: `100644 ${blob('1,2\n')}\tdata/survey.csv\n100644 ${blob('the space’s\n')}\tclash.md\n` });
  const tree = execFileSync('git', ['write-tree'], { cwd: dir, env, encoding: 'utf8' }).trim();
  rmSync(env.GIT_INDEX_FILE);
  git(dir, 'update-ref', REF, git(dir, 'commit-tree', tree, '-m', 'Survey'));
  return dir;
}

describe('what outputs were made from', () => {
  it('names the commit of each history, and the files that differ from them', async () => {
    workspace();
    mkdirSync(join(dir, 'data'));
    writeFileSync(join(dir, 'data', 'survey.csv'), '1,2\n');
    // Plain git kept off the space's file, as spaces.ts does.
    writeFileSync(join(dir, '.git', 'info', 'exclude'), '/data/survey.csv\n');
    const g = new Git(dir);
    const spaces = [{ id: SPACE, ref: REF, files: ['data/survey.csv'] }];
    const clean = await madeFrom(g, dir, spaces);
    expect(clean).toEqual({ commit: git(dir, 'rev-parse', 'HEAD'), spaces: [{ id: SPACE, commit: git(dir, 'rev-parse', REF) }], uncommitted: [] });

    // An edit to the workspace's file, a new file, and an edit to the space's.
    writeFileSync(join(dir, 'paper.md'), '# Paper\n\nMore.\n');
    writeFileSync(join(dir, 'notes.md'), 'new\n');
    writeFileSync(join(dir, 'data', 'survey.csv'), '1,2\n3,4\n');
    expect((await madeFrom(g, dir, spaces)).uncommitted).toEqual(['data/survey.csv', 'notes.md', 'paper.md']);
    // Taken away counts too.
    unlinkSync(join(dir, 'data', 'survey.csv'));
    expect((await madeFrom(g, dir, spaces)).uncommitted).toContain('data/survey.csv');
  });

  it('puts the files together again as they were, the workspace’s winning a path both have, as a zip', async () => {
    workspace();
    const g = new Git(dir);
    const made = { commit: git(dir, 'rev-parse', 'HEAD'), spaces: [{ id: SPACE, commit: git(dir, 'rev-parse', REF) }], uncommitted: [] };
    // Changed since: what is put together is what was.
    writeFileSync(join(dir, 'paper.md'), '# Paper, later\n');
    git(dir, 'commit', '-q', '-am', 'Later');
    const tree = await putTogether(g, made, join(dir, '.git', 'kuraa', 'tmp'));
    expect(git(dir, 'ls-tree', '-r', '--name-only', tree).split('\n')).toEqual(['clash.md', 'data/survey.csv', 'paper.md']);
    expect(git(dir, 'show', `${tree}:paper.md`)).toBe('# Paper');
    expect(git(dir, 'show', `${tree}:clash.md`)).toBe('the workspace’s');
    // Nothing points at it: it is never a ref.
    expect(git(dir, 'for-each-ref', '--points-at', tree)).toBe('');
    const zip = await zipOf(g, tree, 'paper-html-made-from');
    const file = join(dir, '..', `${dir.split('/').pop()}.zip`);
    writeFileSync(file, zip);
    try {
      expect(execFileSync('unzip', ['-p', file, 'paper-html-made-from/data/survey.csv'], { encoding: 'utf8' })).toBe('1,2\n');
    } finally {
      rmSync(file, { force: true });
    }
    expect(await missingFrom(g, made)).toBeNull();
    expect(await missingFrom(g, { ...made, spaces: [{ id: SPACE, commit: 'b'.repeat(40) }] })).toBe('b'.repeat(40));
  });

  it('takes a record read back only in its own shape', () => {
    const good = { commit: 'c'.repeat(40), spaces: [{ id: SPACE, commit: 'd'.repeat(40) }], uncommitted: ['a.md'], more: 3 };
    expect(checkMadeFrom(good)).toEqual(good);
    expect(checkMadeFrom({ ...good, commit: null })).toEqual({ ...good, commit: null });
    expect(checkMadeFrom({ ...good, commit: 'HEAD' })).toBeNull();
    expect(checkMadeFrom({ ...good, spaces: [{ id: '../x', commit: 'd'.repeat(40) }] })).toBeNull();
    expect(checkMadeFrom({ ...good, uncommitted: [1] })).toBeNull();
    expect(checkMadeFrom('x')).toBeNull();
  });
});
