// The sidebar's tree: files grouped into folders, and what each row can do.
import type { InjectionKey, Ref } from 'vue';
import type { TypeRegistry } from '@kuraa/kernel';
import type { TreeFile } from './api.js';
import type { FileTypeChoice } from './ask.js';

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
  return root;
}

/** Types offered for new files: documents first (Markdown leading), then text and source files by name. */
export function fileTypeChoices(registry: TypeRegistry): FileTypeChoice[] {
  const choices = registry.all()
    .filter((t) => t.extensions?.length)
    .map((t) => ({ id: t.id, label: t.label, extension: t.extensions![0]!, group: t.editor?.layout ? 'Text and source files' : 'Documents' }));
  const rank = (c: FileTypeChoice) => (c.group === 'Documents' ? 0 : 1);
  return choices.sort((a, b) => rank(a) - rank(b) || (a.id === 'pandoc-markdown' ? -1 : b.id === 'pandoc-markdown' ? 1 : a.label.localeCompare(b.label)));
}

/** What the tree's rows share: the state and actions of the whole tree. */
export interface TreeContext {
  selected: Ref<string | null>;
  collapsed: Ref<Set<string>>;
  /** What is being dragged, and the folder it would land in ('' for the top level). */
  dragging: Ref<string | null>;
  over: Ref<string | null>;
  select(path: string): void;
  toggle(folder: string): void;
  create(folder?: string): void;
  newFolder(inside?: string): void;
  rename(path: string): void;
  remove(path: string): void;
  dragStart(e: DragEvent, path: string): void;
  dragEnd(): void;
  dragOver(e: DragEvent, folder: string): void;
  drop(e: DragEvent, folder: string): void;
}

export const TREE: InjectionKey<TreeContext> = Symbol('tree');
