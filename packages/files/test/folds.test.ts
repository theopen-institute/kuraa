import { describe, expect, it } from 'vitest';
import type { NavigationFile } from '@kuraa/feature-kit/client';
import { readFolds, saveFolds, type FoldStorage } from '../src/folds.js';
import { buildTree } from '../src/tree.js';

function memory(): FoldStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
}
const file = (path: string): NavigationFile => ({ path, type: 'pandoc-markdown', title: null });
const tree = buildTree([file('notes/a.md'), file('notes/deep/b.md'), file('drafts/c.md'), file('top.md')]);

describe('folders closed, remembered for each workspace', () => {
  it('reads back what was kept, for that workspace only', () => {
    const store = memory();
    saveFolds('Novel', new Set(['notes/deep', 'drafts']), tree, store);
    expect(readFolds('Novel', store)).toEqual(new Set(['notes/deep', 'drafts']));
    expect(readFolds('Essays', store)).toEqual(new Set());
  });

  it('keeps nothing once every folder is open', () => {
    const store = memory();
    saveFolds('Novel', new Set(['drafts']), tree, store);
    saveFolds('Novel', new Set(), tree, store);
    expect(store.map.size).toBe(0);
  });

  it('lets go of folders no longer in the tree, but not while the tree is empty', () => {
    const store = memory();
    saveFolds('Novel', new Set(['drafts', 'gone']), tree, store);
    expect(readFolds('Novel', store)).toEqual(new Set(['drafts']));
    saveFolds('Novel', new Set(['drafts', 'gone']), buildTree([]), store);
    expect(readFolds('Novel', store)).toEqual(new Set(['drafts', 'gone']));
  });

  it('reads nothing from what is not a list of paths, or without storage', () => {
    const store = memory();
    store.setItem('kuraa:files-collapsed:Novel', '{"not":"a list"}');
    expect(readFolds('Novel', store)).toEqual(new Set());
    store.setItem('kuraa:files-collapsed:Novel', 'not json');
    expect(readFolds('Novel', store)).toEqual(new Set());
    store.setItem('kuraa:files-collapsed:Novel', '["drafts", 3]');
    expect(readFolds('Novel', store)).toEqual(new Set(['drafts']));
    expect(readFolds('Novel', null)).toEqual(new Set());
    expect(() => saveFolds('Novel', new Set(['drafts']), tree, null)).not.toThrow();
  });
});
