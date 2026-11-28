<script setup lang="ts">
// The file tree (0087): the workspace's folders and files, documents by title.
// A navigation view: what is done to a file (making, renaming, deleting,
// moving, its menu) is the core's, asked through the context; this shows them,
// folds folders, and is a tree for the keyboard too: one row in the Tab order,
// arrows to move and open folders, Enter to open, F2 to rename, Delete to
// delete, Shift+F10 for the menu (tree.ts, treeKey). Drag a file or folder onto
// a folder (or the space below the files) to move it there.
import { computed, nextTick, onBeforeUnmount, onUpdated, provide, ref, shallowRef, useTemplateRef } from 'vue';
import type { NavigationContext } from '@kuraa/feature-kit/client';
import { buildTree, folderOf, nudgeName, placeName, TREE, treeKey, visibleItems, type Folder } from './tree.js';
import { S } from './strings.js';
import TreeFolder from './TreeFolder.vue';

const props = defineProps<{ ctx: NavigationContext }>();
const ctx = props.ctx;

// What the core says, kept here to draw from, and asked again when it says it changed.
const files = shallowRef(ctx.files());
const folders = shallowRef(ctx.folders());
const selected = ref(ctx.selected());
const shownFolder = ref(ctx.shownFolder());
const workspaceName = ref(ctx.workspaceName());
/** Told of a change: what is asked of the core as it is drawn (orders, marks) is asked again. */
const changes = ref(0);
const stopChange = ctx.onChange(() => {
  changes.value++;
  files.value = ctx.files();
  folders.value = ctx.folders();
  shownFolder.value = ctx.shownFolder();
  workspaceName.value = ctx.workspaceName();
  if (ctx.selected() !== selected.value) {
    selected.value = ctx.selected();
    revealFolderOf(selected.value);
  }
});

const tree = computed(() => {
  void changes.value;
  return buildTree(files.value, (folder) => ctx.order(folder));
});
/** A folder of the tree, by its path ('' the top). */
function folderAt(path: string): Folder | null {
  let dir: Folder | undefined = tree.value;
  for (const part of path ? path.split('/') : []) dir = dir?.folders.get(part);
  return dir ?? null;
}
/** The names in a folder, in the order shown. */
const namesIn = (folder: string) => folderAt(folder)?.children.map((c) => c.name) ?? [];
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const collapsed = ref(new Set<string>());
const expand = (folder: string) => {
  if (!collapsed.value.has(folder)) return;
  const next = new Set(collapsed.value);
  next.delete(folder);
  collapsed.value = next;
};
const collapse = (folder: string) => {
  if (collapsed.value.has(folder)) return;
  collapsed.value = new Set([...collapsed.value, folder]);
};
const toggle = (folder: string) => {
  if (collapsed.value.has(folder)) expand(folder);
  else collapse(folder);
};
/** Every folder a path is in, opened. */
function revealFolderOf(path: string | null) {
  if (!path) return;
  const parts = path.replace(/\/+$/, '').split('/');
  for (let i = 1; i < parts.length; i++) expand(parts.slice(0, i).join('/'));
}

// Made or moved somewhere: its folder opens. A folder renamed: open or closed as it was, under its new name.
const stopReveal = ctx.onReveal((path, from) => {
  if (from) {
    const was = from.replace(/\/+$/, '');
    const to = path.replace(/\/+$/, '');
    const rekey = (p: string) => (p === was || p.startsWith(`${was}/`) ? to + p.slice(was.length) : p);
    collapsed.value = new Set([...collapsed.value].map(rekey));
    if (lastFocused.value) lastFocused.value = rekey(lastFocused.value);
    revealFolderOf(to);
    return;
  }
  revealFolderOf(path);
  // A new folder shows open.
  if (path.endsWith('/')) expand(path.replace(/\/+$/, ''));
});
onBeforeUnmount(() => {
  stopChange();
  stopReveal();
  stopOpening();
});

