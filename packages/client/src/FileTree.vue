<script setup lang="ts">
// The sidebar: the workspace's name, its files and folders, new files and
// folders, renaming, deleting, and moving by dragging. Right-click a file or
// folder for what can be done with it (a document's header, among others).
import { computed, provide, ref, shallowRef, toRef } from 'vue';
import type { TypeRegistry } from '@kuraa/kernel';
import type { HostApi, TreeFile } from './api.js';
import { askConfirm, askText } from './ask.js';
import { buildTree, fileTypeChoices, TREE } from './tree.js';
import NewFileDialog from './NewFileDialog.vue';
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
  /** Types whose documents have a header to edit (their format's editor module says so). */
  headerTypes?: string[];
}>();
const emit = defineEmits<{
  select: [path: string];
  /** Something changed: refresh, and open this file afterwards (null: none; omitted: as is). */
  changed: [selectPath?: string | null];
  error: [message: string];
  /** Open this file and its Header dialog. */
  header: [path: string];
}>();

const tree = computed(() => buildTree(props.files));
const collapsed = ref(new Set<string>());
const expand = (folder: string) => {
  if (!collapsed.value.has(folder)) return;
  const next = new Set(collapsed.value);
  next.delete(folder);
  collapsed.value = next;
};
const toggle = (folder: string) => {
  const next = new Set(collapsed.value);
  if (next.has(folder)) next.delete(folder);
  else next.add(folder);
  collapsed.value = next;
};

async function act(fn: () => Promise<unknown>, select?: string | null) {
  try {
    await fn();
    emit('changed', select);
  } catch (e) {
    emit('error', (e as Error).message);
  }
}

/** The folder of the open file: where new things go unless a folder is named. */
const here = () => (props.selected?.includes('/') ? props.selected.slice(0, props.selected.lastIndexOf('/') + 1) : '');

// New files: a document is made with its title (its header), its filename made from that.
const creating = ref<string | null>(null);
const paths = computed(() => props.files.map((f) => f.path));
const typeChoices = computed(() => fileTypeChoices(props.registry));
const typeOf = (p: string) => props.registry.resolve(p)?.id ?? null;

function create(folder?: string) {
  creating.value = folder !== undefined ? (folder ? `${folder}/` : '') : here();
}

async function made(file: { path: string; type: string; title: string | null }) {
  creating.value = null;
  const type = props.registry.get(file.type);
  const content = file.title && type?.title ? type.title.write('', file.title) : '';
  await act(() => props.api.createFile(file.path, content), file.path);
}

async function newFolder(inside?: string) {
  const base = inside !== undefined ? (inside ? `${inside}/` : '') : here();
  const path = (await askText('New folder', `${base}new-folder`, 'Create'))?.trim().replace(/\/+$/, '');
  if (!path) return;
  expand(path);
  await act(() => props.api.createFolder(path), props.selected);
}

// Renaming: a document's title and filename together; any other file's name (or path).
const renaming = ref<TreeFile | null>(null);

async function rename(from: string) {
  const file = props.files.find((f) => f.path === from);
  const type = file?.type ? props.registry.get(file.type) : undefined;
  if (file && type?.title) {
    renaming.value = file;
    return;
  }
  const to = (await askText('Rename to', from, 'Rename'))?.trim();
  if (to && to !== from) await act(() => props.api.renameFile(from, to), props.selected === from ? to : props.selected);
}

async function renamed(change: { to: string; title: string }) {
  const file = renaming.value!;
  renaming.value = null;
  const title = change.title !== file.title ? change.title : undefined;
  if (change.to === file.path && title === undefined) return;
  await act(() => props.api.renameFile(file.path, change.to, title), props.selected === file.path ? change.to : props.selected);
}

/** Rename (or move, if the path's folder changes) a folder with everything in it. */
async function renameFolder(from: string) {
  const to = (await askText('Rename folder to', from, 'Rename'))?.trim().replace(/\/+$/, '');
  if (!to || to === from) return;
  // The open file follows if it is inside; the folder stays open or closed as it was.
  const selected = props.selected;
  const follow = selected?.startsWith(`${from}/`) ? to + selected.slice(from.length) : selected;
  const rekey = (p: string) => (p === from || p.startsWith(`${from}/`) ? to + p.slice(from.length) : p);
  try {
    await props.api.renameFile(from, to);
    collapsed.value = new Set([...collapsed.value].map(rekey));
    if (to.includes('/')) expand(folderOf(to));
    emit('changed', follow);
  } catch (e) {
    emit('error', (e as Error).message);
  }
}

async function remove(path: string) {
  if (await askConfirm(`Delete ${path}? The deletion is committed; the file stays in history.`, 'Delete', true)) {
    await act(() => props.api.deleteFile(path), props.selected === path ? null : props.selected);
  }
}

