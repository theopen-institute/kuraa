// The file tree (0087): files grouped into folders, the rows the keyboard moves
// through, and what each row can do.
import type { InjectionKey, Ref } from 'vue';
import type { FileIcon } from '@kuraa/kernel';
import type { FileMark, NavigationFile } from '@kuraa/feature-kit/client';

type TreeFile = NavigationFile;

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** What the sidebar shows for a file: a document's title, or its filename (a document without a title, or not a document). */
export const shownName = (f: TreeFile): string => f.title || nameOf(f.path);

/** A row's content: a folder, or a file. */
export type Child = { name: string; folder: Folder; file?: undefined } | { name: string; file: TreeFile; folder?: undefined };

export interface Folder {
  name: string;
  path: string;
  folders: Map<string, Folder>;
  files: TreeFile[];
  /** What is in it, in the order shown (0093): as arranged, where it has an order; then by name, folders first. */
  children: Child[];
}

/** A folder's order, as people arranged it: the names of what is in it ('' the top level); null where it has none. */
export type Orders = (folder: string) => readonly string[] | null;

/**
 * Folders the app keeps for itself, not shown in the sidebar: .kuraa holds the
 * workspace's run settings and package manifest, which the app manages (the
 * Packages panel) and commits. They stay ordinary files, for git and other tools.
 */
const APP_FOLDERS = ['.kuraa'];
const shown = (path: string) => !APP_FOLDERS.some((d) => path === d || path.startsWith(`${d}/`));

/** git keeps no empty folders: a new folder holds this, which the sidebar does not show. */
const PLACEHOLDER = '.gitkeep';

export function buildTree(files: TreeFile[], orders: Orders = () => null): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [], children: [] };
  for (const f of files.filter((x) => shown(x.path))) {
    const parts = f.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.folders.get(part);
      if (!next) {
        next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, folders: new Map(), files: [], children: [] };
        dir.folders.set(part, next);
      }
      dir = next;
    }
    if (parts[parts.length - 1] !== PLACEHOLDER) dir.files.push(f);
  }
  // By name: folders first, then files in the order people read them, by title (or filename), numbers in order.
  // Where the folder has an order (0093), what it names comes first, as it names it.
  const sort = (dir: Folder) => {
    dir.files.sort((a, b) => shownName(a).localeCompare(shownName(b), undefined, { numeric: true, sensitivity: 'base' }) || a.path.localeCompare(b.path));
    const byName: Child[] = [
      ...[...dir.folders.values()].sort((a, b) => a.name.localeCompare(b.name)).map((folder) => ({ name: folder.name, folder })),
      ...dir.files.map((file) => ({ name: nameOf(file.path), file })),
    ];
    const order = orders(dir.path);
    if (order) {
      const named = new Map(byName.map((c) => [c.name, c]));
      const first = order.flatMap((n) => named.get(n) ?? []);
      const placed = new Set(first);
      dir.children = [...first, ...byName.filter((c) => !placed.has(c))];
    } else dir.children = byName;
    for (const d of dir.folders.values()) sort(d);
  };
  sort(root);
  return root;
}

/** A folder's own path, of a file or folder's ('' the top). */
export const folderOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/**
 * A folder's names after one of them is put before another (`before`; null:
 * at the end), taken from where it was, if it was there.
 */
export function placeName(names: readonly string[], name: string, before: string | null): string[] {
  const rest = names.filter((n) => n !== name);
  const at = before === null ? -1 : rest.indexOf(before);
  return at < 0 ? [...rest, name] : [...rest.slice(0, at), name, ...rest.slice(at)];
}

/** A folder's names with one moved up (-1) or down (1) a place; null where it cannot go further. */
export function nudgeName(names: readonly string[], name: string, by: -1 | 1): string[] | null {
  const i = names.indexOf(name);
  const j = i + by;
  if (i < 0 || j < 0 || j >= names.length) return null;
  const out = [...names];
  [out[i], out[j]] = [out[j]!, out[i]!];
  return out;
}

/** A row of the tree as the keyboard moves through it: a folder or a file, at its depth (1 at the top). */
export interface TreeItem {
  path: string;
  folder: boolean;
  level: number;
  /** A folder showing what is in it. */
  expanded: boolean;
}

/** The rows the sidebar shows, top to bottom, each folder's in its order; nothing inside a closed folder. */
export function visibleItems(root: Folder, collapsed: ReadonlySet<string>, level = 1): TreeItem[] {
  const out: TreeItem[] = [];
  for (const c of root.children) {
    if (c.file) {
      out.push({ path: c.file.path, folder: false, level, expanded: false });
      continue;
    }
    const expanded = !collapsed.has(c.folder.path);
    out.push({ path: c.folder.path, folder: true, level, expanded });
    if (expanded) out.push(...visibleItems(c.folder, collapsed, level + 1));
  }
  return out;
}

