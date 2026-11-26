import { describe, expect, it } from 'vitest';
import type { NavigationFile as TreeFile } from '@kuraa/feature-kit/client';
import { buildTree, treeKey, visibleItems, type TreeItem } from '../src/tree.js';

describe('the file tree for the keyboard', () => {
  const file = (path: string, title?: string): TreeFile => ({ path, type: 'pandoc-markdown', title: title ?? null });
  const files = [file('b.md', 'Beta'), file('a.md', 'Alpha'), file('notes/x.md', 'X'), file('notes/deep/y.md', 'Y'), { path: 'data.bin', type: null }];
  const items = (collapsed: string[] = []): TreeItem[] => visibleItems(buildTree(files), new Set(collapsed));

  it('lists rows as the sidebar shows them: folders first, files by title, nothing in a closed folder', () => {
    expect(items().map((x) => x.path)).toEqual(['notes', 'notes/deep', 'notes/deep/y.md', 'notes/x.md', 'a.md', 'b.md', 'data.bin']);
    expect(items(['notes']).map((x) => x.path)).toEqual(['notes', 'a.md', 'b.md', 'data.bin']);
    expect(items().find((x) => x.path === 'notes/deep/y.md')!.level).toBe(3);
  });

  it('moves with the arrows, Home and End, and stops at the ends', () => {
    const all = items();
    expect(treeKey(all, 'a.md', 'ArrowDown')).toEqual({ kind: 'focus', path: 'b.md' });
    expect(treeKey(all, 'a.md', 'ArrowUp')).toEqual({ kind: 'focus', path: 'notes/x.md' });
    expect(treeKey(all, 'b.md', 'Home')).toEqual({ kind: 'focus', path: 'notes' });
    expect(treeKey(all, 'a.md', 'End')).toEqual({ kind: 'focus', path: 'data.bin' });
    expect(treeKey(all, 'data.bin', 'ArrowDown')).toBeNull();
    expect(treeKey(all, 'notes', 'ArrowUp')).toBeNull();
  });

  it('opens and closes folders with → and ←, and goes in and up', () => {
    expect(treeKey(items(['notes']), 'notes', 'ArrowRight')).toEqual({ kind: 'expand', path: 'notes' });
    expect(treeKey(items(), 'notes', 'ArrowRight')).toEqual({ kind: 'focus', path: 'notes/deep' });
    expect(treeKey(items(), 'notes', 'ArrowLeft')).toEqual({ kind: 'collapse', path: 'notes' });
    expect(treeKey(items(), 'notes/deep/y.md', 'ArrowLeft')).toEqual({ kind: 'focus', path: 'notes/deep' });
    expect(treeKey(items(), 'notes/x.md', 'ArrowLeft')).toEqual({ kind: 'focus', path: 'notes' });
    expect(treeKey(items(), 'a.md', 'ArrowLeft')).toBeNull();
    expect(treeKey(items(), 'a.md', 'ArrowRight')).toBeNull();
  });

  it('opens, renames, deletes and shows the menu', () => {
    const all = items();
    expect(treeKey(all, 'a.md', 'Enter')).toEqual({ kind: 'open', path: 'a.md' });
    expect(treeKey(all, 'notes', 'Enter')).toEqual({ kind: 'collapse', path: 'notes' });
    expect(treeKey(all, 'data.bin', 'F2')).toEqual({ kind: 'rename', path: 'data.bin' });
    expect(treeKey(all, 'data.bin', 'Delete')).toEqual({ kind: 'delete', path: 'data.bin' });
    expect(treeKey(all, 'a.md', 'F10', true)).toEqual({ kind: 'menu', path: 'a.md' });
    expect(treeKey(all, 'a.md', 'F10')).toBeNull();
    expect(treeKey(all, 'a.md', 'ContextMenu')).toEqual({ kind: 'menu', path: 'a.md' });
    expect(treeKey(all, 'a.md', 'x')).toBeNull();
  });

  it('lands on the first row when the row with focus has gone', () => {
    expect(treeKey(items(), 'gone.md', 'ArrowDown')).toEqual({ kind: 'focus', path: 'notes' });
  });
});
