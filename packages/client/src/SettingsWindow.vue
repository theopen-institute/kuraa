<script setup lang="ts">
// Settings, in one window of four sections (decisions 0060, 0064), by who each
// applies to and where it is kept:
//
// - You (SettingsYou): yours alone, in this browser.
// - Document (SettingsDocument): the open document's, in its file.
// - Workspace (SettingsWorkspace): the open workspace's, in the workspace.
// - Server (SettingsServer): the server's, for everyone using it.
//
// Each place that opens it opens it at one (`section`); the list on the left
// goes to the others. Each section says first who it applies to. A section that
// does not apply now (no document open, say) says why, and stays in the list,
// so the window is always the same four. All four stay as they are while
// another is shown, so going between them loses nothing.
//
// Nothing changed here is lost by closing it (Done, Escape, a click outside, all
// the same; 0063): you, and the workspace's things, as each is changed; the
// document's header, written as it closes; the server and access code, used as
// it closes; and the server's settings, applied as it closes (reopening every
// workspace, so said by Done once changed). Refused (a value not valid), it
// stays open at that section, saying why, with Discard changes.
import { computed, ref, useTemplateRef } from 'vue';
import type { FormatEditor, HeaderSpec } from '@kuraa/editor-kit';
import type { EditorView } from 'prosemirror-view';
import type { HostApi, HubApi, WorkspaceInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import type { Settings } from './settings.js';
import { SETTINGS_SECTIONS, type SettingsSection } from './settingsSections.js';
import type { Shell } from './shell.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';
import SettingsDocument from './SettingsDocument.vue';
import SettingsServer from './SettingsServer.vue';
import SettingsWorkspace from './SettingsWorkspace.vue';
import SettingsYou from './SettingsYou.vue';

const props = defineProps<{
  hub: HubApi;
  api: HostApi;
  shell: Shell;
  settings: Settings;
  /** The section to open at. */
  section: SettingsSection;
  /** The server's settings may be changed here (its owner, decision 0047). */
  canChangeSettings: boolean;
  /** Why they cannot be, if they cannot. */
  ownerOff: string | null;
  /** The open document, what it is called, and its header (if its format has one). */
  path: string | null;
  docName: string | null;
  header: { view: EditorView; spec: HeaderSpec; version: number } | null;
  /** The open document's editor is not ready yet. */
  opening: boolean;
  workspace: WorkspaceInfo | null;
  /** The open document's runner, if it runs code (for the workspace's packages). */
  runner: ChunkRunner | null;
  canRemoveWorkspace: boolean;
  editors: Record<string, FormatEditor>;
  editorsOff: string[];
  toolsKey?: number;
}>();
const emit = defineEmits<{
  close: [];
  /** The server's settings were applied: the page starts again with them. */
  saved: [];
  saveSettings: [settings: Settings];
  editorsOff: [ids: string[]];
  renameWorkspace: [];
  removeWorkspace: [];
  invite: [];
  /** A file's or folder's permissions, to open (0069). */
  permissions: [path: string];
  packages: [runner: ChunkRunner, engine: string];
}>();

const section = ref<SettingsSection>(props.section);

const you = useTemplateRef<InstanceType<typeof SettingsYou>>('you');
const documentPart = useTemplateRef<InstanceType<typeof SettingsDocument>>('documentPart');
const server = useTemplateRef<InstanceType<typeof SettingsServer>>('server');

/** What each section is called in the list, with what it is about now beneath. */
const nav = computed(() => SETTINGS_SECTIONS.map((id) => ({
  id,
  label: S.sections[id],
  about: id === 'you' ? props.settings.name
    : id === 'document' ? props.docName ?? ''
    : id === 'workspace' ? props.workspace?.name ?? ''
    : props.canChangeSettings ? S.sections.thisComputer : S.sections.elsewhere,
  /** Nothing here to change now: shown, but quieter. */
  idle: (id === 'document' && !props.path) || (id === 'workspace' && !props.workspace),
})));

/** The section's heading, and who it applies to. */
const heading = computed(() => {
  switch (section.value) {
    case 'you': return { title: S.sections.you, scope: S.sections.youScope };
    case 'document': return { title: props.docName ?? S.sections.document, scope: props.path && props.docName ? S.sections.documentScope(props.docName) : '' };
    case 'workspace': return { title: props.workspace?.name ?? S.sections.workspace, scope: props.workspace ? S.sections.workspaceScope(props.workspace.name) : '' };
    default: return { title: props.canChangeSettings ? S.preferences.server : S.sections.server, scope: props.canChangeSettings ? S.sections.serverScope : S.sections.serverElsewhere };
  }
});

/** A server setting was changed: applied as the window closes, and said by Done. */
const serverChanged = computed(() => !!server.value?.changed);
const busy = computed(() => !!server.value?.busy);

/** Closing was refused (a value not valid): a way out that keeps nothing not saved yet. */
const stuck = ref(false);

/**
 * Close the window, keeping what was changed: the document's header (written),
 * the server and access code (if changed, and both given), then the server's
 * settings (applied: the page reloads). Any refused, it stays open there.
 */
async function close(then?: () => void): Promise<boolean> {
  if (busy.value) return false;
  if (documentPart.value && !(await documentPart.value.commit())) {
    section.value = 'document';
    return false;
  }
  const conn = you.value?.pending() ?? null;
  if (conn === 'invalid') {
    section.value = 'you';
    stuck.value = true;
    return false;
  }
  if (serverChanged.value && !(await server.value!.save())) {
    section.value = 'server';
    stuck.value = true;
    return false;
  }
  if (conn) emit('saveSettings', conn);
  // Said before closing: once closed, the window can say nothing more (Vue drops what an unmounted component emits).
  then?.();
  emit('close');
  return true;
}

/** Things done in another dialog (inviting people, packages, removing the workspace): this one closes as it starts, if it can. */
function thenClose(then: () => void) {
  void close(then);
}

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => {
  if (section.value === 'document' && documentPart.value?.escape()) return;
  if (server.value?.picking) return;
  void close();
});
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="close()">
    <div ref="root" class="modal preferences settings" role="dialog" aria-modal="true" aria-labelledby="settings-title" data-testid="settings-window">
      <div class="settings-layout">
        <nav class="settings-nav" :aria-label="S.sections.label">
          <h2 id="settings-title">{{ S.preferences.title }}</h2>
          <button
            v-for="n in nav"
            :key="n.id"
            type="button"
            :class="['settings-tab', { active: section === n.id, idle: n.idle }]"
            :aria-current="section === n.id ? 'page' : undefined"
            :data-testid="`settings-tab-${n.id}`"
            @click="section = n.id"
          >
            <span class="settings-tab-label">{{ n.label }}</span>
            <span v-if="n.about" class="settings-tab-about">{{ n.about }}</span>
          </button>
        </nav>
        <div class="settings-content">
          <header class="settings-head">
            <div class="settings-head-title">
              <h3 data-testid="settings-title"><span :data-testid="section === 'workspace' && workspace ? 'settings-workspace-name' : undefined">{{ heading.title }}</span></h3>
              <!-- The workspace's name is its heading: renamed here, for everyone in it (0061). -->
              <button v-if="section === 'workspace' && workspace" type="button" :title="S.menu.renameWorkspaceTitle" data-testid="menu-rename-workspace" @click="emit('renameWorkspace')">{{ S.menu.renameWorkspace }}</button>
            </div>
            <p v-if="heading.scope" class="settings-scope" data-testid="settings-scope">{{ heading.scope }}</p>
          </header>
          <SettingsYou
            v-show="section === 'you'"
            ref="you"
            :api="api"
            :shell="shell"
            :settings="settings"
            :editors="editors"
            :editors-off="editorsOff"
            @save-settings="(s) => emit('saveSettings', s)"
            @editors-off="(ids) => emit('editorsOff', ids)"
          />
          <SettingsDocument v-show="section === 'document'" ref="documentPart" :path="path" :header="header" :opening="opening" />
          <SettingsWorkspace
            v-show="section === 'workspace'"
            :api="api"
            :workspace="workspace"
            :runner="runner"
            :can-remove="canRemoveWorkspace"
            @remove="thenClose(() => emit('removeWorkspace'))"
            @invite="thenClose(() => emit('invite'))"
            @permissions="(p) => thenClose(() => emit('permissions', p))"
            @packages="(r, engine) => thenClose(() => emit('packages', r, engine))"
          />
          <SettingsServer
            v-show="section === 'server'"
            ref="server"
            :hub="hub"
            :api="api"
            :shell="shell"
            :can-change-settings="canChangeSettings"
            :owner-off="ownerOff"
            :tools-key="toolsKey"
            :workspace-name="workspace?.name ?? null"
            @saved="emit('saved')"
          />
        </div>
      </div>

      <div class="modal-actions settings-done">
        <!-- Changed: said once, here by Done, where it happens. -->
        <p v-if="serverChanged" class="pref-note pending" data-testid="pref-pending">{{ S.preferences.applyOnClose }}</p>
        <button v-if="stuck && !busy" type="button" data-testid="settings-discard" @click="emit('close')">{{ S.preferences.discard }}</button>
        <button type="button" class="primary" :disabled="busy" data-testid="settings-close" @click="close()">{{ busy ? S.preferences.applying : S.common.done }}</button>
      </div>
    </div>
  </div>
</template>