/** What a key does on a row of the tree. */
export type TreeAction =
  | { kind: 'focus'; path: string }
  | { kind: 'expand' | 'collapse' | 'open' | 'rename' | 'delete' | 'menu' | 'up' | 'down'; path: string };

/**
 * The tree's keys, as a tree view has them: ↑ ↓ Home End move; → opens a
 * folder, or goes into an open one; ← closes it, or goes up to the folder
 * around; Enter (or Space) opens a file or opens and closes a folder; F2
 * renames; Delete deletes; Shift+F10 (or the menu key) shows its menu; Alt+↑
 * and Alt+↓ move it up and down its folder (0093). Null if the key does nothing here.
 */
export function treeKey(items: readonly TreeItem[], current: string, key: string, shift = false, alt = false): TreeAction | null {
  const i = items.findIndex((x) => x.path === current);
  const item = items[i];
  if (!item) return items[0] ? { kind: 'focus', path: items[0].path } : null;
  if (alt) return key === 'ArrowUp' ? { kind: 'up', path: item.path } : key === 'ArrowDown' ? { kind: 'down', path: item.path } : null;
  const focus = (j: number) => {
    const to = items[Math.max(0, Math.min(items.length - 1, j))]!;
    return to.path === current ? null : { kind: 'focus' as const, path: to.path };
  };
  switch (key) {
    case 'ArrowDown': return focus(i + 1);
    case 'ArrowUp': return focus(i - 1);
    case 'Home': return focus(0);
    case 'End': return focus(items.length - 1);
    case 'ArrowRight':
      if (!item.folder) return null;
      if (!item.expanded) return { kind: 'expand', path: item.path };
      return items[i + 1]?.level === item.level + 1 ? focus(i + 1) : null;
    case 'ArrowLeft': {
      if (item.folder && item.expanded) return { kind: 'collapse', path: item.path };
      for (let j = i - 1; j >= 0; j--) if (items[j]!.level < item.level) return focus(j);
      return null;
    }
    case 'Enter':
    case ' ':
      return item.folder ? { kind: item.expanded ? 'collapse' : 'expand', path: item.path } : { kind: 'open', path: item.path };
    case 'F2': return { kind: 'rename', path: item.path };
    case 'Delete': return { kind: 'delete', path: item.path };
    case 'F10': return shift ? { kind: 'menu', path: item.path } : null;
    case 'ContextMenu': return { kind: 'menu', path: item.path };
    default: return null;
  }
}

/** What the tree's rows share: the state and actions of the whole tree. */
export interface TreeContext {
  selected: Ref<string | null>;
  collapsed: Ref<Set<string>>;
  /** The row Tab lands on (the others are reached with the arrows). */
  tabStop: Ref<string | null>;
  /** A row took focus: Tab comes back to it. */
  focused(path: string): void;
  /** What is being dragged, and the folder it would land in ('' for the top level). */
  dragging: Ref<string | null>;
  over: Ref<string | null>;
  /** The row it would land beside (0093), and on which side: a line there. */
  beside: Ref<{ path: string; side: 'before' | 'after' } | null>;
  /** Features' marks on a file or folder (its path ending in `/`). */
  marksOf(path: string): FileMark[];
  select(path: string): void;
  /** Open a file at its first conflict. */
  showConflicts(path: string): void;
  /** The pointer rests on a file (null: it left): its room is asked for ahead, so it opens sooner. */
  prefetch(path: string | null, now?: boolean): void;
  toggle(folder: string): void;
  /** A folder's name clicked (0095): shown in the main area (its corkboard, its outline); where nothing shows folders, opened or closed. */
  openFolder(folder: string): void;
  /** The folder shown in the main area, if one is. */
  shownFolder: Ref<string | null>;
  create(folder?: string): void;
  newFolder(inside?: string): void;
  rename(path: string): void;
  remove(path: string): void;
  /** A file's icon, as its type defines it. */
  iconFor(file: TreeFile): FileIcon | undefined;
  /** Folders with permissions of their own (0069), by path (no trailing slash): who reads, who may change, in words. */
  folderMarks: Ref<Map<string, { readers?: string; writers?: string }>>;
  /** The right-click menu for a file, a folder, or the top level (''). */
  contextMenu(e: MouseEvent, path: string, kind: 'file' | 'folder' | 'top'): void;
  dragStart(e: DragEvent, path: string): void;
  dragEnd(): void;
  /** Over a folder's space (onto it, at its end), or over a row (`row`: beside it, or into it if it is a folder). */
  dragOver(e: DragEvent, folder: string, row?: { path: string; folder: boolean }): void;
  drop(e: DragEvent, folder: string, row?: { path: string; folder: boolean }): void;
}

export const TREE: InjectionKey<TreeContext> = Symbol('tree');
