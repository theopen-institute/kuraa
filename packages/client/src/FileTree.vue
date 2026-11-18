<script setup lang="ts">
// The sidebar: the workspace's name, its files and folders, new files and
// folders, renaming, deleting, and moving by dragging.
import { computed, provide, ref, toRef } from 'vue';
import type { TypeRegistry } from '@kuraa/kernel';
import type { HostApi, TreeFile } from './api.js';
import { askConfirm, askNewFile, askText } from './ask.js';
import { buildTree, fileTypeChoices, TREE } from './tree.js';
import TreeFolder from './TreeFolder.vue';

const props = defineProps<{
  api: HostApi;
  files: TreeFile[];
  selected: string | null;
  /** The document types this client opens; offered when creating a file. */
  registry: TypeRegistry;
  /** The workspace folder's name, shown at the top. */
  workspaceName: string;
}>();
const emit = defineEmits<{
  select: [path: string];
  /** Something changed: refresh, and open this file afterwards (null: none; omitted: as is). */
  changed: [selectPath?: string | null];
  error: [message: string];
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

async function create(folder?: string) {
  const base = folder !== undefined ? (folder ? `${folder}/` : '') : here();
  const path = await askNewFile({
    folder: base,
    types: fileTypeChoices(props.registry),
    defaultType: 'pandoc-markdown',
    typeOf: (p) => props.registry.resolve(p)?.id ?? null,
  });
  if (path) await act(() => props.api.createFile(path, ''), path);
}

async function newFolder(inside?: string) {
  const base = inside !== undefined ? (inside ? `${inside}/` : '') : here();
  const path = (await askText('New folder', `${base}new-folder`, 'Create'))?.trim().replace(/\/+$/, '');
  if (!path) return;
  expand(path);
  await act(() => props.api.createFolder(path), props.selected);
}

async function rename(from: string) {
  const to = (await askText('Rename to', from, 'Rename'))?.trim();
  if (to && to !== from) await act(() => props.api.renameFile(from, to), props.selected === from ? to : props.selected);
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
    <ul :class="['tree', { 'drop-target': over === '' }]" @dragover="dragOver($event, '')" @drop="drop($event, '')">
      <TreeFolder :folder="tree" :depth="0" />
    </ul>
    <div v-if="$slots.footer" class="pane-footer"><slot name="footer" /></div>
  </nav>
</template>
