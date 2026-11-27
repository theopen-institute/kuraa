<script setup lang="ts">
// One folder's contents in the file tree, in its order (0093: as arranged,
// where it has one; else folders, then files by name): each folder drawn by
// this same component; documents by title, other files by filename. Each row
// is a tree item (FilesView.vue has the keys); one of them is in the Tab order
// at a time, and the arrows move between them. Features' marks (a manuscript's
// folder, a document left out of it) are drawn beside the name.
import { computed, inject } from 'vue';
import type { FileMark, NavigationFile as TreeFile } from '@kuraa/feature-kit/client';
import { shownName, TREE, type Folder } from './tree.js';
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
const { selected, collapsed, dragging, over, tabStop, beside } = t;

const indent = computed(() => ({ paddingLeft: `${8 + props.depth * 14}px` }));
/** Where a drop line starts: at the row's indent. */
const lineAt = computed(() => ({ '--drop-indent': `${8 + props.depth * 14}px` }));
/** A folder's own permissions, in words (0069), if it has any. */
const markOf = (path: string) => t.folderMarks.value.get(path) ?? {};
/** A document still without a title shows its filename, dimmed. */
const untitled = (f: TreeFile) => f.title === null;
const tip = (f: TreeFile, marks: FileMark[]) => {
  const said = marks.map((m) => `\n${m.label}`).join('');
  if (f.cannotOpen) return `${f.path}: ${f.cannotOpen}${said}`;
  if (!f.type) return S.noType(f.path) + said;
  if (untitled(f)) return S.untitled(f.path) + said;
  return (f.title ? `${f.title}\n${f.path}` : f.path) + said;
};
/** What a file row is called to a screen reader: its name, its marks, and its conflicts if it has any. */
const fileLabel = (f: TreeFile, marks: FileMark[]) => [shownName(f), ...marks.map((m) => m.label), ...(f.conflicts ? [S.conflicts(f.conflicts)] : [])].join(', ');
const dropSide = (path: string) => (beside.value?.path === path ? `drop-${beside.value.side}` : '');
const fileRow = (f: TreeFile) => ({ path: f.path, folder: false });
const folderRow = (f: Folder) => ({ path: f.path, folder: true });
</script>

