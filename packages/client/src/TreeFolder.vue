<script setup lang="ts">
// One folder's contents in the sidebar: its folders (each drawn by this same
// component), then its files: documents by title, other files by filename.
import { computed, inject } from 'vue';
import type { TreeFile } from './api.js';
import { shownName, TREE, type Folder } from './tree.js';
import FileIcon from './FileIcon.vue';

const props = defineProps<{ folder: Folder; depth: number }>();
const t = inject(TREE)!;
const { selected, collapsed, dragging, over } = t;

const folders = computed(() => [...props.folder.folders.values()].sort((a, b) => a.name.localeCompare(b.name)));
const indent = computed(() => ({ paddingLeft: `${8 + props.depth * 14}px` }));
/** A document still without a title shows its filename, dimmed. */
const untitled = (f: TreeFile) => f.title === null;
const tip = (f: TreeFile) => {
  if (f.cannotOpen) return `${f.path}: ${f.cannotOpen}`;
  if (!f.type) return `${f.path}: no document type opens this file`;
  if (untitled(f)) return `${f.path}: no title yet (Rename… or Header… gives it one)`;
  return f.title ? `${f.title}\n${f.path}` : f.path;
};
</script>

<template>
  <li
    v-for="f in folders"
    :key="`d:${f.path}`"
    :class="['tree-dir', { 'drop-target': over === f.path, dragging: dragging === f.path }]"
    @dragover="t.dragOver($event, f.path)"
    @drop="t.drop($event, f.path)"
  >
    <div
      class="tree-dir-row"
      draggable="true"
      :data-testid="`folder:${f.path}`"
      @dragstart="t.dragStart($event, f.path)"
      @dragend="t.dragEnd()"
      @contextmenu="t.contextMenu($event, f.path, 'folder')"
    >
      <button type="button" class="tree-row tree-folder" :style="indent" @click="t.toggle(f.path)">
        <span class="tree-icon">{{ collapsed.has(f.path) ? '▸' : '▾' }}</span>{{ f.name }}
      </button>
      <span class="tree-actions">
        <button type="button" :title="`New file in ${f.name}`" :aria-label="`New file in ${f.name}`" @click="t.create(f.path)">＋</button>
        <button type="button" :title="`New folder in ${f.name}`" :aria-label="`New folder in ${f.name}`" @click="t.newFolder(f.path)">⊞</button>
      </span>
    </div>
    <ul v-if="!collapsed.has(f.path)"><TreeFolder :folder="f" :depth="depth + 1" /></ul>
  </li>
  <li
    v-for="f in folder.files"
    :key="f.path"
    :class="['tree-file', { selected: selected === f.path, untyped: !f.type, untitled: untitled(f), dragging: dragging === f.path }]"
    draggable="true"
    @dragstart="t.dragStart($event, f.path)"
    @dragend="t.dragEnd()"
    @contextmenu="t.contextMenu($event, f.path, 'file')"
  >
    <button
      type="button"
      class="tree-row"
      :style="indent"
      :disabled="!f.type"
      :title="tip(f)"
      :data-testid="`file:${f.path}`"
      @click="t.select(f.path)"
    >
      <FileIcon class="tree-icon" :icon="t.iconFor(f)" /><span class="tree-name">{{ shownName(f) }}</span>
      <span
        v-if="f.conflicts"
        class="tree-conflict"
        :data-testid="`conflicts:${f.path}`"
        :title="`${f.conflicts} conflict${f.conflicts === 1 ? '' : 's'} from a merge: both versions are in the document, to choose between`"
      >{{ f.conflicts }} conflict{{ f.conflicts === 1 ? '' : 's' }}</span>
    </button>
    <span class="tree-actions">
      <button type="button" title="Rename" @click="t.rename(f.path)">✎</button>
      <button type="button" title="Delete" @click="t.remove(f.path)">✕</button>
    </span>
  </li>
</template>