// Moving and arranging (0093): drag a file or folder between two rows to put
// it there (in that folder, moved if it was elsewhere), onto a folder to put
// it in at the end, or onto the space below the files for the top level.
// A move is a rename; a place, the folder's order (both saved, as everything is).
const dragging = ref<string | null>(null);
const over = ref<string | null>(null);
const beside = ref<{ path: string; side: 'before' | 'after' } | null>(null);
let opening: { folder: string; timer: ReturnType<typeof setTimeout> } | null = null;
/** Whether what is dragged may go into a folder: not into itself, nor (unless `here`) the folder it is in. */
const canDrop = (from: string | null, folder: string, here = false) =>
  !!from && from !== folder && !folder.startsWith(`${from}/`) && (here || folderOf(from) !== folder);

/** Where a drop would land: in a folder, beside a row (or at the folder's end), or nowhere. */
type Landing = { folder: string; beside: { path: string; side: 'before' | 'after' } | null };
function landing(e: DragEvent, folder: string, row?: { path: string; folder: boolean }): Landing | null {
  const from = dragging.value;
  if (!row) return canDrop(from, folder) ? { folder, beside: null } : null;
  if (row.path === from) return null;
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const y = box.height ? (e.clientY - box.top) / box.height : 0.5;
  // A folder's row: its top edge before it, its bottom edge (while closed) after it, the rest into it.
  if (row.folder && y >= 0.3 && (y <= 0.7 || !collapsed.value.has(row.path))) return canDrop(from, row.path) ? { folder: row.path, beside: null } : null;
  const side = row.folder ? (y < 0.3 ? 'before' : 'after') : y < 0.5 ? 'before' : 'after';
  const into = folderOf(row.path);
  return canDrop(from, into, true) ? { folder: into, beside: { path: row.path, side } } : null;
}

function dragStart(e: DragEvent, path: string) {
  e.stopPropagation();
  e.dataTransfer?.setData('application/x-kuraa-path', path);
  e.dataTransfer?.setData('text/plain', path);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  dragging.value = path;
}

function stopOpening() {
  if (opening) clearTimeout(opening.timer);
  opening = null;
}

function dragEnd() {
  dragging.value = null;
  over.value = null;
  beside.value = null;
  stopOpening();
}

function dragOver(e: DragEvent, folder: string, row?: { path: string; folder: boolean }) {
  const at = landing(e, folder, row);
  if (!at) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  over.value = at.beside ? null : at.folder;
  beside.value = at.beside;
  folder = at.folder;
  // Hovering a closed folder opens it after a moment.
  // Once it has opened, it may open again (closed and hovered in another drag).
  if (!at.beside && folder && collapsed.value.has(folder) && opening?.folder !== folder) {
    stopOpening();
    opening = {
      folder,
      timer: setTimeout(() => {
        opening = null;
        expand(folder);
      }, 600),
    };
  }
}

function drop(e: DragEvent, folder: string, row?: { path: string; folder: boolean }) {
  const at = landing(e, folder, row);
  if (!at) return;
  e.preventDefault();
  e.stopPropagation();
  const from = dragging.value!;
  dragEnd();
  folder = at.folder;
  if (folder) expand(folder);
  const name = nameOf(from);
  if (lastFocused.value === from) lastFocused.value = `${folder ? `${folder}/` : ''}${name}`;
  glideFrom(from, folder);
  if (at.beside) {
    // Before a row, or before the one after it (none: at the end).
    const rest = namesIn(folder).filter((n) => n !== name);
    const by = nameOf(at.beside.path);
    const before = at.beside.side === 'before' ? by : rest[rest.indexOf(by) + 1] ?? null;
    void ctx.place(from, folder, placeName(rest, name, before));
  } else if (ctx.order(folder)) void ctx.place(from, folder, placeName(namesIn(folder), name, null));
  else ctx.move(from, folder);
}

/** Alt+↑ or Alt+↓ on a row: up or down a place in its folder, which keeps that order from then on. */
function nudge(path: string, by: -1 | 1) {
  const folder = folderOf(path);
  const names = nudgeName(namesIn(folder), nameOf(path), by);
  if (!names) return;
  glideFrom(path, folder);
  void ctx.place(path, folder, names).then(() => focusRow(path));
}