<template>
  <template v-for="c in folder.children" :key="c.folder ? `d:${c.folder.path}` : c.file.path">
    <li
      v-if="c.folder"
      role="treeitem"
      :aria-expanded="!collapsed.has(c.folder.path)"
      :aria-level="depth + 1"
      :aria-label="[c.folder.name, ...t.marksOf(c.folder.path + '/').map((m) => m.label)].join(', ')"
      :tabindex="tabStop === c.folder.path ? 0 : -1"
      :data-path="c.folder.path"
      :style="lineAt"
      :class="['tree-dir', dropSide(c.folder.path), { shown: t.shownFolder.value === c.folder.path, 'drop-target': over === c.folder.path, dragging: dragging === c.folder.path, muted: t.marksOf(c.folder.path + '/').some((m) => m.muted) }]"
      @focus.self="t.focused(c.folder.path)"
      @dragover="t.dragOver($event, c.folder.path)"
      @drop="t.drop($event, c.folder.path)"
    >
      <div
        class="tree-dir-row"
        draggable="true"
        :data-testid="`folder:${c.folder.path}`"
        @dragstart="t.dragStart($event, c.folder.path)"
        @dragend="t.dragEnd()"
        @dragover="t.dragOver($event, c.folder.path, folderRow(c.folder))"
        @drop="t.drop($event, c.folder.path, folderRow(c.folder))"
        @contextmenu="t.contextMenu($event, c.folder.path, 'folder')"
        @click="t.openFolder(c.folder.path)"
      >
        <span class="tree-row tree-folder" :style="indent">
          <!-- The icon opens and closes the folder; the rest of the row shows it (0095: its corkboard, its outline). -->
          <span class="tree-fold" :title="collapsed.has(c.folder.path) ? S.unfold : S.fold" :data-testid="`fold:${c.folder.path}`" @click.stop="t.toggle(c.folder.path)"><FileIcon class="tree-icon" :icon="collapsed.has(c.folder.path) ? FOLDER : FOLDER_OPEN" /></span><span class="tree-name">{{ c.folder.name }}</span>
          <span v-for="m in t.marksOf(c.folder.path + '/')" :key="m.label" class="tree-mark" :title="m.label" :data-testid="m.testid"><FileIcon v-if="m.icon" :icon="m.icon" /><span v-else-if="m.color" class="tree-mark-dot" :style="{ background: m.color }" /></span>
          <template v-if="t.folderMarks.value.has(c.folder.path)">
            <svg v-if="markOf(c.folder.path).readers" class="tree-readers" viewBox="0 0 12 12" width="11" height="11" role="img" :aria-label="S.readers(markOf(c.folder.path).readers ?? '')" :data-testid="`readers:${c.folder.path + '/'}`"><title>{{ S.readers(markOf(c.folder.path).readers ?? '') }}</title><rect x="2" y="5.5" width="8" height="5.5" rx="1.2" fill="currentColor" /><path d="M3.8 5.5V4a2.2 2.2 0 0 1 4.4 0v1.5" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
            <svg v-if="markOf(c.folder.path).writers" class="tree-readers" viewBox="0 0 12 12" width="11" height="11" role="img" :aria-label="S.writers(markOf(c.folder.path).writers ?? '')" :data-testid="`writers:${c.folder.path + '/'}`"><title>{{ S.writers(markOf(c.folder.path).writers ?? '') }}</title><path d="M2 10l.6-2.4L8 2.2 9.8 4 4.4 9.4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /><path d="M2 10.5h8" stroke="currentColor" stroke-width="1.1" /></svg>
          </template>
        </span>
        <span class="tree-actions">
          <button type="button" tabindex="-1" :title="S.newFileIn(c.folder.name)" :aria-label="S.newFileIn(c.folder.name)" @click.stop="t.create(c.folder.path)"><FileIcon :icon="NEW_FILE" /></button>
          <button type="button" tabindex="-1" :title="S.newFolderIn(c.folder.name)" :aria-label="S.newFolderIn(c.folder.name)" @click.stop="t.newFolder(c.folder.path)"><FileIcon :icon="NEW_FOLDER" /></button>
        </span>
      </div>
      <ul v-if="!collapsed.has(c.folder.path)" role="group"><TreeFolder :folder="c.folder" :depth="depth + 1" /></ul>
    </li>
    <li
      v-else
      role="treeitem"
      :aria-level="depth + 1"
      :aria-label="fileLabel(c.file, t.marksOf(c.file.path))"
      :aria-current="selected === c.file.path ? 'page' : undefined"
      :tabindex="tabStop === c.file.path ? 0 : -1"
      :data-path="c.file.path"
      :style="lineAt"
      :class="['tree-file', dropSide(c.file.path), { selected: selected === c.file.path, untyped: !c.file.type, untitled: untitled(c.file), dragging: dragging === c.file.path, 'has-conflicts': !!c.file.conflicts, muted: t.marksOf(c.file.path).some((m) => m.muted) }]"
      draggable="true"
      @focus.self="t.focused(c.file.path)"
      @dragstart="t.dragStart($event, c.file.path)"
      @dragend="t.dragEnd()"
      @dragover="t.dragOver($event, folder.path, fileRow(c.file))"
      @drop="t.drop($event, folder.path, fileRow(c.file))"
      @contextmenu="t.contextMenu($event, c.file.path, 'file')"
      @click="c.file.type && t.select(c.file.path)"
      @mouseenter="c.file.type && t.prefetch(c.file.path)"
      @mouseleave="t.prefetch(null)"
      @mousedown="c.file.type && t.prefetch(c.file.path, true)"
    >
      <div class="tree-row" :style="indent" :title="tip(c.file, t.marksOf(c.file.path))" :data-testid="`file:${c.file.path}`">
        <FileIcon class="tree-icon" :icon="t.iconFor(c.file)" /><span class="tree-name">{{ shownName(c.file) }}</span>
        <span v-for="m in t.marksOf(c.file.path)" :key="m.label" class="tree-mark" :data-testid="m.testid"><FileIcon v-if="m.icon" :icon="m.icon" /><span v-else-if="m.color" class="tree-mark-dot" :style="{ background: m.color }" /></span>
        <svg v-if="c.file.readers" class="tree-readers" viewBox="0 0 12 12" width="11" height="11" role="img" :aria-label="S.readers(c.file.readers)" :data-testid="`readers:${c.file.path}`"><title>{{ S.readers(c.file.readers) }}</title><rect x="2" y="5.5" width="8" height="5.5" rx="1.2" fill="currentColor" /><path d="M3.8 5.5V4a2.2 2.2 0 0 1 4.4 0v1.5" fill="none" stroke="currentColor" stroke-width="1.3" /></svg>
        <svg v-if="c.file.writers" class="tree-readers" viewBox="0 0 12 12" width="11" height="11" role="img" :aria-label="S.writers(c.file.writers)" :data-testid="`writers:${c.file.path}`"><title>{{ S.writers(c.file.writers) }}</title><path d="M2 10l.6-2.4L8 2.2 9.8 4 4.4 9.4z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" /><path d="M2 10.5h8" stroke="currentColor" stroke-width="1.1" /></svg>
        <span
          v-if="c.file.conflicts"
          class="tree-conflict"
          :data-testid="`conflicts:${c.file.path}`"
          :title="S.conflictsTitle(c.file.conflicts)"
          @click.stop="t.showConflicts(c.file.path)"
        >{{ S.conflicts(c.file.conflicts) }}</span>
      </div>
      <span class="tree-actions">
        <button type="button" tabindex="-1" :title="S.rename" :aria-label="S.rename" @click.stop="t.rename(c.file.path)">✎</button>
        <button type="button" tabindex="-1" :title="S.delete" :aria-label="S.delete" @click.stop="t.remove(c.file.path)">✕</button>
      </span>
    </li>
  </template>
</template>
