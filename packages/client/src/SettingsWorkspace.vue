<script setup lang="ts">
// Settings › Workspace (decision 0064): the open workspace's own settings, kept
// in the workspace, for everyone in it: its name (renamed for everyone, 0061);
// its packages; its devices, and inviting people (DevicesSection); its online
// copy (SyncsSection, 0059); and, where the server allows it, taking it off this
// server's list (its folder stays). Each of these is done at once, asking first
// where it should, as it always was: none waits for the window to close.
import { computed, ref, watch } from 'vue';
import type { HostApi, WorkspaceInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import { S } from './strings.js';
import DevicesSection from './DevicesSection.vue';
import SyncsSection from './SyncsSection.vue';

const props = defineProps<{
  api: HostApi;
  workspace: WorkspaceInfo | null;
  /** The open document's runner, if it runs code: through it, the workspace's packages are listed and changed. */
  runner: ChunkRunner | null;
  /** The server lets people take this workspace off its list. */
  canRemove: boolean;
}>();
const emit = defineEmits<{ rename: []; remove: []; invite: []; packages: [runner: ChunkRunner, engine: string] }>();

// The engine whose packages the workspace's documents use, followed as the runner changes.
const tick = ref(0);
watch(() => props.runner, (r, _prev, onCleanup) => {
  if (r) onCleanup(r.subscribe(() => tick.value++));
}, { immediate: true });
const packageEngine = computed(() => (void tick.value, props.runner?.packageEngine ?? null));
</script>

<template>
  <div data-testid="settings-workspace">
    <template v-if="workspace">
      <section class="settings-part">
        <fieldset class="pref-group">
          <legend>{{ S.sections.name }}</legend>
          <div class="pref-row">
            <span class="settings-value" data-testid="settings-workspace-name">{{ workspace.name }}</span>
            <button type="button" :title="S.menu.renameWorkspaceTitle" data-testid="menu-rename-workspace" @click="emit('rename')">{{ S.menu.renameWorkspace }}</button>
          </div>
        </fieldset>
        <fieldset v-if="runner && packageEngine" class="pref-group">
          <legend>{{ S.sections.packages }}</legend>
          <p class="pref-note">{{ S.sections.packagesAbout }}</p>
          <div class="pref-row">
            <button type="button" data-testid="settings-packages" @click="emit('packages', runner, packageEngine)">{{ S.code.packages }}</button>
          </div>
        </fieldset>
      </section>
      <DevicesSection :api="api" @invite="emit('invite')" />
      <SyncsSection :api="api" />
      <details class="settings-part menu-details">
        <summary>{{ S.common.details }}</summary>
        <span class="menu-facts" data-testid="workspace-details">{{ S.menu.workspaceDetails(workspace.branch, workspace.head?.slice(0, 7) ?? null) }}</span>
      </details>
      <section v-if="canRemove" class="settings-part settings-danger">
        <div class="pref-row">
          <button type="button" class="danger" :title="S.menu.removeWorkspaceTitle" data-testid="menu-remove-workspace" @click="emit('remove')">{{ S.menu.removeWorkspace }}</button>
        </div>
      </section>
    </template>
    <p v-else class="pref-note settings-none">{{ S.sections.noWorkspace }}</p>
  </div>
</template>
