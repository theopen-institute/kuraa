<script setup lang="ts">
// One folder's contents in the file tree: its folders (each drawn by this same
// component), then its files: documents by title, other files by filename.
// Each row is a tree item (FilesView.vue has the keys); one of them is in the
// Tab order at a time, and the arrows move between them.
import { computed, inject } from 'vue';
import type { NavigationFile as TreeFile } from '@kuraa/feature-kit/client';
import { foldersOf, shownName, TREE, type Folder } from './tree.js';
import { S } from './strings.js';
import FileIcon from '@kuraa/feature-ui/FileIcon.vue';

/** A folder's icon, drawn as files' are (FileIcon): closed, or open while its contents show. */
const FOLDER = { paths: ['M1.5 12.5v-9h4.25l1.5 1.5h7.25v7.5z'] };
const FOLDER_OPEN = { paths: ['M1.5 12.5v-9h4.25l1.5 1.5h5.75v2', 'M1.5 12.5l2.25-5.5h11l-2.25 5.5z'] };
/** New file and New folder, beside a folder: a page and a folder, each with a plus. */
const NEW_FILE = { paths: ['M8.5 14.5H3.5v-13h5.5l3 3v4', 'M9 1.5v3h3', 'M12 10.5v4', 'M10 12.5h4'] };
const NEW_FOLDER = { paths: ['M8.5 12.5h-7v-9h4.25l1.5 1.5h7.25v3.5', 'M12 9.5v5', 'M9.5 12h5'] };

const props = defineProps<{ folder: Folder; depth: number }>();
const t = inject(TREE)!;
const { selected, collapsed, dragging, over, tabStop } = t;

const folders = computed(() => foldersOf(props.folder));
const indent = computed(() => ({ paddingLeft: `${8 + props.depth * 14}px` }));
/** A folder's own permissions, in words (0069), if it has any. */
const markOf = (path: string) => t.folderMarks.value.get(path) ?? {};
/** A document still without a title shows its filename, dimmed. */
const untitled = (f: TreeFile) => f.title === null;
const tip = (f: TreeFile) => {
  if (f.cannotOpen) return `${f.path}: ${f.cannotOpen}`;
  if (!f.type) return S.noType(f.path);
  if (untitled(f)) return S.untitled(f.path);
  return f.title ? `${f.title}\n${f.path}` : f.path;
};
/** What a file row is called to a screen reader: its name, and its conflicts if it has any. */
const fileLabel = (f: TreeFile) => (f.conflicts ? `${shownName(f)}, ${S.conflicts(f.conflicts)}` : shownName(f));
</script>