// Motion (0115): when you move a row (a drop, or Alt+↑/↓), the rows whose
// place changed glide there from where they were, the moved one too, across
// folders as well. Nothing moves otherwise, nor where motion is reduced. Only
// rows in sight are animated, and the tree is measured once before and once
// after the move.
const GLIDE: KeyframeAnimationOptions = { duration: 160, easing: 'cubic-bezier(0.2, 0, 0, 1)' };
let glide: { tops: Map<string, number>; after: number; until: number } | null = null;
/** The rows in sight, by path: a file's row is its item; a folder's, its own line (what is in it, rows of their own). */
function rowsInSight(): Map<string, { el: HTMLElement; top: number }> {
  const rows = new Map<string, { el: HTMLElement; top: number }>();
  const scroll = list.value?.parentElement;
  if (!scroll) return rows;
  const view = scroll.getBoundingClientRect();
  for (const li of scroll.querySelectorAll<HTMLElement>('li[data-path]')) {
    const el = li.classList.contains('tree-dir') ? (li.firstElementChild as HTMLElement) : li;
    const box = el.getBoundingClientRect();
    if (box.bottom >= view.top && box.top <= view.bottom) rows.set(li.dataset.path!, { el, top: box.top });
  }
  return rows;
}
/** Before a move into a folder: where each row is, by the path it will have. */
function glideFrom(from: string, folder: string) {
  glide = null;
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const to = `${folder ? `${folder}/` : ''}${nameOf(from)}`;
  const renamed = (p: string) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
  const tops = new Map<string, number>();
  for (const [p, { top }] of rowsInSight()) tops.set(renamed(p), top);
  glide = { tops, after: changes.value, until: performance.now() + 1000 };
}
// Once the core has said the tree changed (the move is shown at once) and it is drawn: each row from where it was.
onUpdated(() => {
  if (!glide || changes.value === glide.after) return;
  const { tops, until } = glide;
  glide = null;
  if (performance.now() > until) return;
  for (const [p, { el, top }] of rowsInSight()) {
    const was = tops.get(p);
    if (was !== undefined && Math.abs(was - top) >= 1) el.animate([{ transform: `translateY(${was - top}px)` }, { transform: 'none' }], GLIDE);
  }
});

// The right-click menu (also Shift+F10 or the menu key on a row): the core's,
// for a file, a folder (its path ending in /) or the top level ('').
const menuPath = (path: string, kind: 'file' | 'folder' | 'top') => (kind === 'folder' ? `${path}/` : kind === 'top' ? '' : path);

function contextMenu(e: MouseEvent, path: string, kind: 'file' | 'folder' | 'top') {
  e.preventDefault();
  e.stopPropagation();
  // From the keyboard (the menu key), there is no pointer: open it by the row.
  let { clientX: x, clientY: y } = e;
  if (!x && !y) {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    x = box.left + 24;
    y = box.bottom;
  }
  ctx.fileMenu(menuPath(path, kind), { x, y });
}

/** The menu for a row, from the keyboard (Shift+F10): by the row. */
function menuFor(el: HTMLElement, path: string, kind: 'file' | 'folder' | 'top') {
  const row = (el.querySelector('.tree-row') as HTMLElement | null) ?? el;
  const box = row.getBoundingClientRect();
  ctx.fileMenu(menuPath(path, kind), { x: box.left + 24, y: box.bottom });
}

// The keyboard: one row in the Tab order (the one last focused, else the open
// file, else the first), the arrows and the rest from treeKey.
const list = useTemplateRef<HTMLUListElement>('list');
const items = computed(() => visibleItems(tree.value, collapsed.value));
const lastFocused = ref<string | null>(null);
const tabStop = computed<string | null>({
  get: () => {
    const shown = (p: string | null) => !!p && items.value.some((x) => x.path === p);
    if (shown(lastFocused.value)) return lastFocused.value;
    if (shown(selected.value)) return selected.value;
    return items.value[0]?.path ?? null;
  },
  set: (p) => {
    lastFocused.value = p;
  },
});
const rowEl = (path: string) => list.value?.querySelector<HTMLElement>(`[role="treeitem"][data-path="${CSS.escape(path)}"]`) ?? null;
async function focusRow(path: string) {
  tabStop.value = path;
  await nextTick();
  const el = rowEl(path);
  el?.focus();
  el?.scrollIntoView({ block: 'nearest' });
}

