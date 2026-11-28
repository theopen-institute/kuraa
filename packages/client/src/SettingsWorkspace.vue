<script setup lang="ts">
// Settings › Workspace (decision 0064): the open workspace's own settings, kept
// in the workspace, for everyone in it: its people and servers, and inviting
// people (DevicesSection); its groups and permissions (RulesSection); blocking a
// lost or stolen computer's or server's key, set apart and closed (KeysSection,
// 0107); and, where the
// host allows it, taking it off this host's list (its folder stays). Its name is
// the section's heading, renamed there (SettingsWindow, 0061). Which components
// it uses (its features, and their settings; its online copy) is in Settings ›
// Components, in its Workspace column (0095). Each of these is done at once,
// asking first where it should, as it always was: none waits for the window to
// close.
import type { HostApi, WorkspaceInfo } from './api.js';
import { S } from './strings.js';
import DevicesSection from './DevicesSection.vue';
import RulesSection from './RulesSection.vue';
import KeysSection from './KeysSection.vue';

defineProps<{
  api: HostApi;
  workspace: WorkspaceInfo | null;
  /** The host lets people take this workspace off its list. */
  canRemove: boolean;
}>();
const emit = defineEmits<{ remove: []; invite: []; permissions: [path: string] }>();
</script>

<template>
  <div data-testid="settings-workspace">
    <template v-if="workspace">
      <DevicesSection :api="api" @invite="emit('invite')" />
      <RulesSection :api="api" @permissions="(p) => emit('permissions', p)" />
      <KeysSection :api="api" />
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
