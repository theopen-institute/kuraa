<script setup lang="ts">
// The sidebar: the workspace's name, its files and folders, new files and
// folders, renaming, deleting, and moving (by dragging). Right-click a file or
// folder for what can be done with it (a document's settings, among others). It
// is a tree for the keyboard too: one
// row in the Tab order, arrows to move and open folders, Enter to open, F2 to
// rename, Delete to delete, Shift+F10 for the menu (tree.ts, treeKey).
import { computed, nextTick, onBeforeUnmount, provide, ref, shallowRef, toRef, useTemplateRef, watch } from 'vue';
import type { TypeRegistry } from '@kuraa/kernel';
import type { HostApi, TreeFile } from './api.js';
import { askConfirm, askText } from './ask.js';
import { buildTree, fileTypeChoices, TREE, treeKey, visibleItems } from './tree.js';
import { pathForTitle } from './filenames.js';
import { S } from './strings.js';
import RenameDialog from './RenameDialog.vue';
import TreeFolder from './TreeFolder.vue';
import ContextMenu, { type ContextItem } from './ContextMenu.vue';

const props = defineProps<{
  api: HostApi;
  files: TreeFile[];
  selected: string | null;
  /** The document types this client opens; offered when creating a file. */
  registry: TypeRegistry;
  /** The workspace folder's name, shown at the top. */
  workspaceName: string;
  /** The workspace is shared with other people's devices: Permissions… is offered (0066, 0067). */
  shared?: boolean;
  /** Folders with permissions of their own (0069): their path (`dir/`), who reads and who may change, in words. */
  folders?: { path: string; readers?: string; writers?: string }[];
}>();
const emit = defineEmits<{
  select: [path: string];
  /** Something changed: refresh, and open this file afterwards (null: none; omitted: as is). */
  changed: [selectPath?: string | null];
  error: [error: unknown];
  /** Open this file and its Document settings. */
  documentSettings: [path: string];
  /** A new document was made by New file: it opens with the cursor in its title. */
  created: [path: string];
  /** Open this file at its first conflict. */
  conflicts: [path: string];
  /** This file's permissions: who can read it, and who can change it (0066, 0067). */
  permissions: [path: string];
}>();

const tree = computed(() => buildTree(props.files));
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

async function act(fn: () => Promise<unknown>, select?: string | null) {
  try {
    await fn();
    emit('changed', select);
  } catch (e) {
    emit('error', e);
  }
}

const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
/** The folder of the open file: where new things go unless a folder is named. */
const here = () => (props.selected?.includes('/') ? props.selected.slice(0, props.selected.lastIndexOf('/') + 1) : '');

// New files: an untitled Markdown document, made at once and opened, its title
// typed in the page. Its filename follows the title it is given (when it is
// left), as long as it has the name it was made with. Another kind of file is
// a Rename… away (the dialog has the file's type).
const paths = computed(() => props.files.map((f) => f.path));
const typeChoices = computed(() => fileTypeChoices(props.registry));
const typeOf = (p: string) => props.registry.resolve(p)?.id ?? null;
/** The kind of document New file makes. */
const NEW_TYPE = 'pandoc-markdown';
/** Documents New file made here, by path: their title as last seen while open, and the workspace they are in. */
const fresh = new Map<string, { title: string | null; api: HostApi }>();

/** A new document: in `folder` ('' for the top level), or beside the open file. */
async function create(folder?: string) {
  const dir = folder !== undefined ? (folder ? `${folder}/` : '') : here();
  const type = typeChoices.value.find((t) => t.id === NEW_TYPE) ?? typeChoices.value.find((t) => t.titled) ?? typeChoices.value[0];
  if (!type) return;
  const path = pathForTitle(S.tree.untitledName, type.extension, dir, paths.value);
  if (dir) expand(dir.replace(/\/$/, ''));
  if (type.titled) fresh.set(path, { title: null, api: props.api });
  emit('created', path);
  await act(() => props.api.createFile(path, ''), path);
}
defineExpose({ create });

// A new document's title, while it is open; once it is left, its filename is made from that title.
watch(() => [props.selected, props.files] as const, ([selected, files], [before]) => {
  const made = selected ? fresh.get(selected) : undefined;
  if (made?.api === props.api) made.title = files.find((f) => f.path === selected)?.title ?? null;
  if (before && before !== selected && fresh.has(before)) void nameAfterTitle(before);
});