function onTreeKey(e: KeyboardEvent) {
  const el = e.target as HTMLElement;
  // Keys on a row itself, not on its buttons.
  if (el.getAttribute('role') !== 'treeitem' || e.ctrlKey || (e.metaKey && e.key !== 'Backspace')) return;
  const key = e.key === 'Backspace' && e.metaKey ? 'Delete' : e.key;
  const path = el.dataset.path!;
  const action = treeKey(items.value, path, key, e.shiftKey, e.altKey);
  if (!action) return;
  e.preventDefault();
  e.stopPropagation();
  const folder = items.value.find((x) => x.path === action.path)?.folder ?? false;
  switch (action.kind) {
    case 'focus': void focusRow(action.path); break;
    case 'expand': expand(action.path); break;
    case 'collapse': collapse(action.path); break;
    case 'open': {
      const file = files.value.find((f) => f.path === action.path);
      if (file?.type) ctx.open(action.path);
      break;
    }
    case 'rename': ctx.rename(folder ? `${action.path}/` : action.path); break;
    case 'delete': if (!folder) ctx.remove(action.path); break;
    case 'menu': menuFor(el, action.path, folder ? 'folder' : 'file'); break;
    case 'up': nudge(action.path, -1); break;
    case 'down': nudge(action.path, 1); break;
  }
}

/** The space below the files: right-click (or, with no files, Shift+F10) for a new file or folder at the top level. */
function onSpaceKey(e: KeyboardEvent) {
  if ((e.key === 'F10' && e.shiftKey) || e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    menuFor(e.currentTarget as HTMLElement, '', 'top');
  }
}

provide(TREE, {
  selected,
  collapsed,
  tabStop,
  focused: (path) => {
    tabStop.value = path;
  },
  dragging,
  over,
  beside,
  marksOf: (path) => {
    void changes.value;
    return ctx.marks(path);
  },
  select: (path) => ctx.open(path),
  showConflicts: (path) => ctx.openConflicts(path),
  prefetch: (path, now) => ctx.prefetch(path, now),
  toggle,
  openFolder: (folder) => {
    if (!ctx.showFolder(folder)) toggle(folder);
  },
  shownFolder,
  create: (folder) => ctx.newFile(folder),
  newFolder: (inside) => ctx.newFolder(inside ?? ''),
  rename: (path) => ctx.rename(path),
  remove: (path) => ctx.remove(path),
  iconFor: (f) => ctx.icon(f),
  folderMarks: computed(() => new Map(folders.value.map((m) => [m.path.replace(/\/$/, ''), m]))),
  contextMenu,
  dragStart,
  dragEnd,
  dragOver,
  drop,
});

revealFolderOf(selected.value);
</script>

<template>
  <div
    :class="['tree-scroll', { 'drop-target': over === '' }]"
    @dragover="dragOver($event, '')"
    @drop="drop($event, '')"
    @contextmenu="contextMenu($event, '', 'top')"
  >
    <ul ref="list" class="tree" role="tree" :aria-label="workspaceName" @keydown="onTreeKey">
      <TreeFolder :folder="tree" :depth="0" />
    </ul>
    <!-- Right-click here for a new file or folder at the top level. -->
    <div
      class="tree-space"
      data-testid="tree-space"
      :tabindex="items.length ? -1 : 0"
      :role="items.length ? undefined : 'button'"
      :aria-label="items.length ? undefined : S.space"
      @keydown="onSpaceKey"
      @click="ctx.blank()"
      @contextmenu="contextMenu($event, '', 'top')"
    />
  </div>
