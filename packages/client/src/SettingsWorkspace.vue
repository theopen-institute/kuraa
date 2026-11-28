<script setup lang="ts">
// Settings › Workspace (decision 0064): the open workspace's own settings, kept
// in the workspace, for everyone in it: its people and servers, and inviting
// people (DevicesSection), each opening a view of their own in this one's place
// (MemberView, 0107: their role, their computers, removing them, a computer lost
// or stolen); its groups and permissions (RulesSection); and, at the end, the
// two ways out (0107): Leave this workspace (you are taken out, as an admin takes
// someone out, and everyone is told; not the owner, who hands the role on first),
// and, where the host allows it, Remove this device from this workspace (local:
// this computer stops syncing it and takes it off its list; its folder stays, and
// no one is told). Its name is
// the section's heading, renamed there (SettingsWindow, 0061). Which components
// it uses (its features, and their settings; its online copy) is in Settings ›
// Components, in its Workspace column (0095). Each of these is done at once,
// asking first where it should, as it always was: none waits for the window to
// close.
import { computed, onMounted, ref, shallowRef } from 'vue';
import type { HostApi, PeersInfo, WorkspaceInfo } from './api.js';
import { askConfirm } from './ask.js';
import ErrorBanner from './ErrorBanner.vue';
import { S } from './strings.js';
import DevicesSection from './DevicesSection.vue';
import RulesSection from './RulesSection.vue';
import MemberView from './MemberView.vue';
import type { Who } from './peopleView.js';

const props = defineProps<{
  api: HostApi;
  workspace: WorkspaceInfo | null;
  /** The host lets people take this workspace off its list. */
  canRemove: boolean;
}>();
const emit = defineEmits<{ remove: []; invite: []; permissions: [path: string] }>();
/** A person's or server's own view, open in the section's place (0107); the rest stays, hidden. */
const member = ref<Who | null>(null);

/** Who you are here, for Leave this workspace (0107): read when the section opens, and again after leaving. */
const peers = shallowRef<PeersInfo | null>(null);
const leaveError = shallowRef<unknown>(null);
const leaving = ref(false);
async function loadPeers() {
  try {
    peers.value = await props.api.peers();
  } catch {
    peers.value = null;
  }
}
onMounted(() => void loadPeers());
/** You, as a person in a workspace with a policy, on a device still in it; null otherwise (nothing to leave, or a server). */
const me = computed(() => {
  const i = peers.value?.enabled ? peers.value : null;
  if (!i?.people?.founded || i.removed) return null;
  return i.people.people.find((p) => p.you) ?? null;
});
async function leave() {
  const you = me.value;
  if (!you || you.role === 'owner' || !props.workspace) return;
  if (!(await askConfirm(S.menu.leaveAsk(props.workspace.name), S.menu.leave, true))) return;
  leaving.value = true;
  leaveError.value = null;
  try {
    await props.api.removePerson(you.id);
  } catch (e) {
    leaveError.value = e;
  } finally {
    leaving.value = false;
    await loadPeers();
  }
}
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
      <section v-if="me || canRemove" class="settings-part settings-danger">
        <div v-if="me" class="pref-row leave-row">
          <button type="button" class="danger" :disabled="me.role === 'owner' || leaving" :title="S.menu.leaveTitle" data-testid="menu-leave-workspace" @click="leave">{{ S.menu.leaveWorkspace }}</button>
          <span class="pref-note">{{ me.role === 'owner' ? S.menu.leaveOwner : S.menu.leaveAbout }}</span>
        </div>
        <div v-if="canRemove" class="pref-row leave-row">
          <button type="button" class="danger" :title="S.menu.removeWorkspaceTitle" data-testid="menu-remove-workspace" @click="emit('remove')">{{ S.menu.removeWorkspace }}</button>
          <span class="pref-note">{{ S.menu.removeWorkspaceAbout }}</span>
        </div>
        <ErrorBanner v-if="leaveError" :error="leaveError" inline />
      </section>
      </div>
    </template>
    <p v-else class="pref-note settings-none">{{ S.sections.noWorkspace }}</p>
  </div>
</template>

<style scoped>
.leave-row { display: grid; gap: 4px; justify-items: start; }
</style>
