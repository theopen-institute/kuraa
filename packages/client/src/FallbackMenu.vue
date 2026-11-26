<script setup lang="ts">
// The core's own menu (0087), at the upper left, drawn only while no layout
// that gives navigation is in use: what the app cannot be used without. The
// workspaces (to switch to, and Add a workspace…), New file, Files… (a plain
// list of the workspace's files) and Settings…, where navigation is turned back
// on.
import { ref, shallowRef } from 'vue';
import ContextMenu, { type ContextItem } from './ContextMenu.vue';
import { S } from './strings.js';

const props = defineProps<{
  /** The workspaces' items (workspaceMenu.ts), if there is a menu of them. */
  workspaces: () => ContextItem[];
  /** A workspace is open: its files can be listed and made. */
  open: boolean;
}>();
const emit = defineEmits<{ newFile: []; files: []; settings: [] }>();

const menu = shallowRef<{ x: number; y: number; items: ContextItem[] } | null>(null);
const button = ref<HTMLButtonElement | null>(null);

function show() {
  const box = button.value!.getBoundingClientRect();
  const listed = props.workspaces();
  const own: ContextItem[] = [
    ...(props.open ? [
      { label: S.fallback.newFile, run: () => emit('newFile'), testid: 'fallback-new-file' },
      { label: S.fallback.filesEllipsis, run: () => emit('files'), testid: 'fallback-files' },
    ] : []),
    // Settings, unless the workspaces' own items have it (with none open).
    ...(listed.some((i) => i.testid === 'workspace-settings' && !i.icons) ? [] : [{ label: S.fallback.settings, run: () => emit('settings'), testid: 'fallback-settings' }]),
  ];
  menu.value = { x: box.left, y: box.bottom + 4, items: [...listed, ...own.map((i, n) => ({ ...i, divided: n === 0 && listed.length > 0 }))] };
}
</script>

<template>
  <div class="fallback-nav">
    <button ref="button" type="button" class="fallback-button" :title="S.fallback.title" :aria-label="S.fallback.title" aria-haspopup="menu" :aria-expanded="!!menu" data-testid="fallback-menu" @click="show">
      <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" /></svg>
    </button>
    <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menu.items" @close="menu = null" />
  </div>
</template>
