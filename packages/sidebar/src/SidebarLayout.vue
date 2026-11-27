<script setup lang="ts">
// The sidebar (0087): a layout, down the left of the window. Its header: the
// connection light, the workspace's name (the core's menu of workspaces), the
// buttons of the workspace's panels (Search) and ＋ (the core's menu of new
// files and folders, with what the views add). Below, the navigation views that
// are on: with more than one, a row of their names chooses one, remembered for
// you in this browser, by workspace. A file dragged onto the header goes to the
// top level.
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { LayoutContext } from '@kuraa/feature-kit/client';
import { S } from './strings.js';
import ConnectionLight from './ConnectionLight.vue';
import FileIcon from '@kuraa/feature-ui/FileIcon.vue';
import ViewMount from './ViewMount.vue';

const props = defineProps<{ ctx: LayoutContext }>();
const ctx = props.ctx;

// What the core says, kept here to draw from, and asked again when it says it changed.
const workspace = shallowRef(ctx.workspace());
const connection = shallowRef(ctx.connection());
const buttons = shallowRef(ctx.panelButtons());
const views = shallowRef(ctx.views());
const newOpen = ref(ctx.newMenuOpen());
const stop = ctx.onChange(() => {
  workspace.value = ctx.workspace();
  connection.value = ctx.connection();
  buttons.value = ctx.panelButtons();
  const next = ctx.views();
  if (next.map((v) => v.key).join('|') !== views.value.map((v) => v.key).join('|')) views.value = next;
  newOpen.value = ctx.newMenuOpen();
});
onBeforeUnmount(stop);

// The view shown: the one chosen for this workspace, else the first.
const VIEW_KEY = 'kuraa:sidebar-view';
const storageKey = () => `${VIEW_KEY}:${workspace.value.name}`;
const chosen = ref<string | null>(null);
const readChosen = () => {
  try { chosen.value = localStorage.getItem(storageKey()); } catch { chosen.value = null; }
};
readChosen();
watch(() => workspace.value.name, readChosen);
const shown = computed(() => views.value.find((v) => v.key === chosen.value) ?? views.value[0] ?? null);
function choose(key: string) {
  chosen.value = key;
  try { localStorage.setItem(storageKey(), key); } catch { /* storage unavailable: for this page only */ }
}

// A file or folder dragged onto the header: to the top level.
const DRAGGED = 'application/x-kuraa-path';
const over = ref(false);
function dragOver(e: DragEvent) {
  if (!e.dataTransfer?.types.includes(DRAGGED)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  over.value = true;
}
function drop(e: DragEvent) {
  const path = e.dataTransfer?.getData(DRAGGED);
  over.value = false;
  if (!path) return;
  e.preventDefault();
  ctx.move(path, '');
}
</script>

<template>
  <nav class="pane pane-left" :aria-label="workspace.open ? S.label : S.workspaces">
    <div :class="['pane-header', { 'drop-target': over }]" @dragover="dragOver" @dragleave="over = false" @drop="drop">
      <span v-if="workspace.menu" class="workspace-title">
        <ConnectionLight v-if="workspace.open" :info="connection" />
        <button type="button" class="workspace-switcher" :title="workspace.name" aria-haspopup="menu" data-testid="workspace-switcher" @click="ctx.workspaceMenu($event.currentTarget as HTMLElement)">
          <span class="workspace-name" data-testid="workspace-name">{{ workspace.name }}</span><span class="caret" aria-hidden="true">▾</span>
        </button>
      </span>
      <span v-else class="workspace-name" :title="workspace.name" data-testid="workspace-name">{{ workspace.name }}</span>
      <span v-if="workspace.open" class="pane-header-actions">
        <button
          v-for="b in buttons"
          :key="`${b.feature}:${b.id}`"
          type="button"
          class="panel-button"
          :title="b.keys ? `${b.label} (${ctx.keyLabel(b.keys)})` : b.label"
          :aria-label="b.label"
          :data-testid="`${b.id}-button`"
          @click="ctx.askPanel(b.feature, b.id)"
        ><FileIcon :icon="b.icon" /></button>
        <!-- A new document at once (0097). Its menu (a file of another kind, a folder, what the views add), right-clicked. -->
        <button
          type="button"
          :title="S.newDocument"
          :aria-label="S.newDocument"
          data-testid="new-menu"
          @click="ctx.newDocument()"
          @contextmenu.prevent="ctx.newMenu($event.currentTarget as HTMLElement)"
        >＋</button>
      </span>
    </div>
    <div v-if="views.length > 1" class="sidebar-views" role="tablist" :aria-label="S.views">
      <button
        v-for="v in views"
        :key="v.key"
        type="button"
        role="tab"
        :aria-selected="v.key === shown?.key"
        :class="{ active: v.key === shown?.key }"
        :data-testid="`sidebar-view:${v.key}`"
        @click="choose(v.key)"
      >{{ v.label }}</button>
    </div>
    <ViewMount v-if="shown" :key="shown.key" class="sidebar-view" :mount="shown.mount" />
    <div v-else class="sidebar-view" />
  </nav>
</template>

<style>
/* The sidebar's own look; what every pane shares (.pane, .pane-header, .pane-header-actions) is the client's (@kuraa/feature-ui says which). */
.dot.conn-connected { background: #30a46c; }
.dot.conn-connecting { background: #f5a524; }
.dot.conn-unauthorized, .dot.conn-disconnected { background: #e5484d; }
.dot.conn-none { background: var(--border); }
.pane-left { border-right: 1px solid var(--border); display: flex; flex-direction: column; overflow: hidden; }
.pane-left .pane-header { text-transform: none; letter-spacing: 0; font-size: 13px; color: var(--text); gap: 8px; }
.workspace-name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
/* The workspace's name fills the header; its actions sit at the right. */
.pane-left .pane-header > .workspace-name, .pane-left .pane-header > .workspace-switcher, .pane-left .pane-header > .workspace-title { flex: 1; }
/* The connection's light, then the workspace's name and its menu. */
.workspace-title { display: flex; align-items: center; gap: 6px; min-width: 0; }
.connection-light { display: inline-flex; align-items: center; flex: none; cursor: default; }
.workspace-switcher { display: flex; align-items: center; gap: 4px; min-width: 0; border: 0; background: none; padding: 2px 6px; margin-left: -6px; font: inherit; font-weight: 600; color: inherit; border-radius: 5px; cursor: pointer; }
.workspace-switcher:hover { background: var(--selected); }
.workspace-switcher .workspace-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.workspace-switcher .caret { color: var(--muted); font-size: 10px; }
.sidebar-view { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.pane-left .pane-header.drop-target { background: color-mix(in srgb, var(--accent-soft) 45%, var(--panel)); }
.sidebar-views { display: flex; gap: 2px; padding: 4px 8px; border-bottom: 1px solid var(--border); }
.sidebar-views button { flex: 1; border: 0; background: none; padding: 3px 6px; border-radius: 5px; font-size: 12px; color: var(--muted); }
.sidebar-views button.active { background: var(--selected); color: var(--text); font-weight: 600; }
</style>
