import { describe, expect, it } from 'vitest';
import type { NavigationFile as TreeFile } from '@kuraa/feature-kit/client';
import { buildTree, nudgeName, placeName, treeKey, visibleItems, type TreeItem } from '../src/tree.js';

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

  it('moves a row up and down its folder with Alt+↑ and Alt+↓', () => {
    expect(treeKey(items(), 'a.md', 'ArrowUp', false, true)).toEqual({ kind: 'up', path: 'a.md' });
    expect(treeKey(items(), 'notes', 'ArrowDown', false, true)).toEqual({ kind: 'down', path: 'notes' });
    expect(treeKey(items(), 'a.md', 'Enter', false, true)).toBeNull();
  });
});

describe('the file tree in an order of its own (0093)', () => {
  const file = (path: string, title?: string): TreeFile => ({ path, type: 'pandoc-markdown', title: title ?? null });
  const files = [file('b.md', 'Beta'), file('a.md', 'Alpha'), file('notes/x.md', 'X'), file('notes/w.md', 'W'), file('c.md', 'Gamma')];

  it('shows what a folder’s order names first, as it names it, files and folders together; the rest after, by name', () => {
    const orders = (f: string) => ({ '': ['c.md', 'notes', 'gone.md'], notes: ['x.md'] } as Record<string, string[]>)[f] ?? null;
    expect(visibleItems(buildTree(files, orders), new Set()).map((x) => x.path)).toEqual(['c.md', 'notes', 'notes/x.md', 'notes/w.md', 'a.md', 'b.md']);
  });

  it('puts a name before another, or at the end, and nudges one up or down', () => {
    expect(placeName(['a', 'b', 'c'], 'c', 'a')).toEqual(['c', 'a', 'b']);
    expect(placeName(['a', 'b', 'c'], 'a', null)).toEqual(['b', 'c', 'a']);
    expect(placeName(['a', 'b'], 'new', 'b')).toEqual(['a', 'new', 'b']);
    expect(nudgeName(['a', 'b', 'c'], 'b', -1)).toEqual(['b', 'a', 'c']);
    expect(nudgeName(['a', 'b', 'c'], 'c', 1)).toBeNull();
  });
});