async function nameAfterTitle(path: string) {
  const made = fresh.get(path);
  // Left for another workspace: it keeps its name (this list is the other workspace's now).
  if (!made?.title || made.api !== props.api) return;
  const title = made.title;
  fresh.delete(path);
  const folder = path.slice(0, path.lastIndexOf('/') + 1);
  const name = path.slice(folder.length);
  const extension = name.slice(name.lastIndexOf('.'));
  const to = pathForTitle(title, extension, folder, paths.value, path);
  if (to === path || !paths.value.includes(path)) return;
  if (tabStop.value === path) tabStop.value = to;
  await act(() => props.api.renameFile(path, to), props.selected);
}

async function newFolder(inside?: string) {
  const base = inside !== undefined ? (inside ? `${inside}/` : '') : here();
  const path = (await askText(S.tree.newFolder, `${base}new-folder`, S.common.create))?.trim().replace(/\/+$/, '');
  if (!path) return;
  expand(path);
  await act(() => props.api.createFolder(path), props.selected);
}

// Renaming: a document's title and filename together; any other file's name (or path).
const renaming = ref<TreeFile | null>(null);

async function rename(from: string) {
  const file = props.files.find((f) => f.path === from);
  // A file of a kind kuraa opens: its title (for a document), its name, and its kind.
  if (file?.type && typeChoices.value.some((t) => t.id === file.type)) {
    renaming.value = file;
    return;
  }
  const to = (await askText(S.tree.renameTo, from, S.common.rename))?.trim();
  if (to && to !== from) await act(() => props.api.renameFile(from, to), props.selected === from ? to : props.selected);
}

async function renamed(change: { to: string; title?: string }) {
  const file = renaming.value!;
  renaming.value = null;
  // Named by hand: no longer named after its title when it is left.
  fresh.delete(file.path);
  const title = change.title !== undefined && change.title !== file.title ? change.title : undefined;
  if (change.to === file.path && title === undefined) return;
  await act(() => props.api.renameFile(file.path, change.to, title), props.selected === file.path ? change.to : props.selected);
}

/** Rename (or move, if the path's folder changes) a folder with everything in it. */
async function renameFolder(from: string) {
  const to = (await askText(S.tree.renameFolderTo, from, S.common.rename))?.trim().replace(/\/+$/, '');
  if (!to || to === from) return;
  // The open file follows if it is inside; the folder stays open or closed as it was.
  const selected = props.selected;
  const follow = selected?.startsWith(`${from}/`) ? to + selected.slice(from.length) : selected;
  const rekey = (p: string) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
  try {
    await props.api.renameFile(from, to);
    collapsed.value = new Set([...collapsed.value].map(rekey));
    if (to.includes('/')) expand(folderOf(to));
    tabStop.value = rekey(tabStop.value ?? '') || null;
    emit('changed', follow);
  } catch (e) {
    emit('error', e);
  }
}

async function remove(path: string) {
  const name = props.files.find((f) => f.path === path)?.title || path.slice(path.lastIndexOf('/') + 1);
  if (await askConfirm(S.tree.deleteAsk(name), S.common.delete, true)) {
    await act(() => props.api.deleteFile(path), props.selected === path ? null : props.selected);
  }
}

// Moving: by dragging a file or folder onto a folder (or anywhere in it), or
// onto the workspace name or the top level. A move is a rename (saved, as
// everything is).
const dragging = ref<string | null>(null);
const over = ref<string | null>(null);
let opening: { folder: string; timer: ReturnType<typeof setTimeout> } | null = null;
const canDrop = (from: string | null, folder: string) =>
  !!from && from !== folder && !folder.startsWith(`${from}/`) && folderOf(from) !== folder;

async function move(from: string, folder: string) {
  const to = `${folder ? `${folder}/` : ''}${from.slice(from.lastIndexOf('/') + 1)}`;
  // The open file follows: itself moved, or inside a folder that moved.
  const selected = props.selected;
  const follow = selected === from ? to : selected?.startsWith(`${from}/`) ? to + selected.slice(from.length) : selected;
  if (folder) expand(folder);
  if (tabStop.value === from) tabStop.value = to;
  await act(() => props.api.renameFile(from, to), follow);
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
onBeforeUnmount(stopOpening);

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
  void move(from, folder);
}

// The right-click menu (also Shift+F10 or the menu key on a row). A file has
// what is done to that file (opening it is a click); a folder or the top level,
// what goes in it.
const menu = shallowRef<{ x: number; y: number; items: ContextItem[] } | null>(null);

