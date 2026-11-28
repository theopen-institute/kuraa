// Watching a folder for changes made outside the app (watch.ts): a file saved as
// the host saves it (a temporary file renamed over it) is still watched, so an
// edit made to it afterwards is seen (on Linux, Node's own recursive watching
// misses it); folders made later are watched, with what was already in them;
// git's folders inside .git are not looked into. Both ways of watching: the
// system's recursive one (macOS, Windows) and folder by folder (Linux).
import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { watchTree, type TreeWatcher } from '../src/watch.js';

const ways = process.platform === 'linux' ? [{ name: 'folder by folder', folders: true }] : [{ name: 'the system’s', folders: false }, { name: 'folder by folder', folders: true }];

let watcher: TreeWatcher | null = null;
afterEach(() => {
  watcher?.close();
  watcher = null;
});

async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('not seen in time');
    await new Promise((r) => setTimeout(r, 20));
  }
}
const settle = () => new Promise((r) => setTimeout(r, 150));

describe.each(ways)('watchTree, $name', ({ folders }) => {
  it('sees an edit to a file after it was saved by renaming another over it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kuraa-watch-'));
    writeFileSync(join(dir, 'notes.md'), 'one');
    const seen: string[] = [];
    watcher = watchTree(dir, (rel) => seen.push(rel), (e) => {
      throw e;
    }, { folders });
    await settle();
    writeFileSync(join(dir, '.notes.md.kuraa-tmp-1'), 'two');
    renameSync(join(dir, '.notes.md.kuraa-tmp-1'), join(dir, 'notes.md'));
    await until(() => seen.includes('notes.md'));
    await settle();
    seen.length = 0;
    writeFileSync(join(dir, 'notes.md'), 'three, from outside');
    await until(() => seen.includes('notes.md'));
    rmSync(dir, { recursive: true, force: true });
  });

  it('watches folders made later, with what was in them, and not git’s own', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kuraa-watch-'));
    mkdirSync(join(dir, '.git', 'objects'), { recursive: true });
    const seen: string[] = [];
    watcher = watchTree(dir, (rel) => seen.push(rel), (e) => {
      throw e;
    }, { folders, skip: (rel) => rel.startsWith('.git/') });
    await settle();
    // A folder moved in with a file already in it, then the file edited.
    const outside = mkdtempSync(join(tmpdir(), 'kuraa-watch-out-'));
    mkdirSync(join(outside, 'chapter'));
    writeFileSync(join(outside, 'chapter', 'one.md'), 'one');
    renameSync(join(outside, 'chapter'), join(dir, 'chapter'));
    await until(() => seen.includes('chapter/one.md') || (!folders && seen.includes('chapter')));
    await settle();
    seen.length = 0;
    writeFileSync(join(dir, 'chapter', 'one.md'), 'edited');
    await until(() => seen.includes('chapter/one.md'));
    // In .git: HEAD is seen (a branch switched outside the app); with folders watched one by one, objects are not looked into.
    writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/other\n');
    await until(() => seen.includes('.git/HEAD'));
    if (folders) {
      seen.length = 0;
      writeFileSync(join(dir, '.git', 'objects', 'pack'), 'x');
      await settle();
      expect(seen).not.toContain('.git/objects/pack');
    }
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });
});
