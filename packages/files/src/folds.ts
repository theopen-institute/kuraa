// The folders closed in the tree, remembered for each workspace on this device
// (decision 0128): reopening the app, or coming back to a workspace, shows its
// folders open and closed as they were left. Kept in the browser's storage,
// beside the sidebar's chosen view; not in the workspace, as how one person
// folds their tree is not something to commit.
import type { Folder } from './tree.js';

const KEY = 'kuraa:files-collapsed';
const keyOf = (workspace: string) => `${KEY}:${workspace}`;

/** Where it is kept: localStorage, or a stand-in in tests. */
export type FoldStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
const storage = (): FoldStorage | null => {
  try { return globalThis.localStorage ?? null; } catch { return null; }
};

/** The folders last left closed in a workspace (none, where nothing is kept or storage is unavailable). */
export function readFolds(workspace: string, store: FoldStorage | null = storage()): Set<string> {
  try {
    const v = JSON.parse(store?.getItem(keyOf(workspace)) ?? '[]') as unknown;
    return new Set(Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);
  } catch {
    return new Set();
  }
}

/** Every folder path in a tree. */
function folderPaths(root: Folder, out = new Set<string>()): Set<string> {
  for (const f of root.folders.values()) {
    out.add(f.path);
    folderPaths(f, out);
  }
  return out;
}

/**
 * Keep the folders closed in a workspace. Folders no longer in the tree (deleted,
 * or moved away by someone else) are let go of, so what is kept does not grow;
 * but not while the tree is still empty, before its files have come.
 */
export function saveFolds(workspace: string, collapsed: ReadonlySet<string>, tree: Folder, store: FoldStorage | null = storage()): void {
  const empty = tree.folders.size === 0 && tree.files.length === 0;
  const exist = folderPaths(tree);
  const kept = [...collapsed].filter((p) => empty || exist.has(p)).sort();
  try {
    if (kept.length) store?.setItem(keyOf(workspace), JSON.stringify(kept));
    else store?.removeItem(keyOf(workspace));
  } catch { /* storage unavailable: for this page only */ }
}