function menuItems(path: string, kind: 'file' | 'folder' | 'top'): ContextItem[] {
  const name = path.slice(path.lastIndexOf('/') + 1);
  if (kind === 'file') {
    const file = props.files.find((f) => f.path === path);
    return [
      ...(file?.type ? [{ label: S.tree.documentSettings, run: () => emit('documentSettings', path), testid: 'context:document-settings' }] : []),
      ...(props.shared ? [{ label: S.permissions.menu, run: () => emit('permissions', path), testid: 'context:permissions' }] : []),
      { label: S.common.renameEllipsis, run: () => void rename(path), testid: 'context:rename' },
      { label: S.common.deleteEllipsis, run: () => void remove(path), danger: true, testid: 'context:delete' },
    ];
  }
  const where = kind === 'folder' ? S.tree.inFolder(name) : '';
  return [
    { label: S.tree.newFileMenu(where), run: () => create(path), testid: 'context:new-file' },
    { label: S.tree.newFolderMenu(where), run: () => void newFolder(path), testid: 'context:new-folder' },
    ...(kind === 'folder' ? [
      ...(props.shared ? [{ label: S.permissions.menu, run: () => emit('permissions', `${path}/`), testid: 'context:folder-permissions' }] : []),
      { label: S.common.renameEllipsis, run: () => void renameFolder(path), testid: 'context:rename-folder' },
    ] : []),
  ];
}

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
  menu.value = { x, y, items: menuItems(path, kind) };
}

/** The menu for a row, from the keyboard (Shift+F10): by the row. */
function menuFor(el: HTMLElement, path: string, kind: 'file' | 'folder' | 'top') {
  const row = (el.querySelector('.tree-row') as HTMLElement | null) ?? el;
  const box = row.getBoundingClientRect();
  menu.value = { x: box.left + 24, y: box.bottom, items: menuItems(path, kind) };
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
    if (shown(props.selected)) return props.selected;
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
      const file = props.files.find((f) => f.path === action.path);
      if (file?.type) emit('select', action.path);
      break;
    }
    case 'rename': void (folder ? renameFolder(action.path) : rename(action.path)); break;
    case 'delete': if (!folder) void remove(action.path); break;
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

// Asking for a file's room ahead (the pointer rests on it, or is pressed on it): the host gets it
// ready, and keeps it a while, so opening it needs no waiting for that. Once a minute at most per file.
const PREFETCH_HOVER_MS = 150;
const PREFETCH_AGAIN_MS = 60_000;
const prefetched = new Map<string, number>();
let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
function prefetch(path: string | null, now = false) {
  clearTimeout(prefetchTimer);
  if (!path || path === props.selected) return;
  const go = () => {
    const at = prefetched.get(path);
    if (at !== undefined && Date.now() - at < PREFETCH_AGAIN_MS) return;
    prefetched.set(path, Date.now());
    props.api.room(path).catch(() => prefetched.delete(path));
  };
  if (now) go();
  else prefetchTimer = setTimeout(go, PREFETCH_HOVER_MS);
}
onBeforeUnmount(() => clearTimeout(prefetchTimer));
// Another workspace: its files are other files.
watch(() => props.api, () => prefetched.clear());

provide(TREE, {
  selected: toRef(props, 'selected'),
  collapsed,
  tabStop,
  focused: (path) => {
    tabStop.value = path;
  },
  dragging,
  over,
  select: (path) => emit('select', path),
  showConflicts: (path) => emit('conflicts', path),
  prefetch,
  toggle,
  create: (folder) => create(folder),
  newFolder: (inside) => void newFolder(inside),
  rename: (path) => void rename(path),
  remove: (path) => void remove(path),
  iconFor: (f) => (f.type ? props.registry.get(f.type)?.icon?.(f.path) : undefined),
  folderMarks: computed(() => new Map((props.folders ?? []).map((m) => [m.path.replace(/\/$/, ''), m]))),
  contextMenu,
  dragStart,
  dragEnd,
  dragOver,
  drop,
});
</script>

<template>
  <nav class="pane pane-left" :aria-label="S.tree.label">
    <div :class="['pane-header', { 'drop-target': over === '' }]" @dragover="dragOver($event, '')" @drop="drop($event, '')">
      <slot name="title"><span class="workspace-name" :title="workspaceName" data-testid="workspace-name">{{ workspaceName }}</span></slot>
      <span class="pane-header-actions">
        <slot name="actions" />
        <button type="button" :title="S.tree.newFile" :aria-label="S.tree.newFile" @click="create()">＋</button>
      </span>
    </div>
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
        :aria-label="items.length ? undefined : S.tree.space"
        @keydown="onSpaceKey"
        @contextmenu="contextMenu($event, '', 'top')"
      />
    </div>
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menu.items" @close="menu = null" />
    <RenameDialog
      v-if="renaming"
      :path="renaming.path"
      :title="renaming.title ?? null"
      :paths="paths"
      :types="typeChoices"
      :type="renaming.type!"
      :type-of="typeOf"
      @rename="renamed"
      @cancel="renaming = null"
    />
  </nav>
</template>
