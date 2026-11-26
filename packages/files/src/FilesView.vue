<script setup lang="ts">
// The file tree (0087): the workspace's folders and files, documents by title.
// A navigation view: what is done to a file (making, renaming, deleting,
// moving, its menu) is the core's, asked through the context; this shows them,
// folds folders, and is a tree for the keyboard too: one row in the Tab order,
// arrows to move and open folders, Enter to open, F2 to rename, Delete to
// delete, Shift+F10 for the menu (tree.ts, treeKey). Drag a file or folder onto
// a folder (or the space below the files) to move it there.
import { computed, nextTick, onBeforeUnmount, provide, ref, shallowRef, useTemplateRef } from 'vue';
import type { NavigationContext } from '@kuraa/feature-kit/client';
import { buildTree, TREE, treeKey, visibleItems } from './tree.js';
import { S } from './strings.js';
import TreeFolder from './TreeFolder.vue';

const props = defineProps<{ ctx: NavigationContext }>();
const ctx = props.ctx;

// What the core says, kept here to draw from, and asked again when it says it changed.
const files = shallowRef(ctx.files());
const folders = shallowRef(ctx.folders());
const selected = ref(ctx.selected());
const workspaceName = ref(ctx.workspaceName());
const stopChange = ctx.onChange(() => {
  files.value = ctx.files();
  folders.value = ctx.folders();
  workspaceName.value = ctx.workspaceName();
  if (ctx.selected() !== selected.value) {
    selected.value = ctx.selected();
    revealFolderOf(selected.value);
  }
});

const tree = computed(() => buildTree(files.value));
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

const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

// Moving: by dragging a file or folder onto a folder (or anywhere in it), or
// onto the space below the files. A move is a rename (saved, as everything is).
const dragging = ref<string | null>(null);
const over = ref<string | null>(null);
let opening: { folder: string; timer: ReturnType<typeof setTimeout> } | null = null;
const canDrop = (from: string | null, folder: string) =>
  !!from && from !== folder && !folder.startsWith(`${from}/`) && folderOf(from) !== folder;

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
  stopOpening();
}

function dragOver(e: DragEvent, folder: string) {
  if (!canDrop(dragging.value, folder)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  over.value = folder;
  // Hovering a closed folder opens it after a moment.
  // Once it has opened, it may open again (closed and hovered in another drag).
  if (folder && collapsed.value.has(folder) && opening?.folder !== folder) {
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

function drop(e: DragEvent, folder: string) {
  if (!canDrop(dragging.value, folder)) return;
  e.preventDefault();
  e.stopPropagation();
  const from = dragging.value!;
  dragEnd();
  if (folder) expand(folder);
  if (lastFocused.value === from) lastFocused.value = `${folder ? `${folder}/` : ''}${from.slice(from.lastIndexOf('/') + 1)}`;
  ctx.move(from, folder);
}

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
  if (el.getAttribute('role') !== 'treeitem' || e.altKey || e.ctrlKey || (e.metaKey && e.key !== 'Backspace')) return;
  const key = e.key === 'Backspace' && e.metaKey ? 'Delete' : e.key;
  const path = el.dataset.path!;
  const action = treeKey(items.value, path, key, e.shiftKey);
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
  select: (path) => ctx.open(path),
  showConflicts: (path) => ctx.openConflicts(path),
  prefetch: (path, now) => ctx.prefetch(path, now),
  toggle,
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
.tree [draggable='true'] { cursor: grab; }
.tree-file:hover > .tree-actions, .tree-dir-row:hover > .tree-actions,
.tree-file:focus-within > .tree-actions, .tree-dir:focus > .tree-dir-row > .tree-actions, .tree-actions:focus-within { display: flex; }
.tree-conflict { margin-left: 4px; color: var(--warn); font-size: 11px; cursor: pointer; text-decoration: underline dotted; }
.tree-readers { flex: none; align-self: center; margin-left: 5px; color: var(--muted); }
/* The count is what to click on a file with conflicts; Rename and Delete stay in its right-click menu. */
.tree-file.has-conflicts:hover > .tree-actions { display: none; }
</style>
