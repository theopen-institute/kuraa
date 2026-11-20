<script setup lang="ts">
// The workspace's name in the sidebar's header: a menu of the server's
// workspaces to switch between and, where the server allows it, the ways to add
// one. A server of one folder shows just that one.
import { ref } from 'vue';
import type { HubWorkspace } from './api.js';
import ContextMenu, { type ContextItem } from './ContextMenu.vue';
import { S } from './strings.js';

const props = defineProps<{
  workspaces: HubWorkspace[];
  current: string | null;
  /** What the open workspace is called (from the host), else the hub's name for it. */
  name: string;
  /** The server lets people add workspaces, and take them off its list. */
  canAdd: boolean;
  /** The server lets people invite others to its workspaces. */
  canInvite: boolean;
  /** The shell can open a folder of this computer (the desktop app). */
  canOpenFolder: boolean;
}>();
const emit = defineEmits<{ switch: [id: string]; add: []; openFolder: []; remove: [id: string]; invite: [] }>();

const menu = ref<{ x: number; y: number; items: ContextItem[] } | null>(null);

function open(e: MouseEvent) {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const current = props.workspaces.find((w) => w.id === props.current);
  const label = (w: HubWorkspace) => (w.id === props.current ? props.name : w.name);
  const items: ContextItem[] = [
    ...props.workspaces.map((w) => ({
      label: `${w.id === props.current ? '✓ ' : ''}${label(w)}${w.error ? (props.canAdd ? S.workspaceSwitcher.cannotOpenRemove : S.workspaceSwitcher.cannotOpen) : w.peers ? S.workspaceSwitcher.synced : ''}`,
      run: () => emit('switch', w.id),
      testid: `workspace:${w.id}`,
    })),
    ...(current && !current.error && props.canInvite ? [{ label: S.workspaceSwitcher.invite(label(current)), run: () => emit('invite'), testid: 'workspace-invite' }] : []),
    ...(props.canAdd ? [{ label: S.workspaceSwitcher.add, run: () => emit('add'), testid: 'workspace-add' }] : []),
    ...(props.canAdd && props.canOpenFolder ? [{ label: S.workspaceSwitcher.openFolder, run: () => emit('openFolder'), testid: 'workspace-open-folder' }] : []),
    ...(current && props.canAdd ? [{ label: S.workspaceSwitcher.remove(label(current)), run: () => emit('remove', current.id), danger: true, testid: 'workspace-remove' }] : []),
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
