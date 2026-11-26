<script setup lang="ts">
// Files… (0087): with no layout giving navigation, the core's plain list of the
// workspace's files, each by title (or name) with its folder beside it, under
// a filter. Enter or a click opens one; the arrows move; Escape closes. No
// folders to fold, no dragging, no menu: how a file is opened with every
// navigation component off.
import { computed, ref, useTemplateRef } from 'vue';
import type { TreeFile } from './api.js';
import { S } from './strings.js';
import { useDialog, vFocus } from './vue.js';

const props = defineProps<{ files: TreeFile[] }>();
const emit = defineEmits<{ open: [path: string]; close: [] }>();

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('close'));

const filter = ref('');
const active = ref(0);
const nameOf = (f: TreeFile) => f.title || f.path.slice(f.path.lastIndexOf('/') + 1);
const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
/** The files the app opens, outside the folders it keeps for itself, by name; those the filter's words are all in. */
const shown = computed(() => {
  const words = filter.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  return props.files
    .filter((f) => f.type && !f.path.startsWith('.kuraa/') && !f.path.endsWith('/.gitkeep'))
    .filter((f) => words.every((w) => `${nameOf(f)} ${f.path}`.toLowerCase().includes(w)))
    .sort((a, b) => nameOf(a).localeCompare(nameOf(b), undefined, { numeric: true, sensitivity: 'base' }) || a.path.localeCompare(b.path));
});

function open(f: TreeFile | undefined) {
  if (!f) return;
  emit('open', f.path);
  emit('close');
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    active.value = Math.max(0, Math.min(shown.value.length - 1, active.value + (e.key === 'ArrowDown' ? 1 : -1)));
  } else if (e.key === 'Enter') {
    e.preventDefault();
    open(shown.value[active.value]);
  }
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div ref="root" class="modal files-list" role="dialog" aria-modal="true" :aria-label="S.fallback.files" data-testid="files-list" @keydown="onKey">
      <input v-model="filter" v-focus type="search" :placeholder="S.fallback.filter" :aria-label="S.fallback.filter" spellcheck="false" data-testid="files-filter" @input="active = 0">
      <ul role="listbox" :aria-label="S.fallback.files">
        <li v-for="(f, i) in shown" :key="f.path" role="option" :aria-selected="i === active">
          <button type="button" :class="{ active: i === active }" :data-testid="`files-list:${f.path}`" @click="open(f)" @mouseenter="active = i">
            <span class="files-list-name">{{ nameOf(f) }}</span>
            <span v-if="folderOf(f.path)" class="muted files-list-folder">{{ folderOf(f.path) }}</span>
          </button>
        </li>
      </ul>
      <p v-if="!shown.length" class="muted">{{ filter.trim() ? S.fallback.nothing : S.fallback.none }}</p>
    </div>
  </div>
</template>