</template>

<style>
.tree-scroll { flex: 1; overflow: auto; min-height: 0; display: flex; flex-direction: column; }
.tree-space { flex: 1 0 48px; }
.tree, .tree ul { list-style: none; margin: 0; padding: 0; }
.tree li { position: relative; }
.tree-row {
  display: flex; width: 100%; gap: 6px; text-align: left; border: 0; border-radius: 0;
  padding: 3px 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
}
.tree [role='treeitem'] { outline: none; }
.tree [role='treeitem']:focus-visible > .tree-row, .tree [role='treeitem']:focus-visible > .tree-dir-row { outline: 2px solid var(--accent); outline-offset: -2px; }
.tree-file > .tree-row:hover, .tree-dir-row:hover { background: color-mix(in srgb, var(--selected) 60%, transparent); }
.tree-icon { width: 12px; color: var(--muted); flex: none; }
.tree-file.selected .file-icon { color: var(--text); }
.tree-folder { color: var(--muted); }
.tree-file.selected > .tree-row { background: var(--selected); font-weight: 600; }
/* The folder shown in the main area (0096): marked as the open file is; its icon opens and closes it. */
.tree-dir.shown > .tree-dir-row { background: var(--selected); }
.tree-dir.shown > .tree-dir-row .tree-folder { color: var(--text); font-weight: 600; }
.tree-fold { display: inline-flex; align-items: center; border-radius: 3px; }
.tree-fold:hover { background: color-mix(in srgb, var(--text) 10%, transparent); }
.tree-file.untyped > .tree-row { color: var(--muted); }
.tree-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.tree-file.untitled .tree-name { color: var(--muted); font-style: italic; }
.tree-actions { position: absolute; right: 4px; top: 1px; display: none; gap: 2px; }
.tree-actions button { display: inline-flex; align-items: center; padding: 1px 4px; font-size: 12px; background: var(--panel); }
.tree-actions .file-icon { margin: 0; color: var(--text); }
.tree-dir-row { position: relative; }
.tree-dir.drop-target > .tree-dir-row { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
.tree-dir.drop-target > ul { background: color-mix(in srgb, var(--accent-soft) 45%, transparent); }
.tree-scroll.drop-target { background: color-mix(in srgb, var(--accent-soft) 45%, var(--panel)); }
.tree .dragging { opacity: 0.45; }
/* Where a dragged row would land (0093): a line at the row's edge, from its indent. */
.tree li.drop-before::before, .tree li.drop-after::after {
  content: ''; position: absolute; left: var(--drop-indent, 8px); right: 4px; height: 2px; border-radius: 1px;
  background: var(--accent); pointer-events: none; z-index: 1;
}
.tree li.drop-before::before { top: -1px; }
.tree li.drop-after::after { bottom: -1px; }
/* Features' marks (0093): a small icon by the name; a file left out of something, faded. */
.tree-mark { flex: none; display: inline-flex; align-items: center; color: var(--muted); }
.tree-mark .file-icon { margin: 0; }
.tree-mark-dot { width: 7px; height: 7px; border-radius: 50%; margin: 0 2px; }
.tree-file.muted > .tree-row .tree-name, .tree-dir.muted > .tree-dir-row .tree-name { opacity: 0.5; text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--muted) 60%, transparent); }
.tree [draggable='true'] { cursor: grab; }
.tree-file:hover > .tree-actions, .tree-dir-row:hover > .tree-actions,
.tree-file:focus-within > .tree-actions, .tree-dir:focus > .tree-dir-row > .tree-actions, .tree-actions:focus-within { display: flex; }
.tree-conflict { margin-left: 4px; color: var(--warn); font-size: 11px; cursor: pointer; text-decoration: underline dotted; }
.tree-readers { flex: none; align-self: center; margin-left: 5px; color: var(--muted); }
/* The count is what to click on a file with conflicts; Rename and Delete stay in its right-click menu. */
.tree-file.has-conflicts:hover > .tree-actions { display: none; }
</style>
