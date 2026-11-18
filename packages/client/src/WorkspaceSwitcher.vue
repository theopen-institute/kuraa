<script setup lang="ts">
// The workspace's name in the sidebar's header, on a hub: a menu of the hub's
// workspaces to switch between, and the ways to add one.
import { ref } from 'vue';
import type { HubWorkspace } from './api.js';
import ContextMenu, { type ContextItem } from './ContextMenu.vue';

const props = defineProps<{
  workspaces: HubWorkspace[];
  current: string | null;
  /** What the open workspace is called (from the host), else the hub's name for it. */
  name: string;
  /** The shell can open a folder of this computer (the desktop app). */
  canOpenFolder: boolean;
}>();
const emit = defineEmits<{ switch: [id: string]; add: []; openFolder: []; remove: [id: string]; invite: [] }>();

const menu = ref<{ x: number; y: number; items: ContextItem[] } | null>(null);

function open(e: MouseEvent) {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const current = props.workspaces.find((w) => w.id === props.current);
  const items: ContextItem[] = [
    ...props.workspaces.map((w) => ({
      label: `${w.id === props.current ? '✓ ' : ''}${w.name}${w.error ? ' (cannot open)' : w.peers ? ' · synced' : ''}`,
      run: () => emit('switch', w.id),
      testid: `workspace:${w.id}`,
    })),
    // A hub's workspaces may always be shared (the hub allows it).
    ...(current && !current.error ? [{ label: `Invite people to “${current.name}”…`, run: () => emit('invite'), testid: 'workspace-invite' }] : []),
    { label: 'Add a workspace…', run: () => emit('add'), testid: 'workspace-add' },
    ...(props.canOpenFolder ? [{ label: 'Open a folder…', run: () => emit('openFolder'), testid: 'workspace-open-folder' }] : []),
    ...(current ? [{ label: `Remove “${current.name}” from this list…`, run: () => emit('remove', current.id), danger: true, testid: 'workspace-remove' }] : []),
  ];
  menu.value = { x: box.left, y: box.bottom + 4, items };
}
</script>

<template>
  <button type="button" class="workspace-switcher" :title="name" aria-haspopup="menu" data-testid="workspace-switcher" @click="open">
    <span class="workspace-name" data-testid="workspace-name">{{ name }}</span><span class="caret" aria-hidden="true">▾</span>
  </button>
  <ContextMenu v-if="menu" :x="menu.x" :y="menu.y" :items="menu.items" @close="menu = null" />
</template>