<template>
  <li
    v-for="f in folders"
    :key="`d:${f.path}`"
    role="treeitem"
    :aria-expanded="!collapsed.has(f.path)"
    :aria-level="depth + 1"
    :aria-label="f.name"
    :tabindex="tabStop === f.path ? 0 : -1"
    :data-path="f.path"
    :class="['tree-dir', { 'drop-target': over === f.path, dragging: dragging === f.path }]"
    @focus.self="t.focused(f.path)"
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
      @click="t.toggle(f.path)"
    >
      <span class="tree-row tree-folder" :style="indent">
        <FileIcon class="tree-icon" :icon="collapsed.has(f.path) ? FOLDER : FOLDER_OPEN" /><span class="tree-name">{{ f.name }}</span>
        <template v-if="t.folderMarks.value.has(f.path)">
          <svg v-if="markOf(f.path).readers" class="tree-readers" viewBox="0 0 12 12" width="11" height="11" role="img" :aria-label="S.readers(markOf(f.path).readers ?? '')" :data-testid="`readers:${f.path + '/'}`"><title>{{ S.readers(markOf(f.path).readers ?? '') }}</title><rect x="2" y="5.5" width="8" height="5.5" rx="1.2" fill="currentColor" /><path d="M3.8 5.5V4a2.2 2.2 0 0 1 4.4 0v1.5" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
          <svg v-if="markOf(f.path).writers" class="tree-readers" viewBox="0 0 12 12" width="11" height="11" role="img" :aria-label="S.writers(markOf(f.path).writers ?? '')" :data-testid="`writers:${f.path + '/'}`"><title>{{ S.writers(markOf(f.path).writers ?? '') }}</title><path d="M2 10l.6-2.4L8 2.2 9.8 4 4.4 9.4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /><path d="M2 10.5h8" stroke="currentColor" stroke-width="1.1" /></svg>
        </template>
      </span>
      <span class="tree-actions">
        <button type="button" tabindex="-1" :title="S.newFileIn(f.name)" :aria-label="S.newFileIn(f.name)" @click.stop="t.create(f.path)"><FileIcon :icon="NEW_FILE" /></button>
        <button type="button" tabindex="-1" :title="S.newFolderIn(f.name)" :aria-label="S.newFolderIn(f.name)" @click.stop="t.newFolder(f.path)"><FileIcon :icon="NEW_FOLDER" /></button>
      </span>
    </div>
    <ul v-if="!collapsed.has(f.path)" role="group"><TreeFolder :folder="f" :depth="depth + 1" /></ul>
  </li>
  <li
    v-for="f in folder.files"
    :key="f.path"
    role="treeitem"
    :aria-level="depth + 1"
    :aria-label="fileLabel(f)"
    :aria-current="selected === f.path ? 'page' : undefined"
    :tabindex="tabStop === f.path ? 0 : -1"
    :data-path="f.path"
    :class="['tree-file', { selected: selected === f.path, untyped: !f.type, untitled: untitled(f), dragging: dragging === f.path, 'has-conflicts': !!f.conflicts }]"
    draggable="true"
    @focus.self="t.focused(f.path)"
    @dragstart="t.dragStart($event, f.path)"
    @dragend="t.dragEnd()"
    @contextmenu="t.contextMenu($event, f.path, 'file')"
    @click="f.type && t.select(f.path)"
    @mouseenter="f.type && t.prefetch(f.path)"
    @mouseleave="t.prefetch(null)"
    @mousedown="f.type && t.prefetch(f.path, true)"
  >
    <div class="tree-row" :style="indent" :title="tip(f)" :data-testid="`file:${f.path}`">
      <FileIcon class="tree-icon" :icon="t.iconFor(f)" /><span class="tree-name">{{ shownName(f) }}</span>
      <svg v-if="f.readers" class="tree-readers" viewBox="0 0 12 12" width="11" height="11" role="img" :aria-label="S.readers(f.readers)" :data-testid="`readers:${f.path}`"><title>{{ S.readers(f.readers) }}</title><rect x="2" y="5.5" width="8" height="5.5" rx="1.2" fill="currentColor" /><path d="M3.8 5.5V4a2.2 2.2 0 0 1 4.4 0v1.5" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
      <svg v-if="f.writers" class="tree-readers" viewBox="0 0 12 12" width="11" height="11" role="img" :aria-label="S.writers(f.writers)" :data-testid="`writers:${f.path}`"><title>{{ S.writers(f.writers) }}</title><path d="M2 10l.6-2.4L8 2.2 9.8 4 4.4 9.4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /><path d="M2 10.5h8" stroke="currentColor" stroke-width="1.1" /></svg>
      <span
        v-if="f.conflicts"
        class="tree-conflict"
        :data-testid="`conflicts:${f.path}`"
        :title="S.conflictsTitle(f.conflicts)"
        @click.stop="t.showConflicts(f.path)"
      >{{ S.conflicts(f.conflicts) }}</span>
    </div>
    <span class="tree-actions">
      <button type="button" tabindex="-1" :title="S.rename" :aria-label="S.rename" @click.stop="t.rename(f.path)">✎</button>
      <button type="button" tabindex="-1" :title="S.delete" :aria-label="S.delete" @click.stop="t.remove(f.path)">✕</button>
    </span>
  </li>
</template>
