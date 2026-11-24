<script setup lang="ts">
// The workspace's name in the sidebar's header: a menu of the host's
// workspaces to switch between and, apart below them where the host allows
// it, Add a workspace… (a new one, one joined from an invite link, or a folder
// opened); and Workspace settings… (where inviting people and removing the
// workspace are), or Settings… with none open. A host of one folder shows
// just that one.
import { ref } from 'vue';
import type { HubWorkspace } from './api.js';
import ContextMenu, { type ContextItem } from './ContextMenu.vue';
import { S } from './strings.js';

const props = defineProps<{
  workspaces: HubWorkspace[];
  current: string | null;
  /** What the open workspace is called (from the host), else the hub's name for it. */
  name: string;
  /** The host lets people add workspaces. */
  canAdd: boolean;
}>();
const emit = defineEmits<{ switch: [id: string]; add: []; settings: [] }>();

const menu = ref<{ x: number; y: number; items: ContextItem[] } | null>(null);

function open(e: MouseEvent) {
  const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
  const label = (w: HubWorkspace) => (w.id === props.current ? props.name : w.name);
  const items: ContextItem[] = [
    // The names, and only what stops one opening (it is otherwise found only by choosing it).
    ...props.workspaces.map((w) => ({
      label: `${w.id === props.current ? '✓ ' : ''}${label(w)}${w.error ? S.workspaceSwitcher.cannotOpen : ''}`,
      run: () => emit('switch', w.id),
      testid: `workspace:${w.id}`,
    })),
    props.current !== null
      ? { label: S.workspaceSwitcher.settings, run: () => emit('settings'), testid: 'workspace-settings', divided: props.workspaces.length > 0 }
      : { label: S.workspaceSwitcher.allSettings, run: () => emit('settings'), testid: 'workspace-settings', divided: props.workspaces.length > 0 },
    ...(props.canAdd ? [{ label: S.workspaceSwitcher.add, run: () => emit('add'), testid: 'workspace-add' }] : []),
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
