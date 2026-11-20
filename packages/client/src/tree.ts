// The sidebar's tree: files grouped into folders, and what each row can do.
import type { InjectionKey, Ref } from 'vue';
import type { FileIcon, TypeRegistry } from '@kuraa/kernel';
import type { TreeFile } from './api.js';

export interface FileTypeChoice {
  id: string;
  label: string;
  /** The usual extension for new files of this type, with the dot. */
  extension: string;
  /** Heading the type is listed under. */
  group: string;
  /** Documents of this type have a title: a new one is asked for its title, not a filename. */
  titled: boolean;
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** What the sidebar shows for a file: a document's title, or its filename (a document without a title, or not a document). */
export const shownName = (f: TreeFile): string => f.title || nameOf(f.path);

export interface Folder { name: string; path: string; folders: Map<string, Folder>; files: TreeFile[] }

/**
 * Folders the app keeps for itself, not shown in the sidebar: .kuraa holds the
 * workspace's run settings and package manifest, which the app manages (the
 * Packages panel) and commits. They stay ordinary files, for git and other tools.
 */
const APP_FOLDERS = ['.kuraa'];
const shown = (path: string) => !APP_FOLDERS.some((d) => path === d || path.startsWith(`${d}/`));

/** git keeps no empty folders: a new folder holds this, which the sidebar does not show. */
const PLACEHOLDER = '.gitkeep';

export function buildTree(files: TreeFile[]): Folder {
  const root: Folder = { name: '', path: '', folders: new Map(), files: [] };
  for (const f of files.filter((x) => shown(x.path))) {
    const parts = f.path.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) {
      let next = dir.folders.get(part);
      if (!next) {
        next = { name: part, path: dir.path ? `${dir.path}/${part}` : part, folders: new Map(), files: [] };
        dir.folders.set(part, next);
      }
      dir = next;
    }
    if (parts[parts.length - 1] !== PLACEHOLDER) dir.files.push(f);
  }
  // Files in the order people read them: by title (or filename), numbers in order.
  const sort = (dir: Folder) => {
    dir.files.sort((a, b) => shownName(a).localeCompare(shownName(b), undefined, { numeric: true, sensitivity: 'base' }) || a.path.localeCompare(b.path));
    for (const d of dir.folders.values()) sort(d);
  };
  sort(root);
  return root;
}

/** Types offered for new files: documents first (Markdown leading), then text and source files by name. */
export function fileTypeChoices(registry: TypeRegistry): FileTypeChoice[] {
  const choices = registry.all()
    .filter((t) => t.extensions?.length)
    .map((t) => ({ id: t.id, label: t.label, extension: t.extensions![0]!, group: t.editor?.layout ? 'Text and source files' : 'Documents', titled: !!t.title }));
  const rank = (c: FileTypeChoice) => (c.group === 'Documents' ? 0 : 1);
  return choices.sort((a, b) => rank(a) - rank(b) || (a.id === 'pandoc-markdown' ? -1 : b.id === 'pandoc-markdown' ? 1 : a.label.localeCompare(b.label)));
}

/** A folder's folders in the order the sidebar shows them. */
export const foldersOf = (dir: Folder): Folder[] => [...dir.folders.values()].sort((a, b) => a.name.localeCompare(b.name));

/** A row of the tree as the keyboard moves through it: a folder or a file, at its depth (1 at the top). */
export interface TreeItem {
  path: string;
  folder: boolean;
  level: number;
  /** A folder showing what is in it. */
  expanded: boolean;
}

/** The rows the sidebar shows, top to bottom: each folder's folders, then its files; nothing inside a closed folder. */
export function visibleItems(root: Folder, collapsed: ReadonlySet<string>, level = 1): TreeItem[] {
  const out: TreeItem[] = [];
  for (const f of foldersOf(root)) {
    const expanded = !collapsed.has(f.path);
    out.push({ path: f.path, folder: true, level, expanded });
    if (expanded) out.push(...visibleItems(f, collapsed, level + 1));
  }
  for (const f of root.files) out.push({ path: f.path, folder: false, level, expanded: false });
  return out;
}

/** What a key does on a row of the tree. */
export type TreeAction =
  | { kind: 'focus'; path: string }
  | { kind: 'expand' | 'collapse' | 'open' | 'rename' | 'delete' | 'menu'; path: string };

/**
 * The tree's keys, as a tree view has them: ↑ ↓ Home End move; → opens a
 * folder, or goes into an open one; ← closes it, or goes up to the folder
 * around; Enter (or Space) opens a file or opens and closes a folder; F2
 * renames; Delete deletes; Shift+F10 (or the menu key) shows its menu. Null if
 * the key does nothing here.
 */
export function treeKey(items: readonly TreeItem[], current: string, key: string, shift = false): TreeAction | null {
  const i = items.findIndex((x) => x.path === current);
  const item = items[i];
  if (!item) return items[0] ? { kind: 'focus', path: items[0].path } : null;
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
  select(path: string): void;
  /** Open a file at its first conflict. */
  showConflicts(path: string): void;
  toggle(folder: string): void;
  create(folder?: string): void;
  newFolder(inside?: string): void;
  rename(path: string): void;
  remove(path: string): void;
  /** A file's icon, as its type defines it. */
  iconFor(file: TreeFile): FileIcon | undefined;
  /** The right-click menu for a file, a folder, or the top level (''). */
  contextMenu(e: MouseEvent, path: string, kind: 'file' | 'folder' | 'top'): void;
  dragStart(e: DragEvent, path: string): void;
  dragEnd(): void;
  dragOver(e: DragEvent, folder: string): void;
  drop(e: DragEvent, folder: string): void;
}

export const TREE: InjectionKey<TreeContext> = Symbol('tree');