// Moving by dragging: a file or folder onto a folder (or anywhere in it), or
// onto the workspace name or the top level. A move is a rename (committed).
const dragging = ref<string | null>(null);
const over = ref<string | null>(null);
let opening: { folder: string; timer: ReturnType<typeof setTimeout> } | null = null;
const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const canDrop = (from: string | null, folder: string) =>
  !!from && from !== folder && !folder.startsWith(`${from}/`) && folderOf(from) !== folder;

async function move(from: string, folder: string) {
  const to = `${folder ? `${folder}/` : ''}${from.slice(from.lastIndexOf('/') + 1)}`;
  // The open file follows: itself moved, or inside a folder that moved.
  const selected = props.selected;
  const follow = selected === from ? to : selected?.startsWith(`${from}/`) ? to + selected.slice(from.length) : selected;
  if (folder) expand(folder);
  await act(() => props.api.renameFile(from, to), follow);
}

function dragStart(e: DragEvent, path: string) {
  e.stopPropagation();
  e.dataTransfer?.setData('application/x-kuraa-path', path);
  e.dataTransfer?.setData('text/plain', path);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
  dragging.value = path;
}

function dragEnd() {
  dragging.value = null;
  over.value = null;
}

function dragOver(e: DragEvent, folder: string) {
  if (!canDrop(dragging.value, folder)) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
  over.value = folder;
  // Hovering a closed folder opens it after a moment.
  if (folder && collapsed.value.has(folder) && opening?.folder !== folder) {
    if (opening) clearTimeout(opening.timer);
    opening = { folder, timer: setTimeout(() => expand(folder), 600) };
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

// The right-click menu.
const menu = shallowRef<{ x: number; y: number; items: ContextItem[] } | null>(null);

function contextMenu(e: MouseEvent, path: string, kind: 'file' | 'folder' | 'top') {
  e.preventDefault();
  e.stopPropagation();
  // From the keyboard (the menu key, Shift+F10), there is no pointer: open it by the row.
  let { clientX: x, clientY: y } = e;
  if (!x && !y) {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    x = box.left + 24;
    y = box.bottom;
  }
  const name = path.slice(path.lastIndexOf('/') + 1);
  let items: ContextItem[];
  if (kind === 'file') {
    const file = props.files.find((f) => f.path === path);
    items = [
      ...(file?.type ? [{ label: 'Open', run: () => emit('select', path), testid: 'context:open' }] : []),
      ...(file?.type && props.headerTypes?.includes(file.type) ? [{ label: 'Header…', run: () => emit('header', path), testid: 'context:header' }] : []),
      { label: 'Rename…', run: () => void rename(path), testid: 'context:rename' },
      { label: 'Delete…', run: () => void remove(path), danger: true, testid: 'context:delete' },
    ];
  } else {
    const where = kind === 'folder' ? ` in ${name}` : '';
    items = [
      { label: `New file${where}…`, run: () => void create(path), testid: 'context:new-file' },
      { label: `New folder${where}…`, run: () => void newFolder(path), testid: 'context:new-folder' },
      ...(kind === 'folder' ? [{ label: 'Rename…', run: () => void renameFolder(path), testid: 'context:rename-folder' }] : []),
    ];
  }
  menu.value = { x, y, items };
}

provide(TREE, {
  selected: toRef(props, 'selected'),
  collapsed,
  dragging,
  over,
  select: (path) => emit('select', path),
  toggle,
  create: (folder) => void create(folder),
  newFolder: (inside) => void newFolder(inside),
  rename: (path) => void rename(path),
  remove: (path) => void remove(path),
  contextMenu,
  dragStart,
  dragEnd,
  dragOver,
  drop,
});
</script>

<template>
  <nav class="pane pane-left" aria-label="Files">
    <div :class="['pane-header', { 'drop-target': over === '' }]" @dragover="dragOver($event, '')" @drop="drop($event, '')">
      <span class="workspace-name" :title="workspaceName" data-testid="workspace-name">{{ workspaceName }}</span>
      <span class="pane-header-actions">
        <button type="button" title="New file" aria-label="New file" @click="create()">＋</button>
        <button type="button" title="New folder" aria-label="New folder" @click="newFolder()">⊞</button>
      </span>
    </div>
    <ul
      :class="['tree', { 'drop-target': over === '' }]"
      @dragover="dragOver($event, '')"
      @drop="drop($event, '')"
      @contextmenu="contextMenu($event, '', 'top')"
    >
      <TreeFolder :folder="tree" :depth="0" />
    </ul>
    <div v-if="$slots.footer" class="pane-footer"><slot name="footer" /></div>
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menu.items" @close="menu = null" />
    <NewFileDialog
      v-if="creating !== null"
      :folder="creating"
      :types="typeChoices"
      default-type="pandoc-markdown"
      :paths="paths"
      :type-of="typeOf"
      @create="made"
      @cancel="creating = null"
    />
    <RenameDialog v-if="renaming" :path="renaming.path" :title="renaming.title ?? null" :paths="paths" @rename="renamed" @cancel="renaming = null" />
  </nav>
</template>
