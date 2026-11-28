<script setup lang="ts">
// Settings › Workspace (decision 0064): the open workspace's own settings, kept
// in the workspace, for everyone in it: its people and servers, and inviting
// people (DevicesSection), each opening a view of their own in this one's place
// (MemberView, 0107: their role, their computers, removing them, a computer lost
// or stolen); its groups and permissions (RulesSection); and, where the
// host allows it, taking it off this host's list (its folder stays). Its name is
// the section's heading, renamed there (SettingsWindow, 0061). Which components
// it uses (its features, and their settings; its online copy) is in Settings ›
// Components, in its Workspace column (0095). Each of these is done at once,
// asking first where it should, as it always was: none waits for the window to
// close.
import { ref } from 'vue';
import type { HostApi, WorkspaceInfo } from './api.js';
import { S } from './strings.js';
import DevicesSection from './DevicesSection.vue';
import RulesSection from './RulesSection.vue';
import MemberView from './MemberView.vue';
import type { Who } from './peopleView.js';

defineProps<{
  api: HostApi;
  workspace: WorkspaceInfo | null;
  /** The host lets people take this workspace off its list. */
  canRemove: boolean;
}>();
const emit = defineEmits<{ remove: []; invite: []; permissions: [path: string] }>();
/** A person's or server's own view, open in the section's place (0107); the rest stays, hidden. */
const member = ref<Who | null>(null);
</script>

<template>
  <div data-testid="settings-workspace">
    <template v-if="workspace">
      <MemberView v-if="member" :key="`${member.kind}:${member.id}`" :api="api" :who="member" @back="member = null" />
      <div v-show="!member" class="workspace-main">
      <DevicesSection :api="api" @invite="emit('invite')" @open="(w) => (member = w)" />
      <RulesSection :api="api" @permissions="(p) => emit('permissions', p)" />
      <details class="settings-part menu-details">
        <summary>{{ S.common.details }}</summary>
        <span class="menu-facts" data-testid="workspace-details">{{ S.menu.workspaceDetails(workspace.branch, workspace.head?.slice(0, 7) ?? null) }}</span>
      </details>
      <section v-if="canRemove" class="settings-part settings-danger">
        <div class="pref-row">
          <button type="button" class="danger" :title="S.menu.removeWorkspaceTitle" data-testid="menu-remove-workspace" @click="emit('remove')">{{ S.menu.removeWorkspace }}</button>
        </div>
      </section>
      </div>
    </template>
    <p v-else class="pref-note settings-none">{{ S.sections.noWorkspace }}</p>
  </div>
</template>
