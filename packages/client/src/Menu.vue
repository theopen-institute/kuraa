<script setup lang="ts">
// The menu: everything that is not the document. Opened from the bottom of the
// sidebar (or ⌘,). Sections: this document (views, versions, saving), code (the
// session, packages), the workspace (sync, connection, who is here), and you
// (your settings, you on this computer, and the shell's own actions). The server
// and its access code, where the shell does not run the host, is a panel of its
// own, opened from You. It is a modal dialog: focus moves into it, and Escape
// closes it (or goes back from the Server panel).
import { computed, onMounted, ref, shallowRef, useTemplateRef } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import type { HostApi, WorkspaceInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import type { Settings } from './settings.js';
import type { PersonShell, Shell } from './shell.js';
import { personShellFor } from './hostPerson.js';
import type { EditorStatus } from './types.js';
import { time } from './labels.js';
import { APP_KEYS, keyLabel } from './keys.js';
import { connectionLabel, S } from './strings.js';
import { useDialog } from './vue.js';
import CodeSection from './CodeSection.vue';
import DevicesSection from './DevicesSection.vue';
import OnlineCopySection from './OnlineCopySection.vue';
import SettingsForm from './SettingsForm.vue';
import PersonKey from './PersonKey.vue';

const props = defineProps<{
  /** Where it opens: the menu, or its Server panel (to change the access code). */
  panel?: 'menu' | 'access';
  path: string | null;
  /** What the open file is called: its title, or its filename. */
  name: string | null;
  type: DocumentType | undefined;
  status: EditorStatus | null;
  workspace: WorkspaceInfo | null;
  hostUrl: string;
  viewing: boolean;
  showSource: boolean;
  /** The document has a header to edit. */
  hasHeader: boolean;
  historyOpen: boolean;
  syncing: boolean;
  settings: Settings;
  shell: Shell;
  api: HostApi;
  /** How many conflicts the open document keeps. */
  conflicts?: number;
}>();
const emit = defineEmits<{
  toggleSource: [];
  toggleHistory: [];
  header: [];
  saveVersion: [];
  sync: [];
  saveSettings: [settings: Settings];
  packages: [runner: ChunkRunner, engine: string];
  components: [];
  /** Invite people to the workspace. */
  invite: [];
  /** Find in the document, show its outline, put a table in, or go to its next conflict. */
  find: [];
  outline: [];
  insertTable: [];
  nextConflict: [];
  /** Render the document and show the Preview panel. */
  preview: [];
  /** Search every file of the workspace. */
  search: [];
  /** The Markdown and shortcuts sheet. */
  help: [];
  close: [];
}>();

/** The menu itself, or its Host panel. */
const panel = ref<'menu' | 'access'>(props.panel === 'access' && !props.shell.managesHost ? 'access' : 'menu');
const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => {
  if (panel.value === 'access' && props.panel !== 'access') panel.value = 'menu';
  else emit('close');
});

/**
 * Whether Sync has anything to sync with: other devices, or an online copy.
 * Unknown (null) until asked; then Sync is offered only if it has.
 */
const syncable = ref<boolean | null>(null);
onMounted(async () => {
  try {
    const [peers, online] = await Promise.all([props.api.peers(), props.api.online()]);
    syncable.value = peers.enabled || online.copies.length > 0;
  } catch {
    syncable.value = null;
  }
});

const doc = computed(() => !!props.path && !!props.type && !props.viewing);

// You on this computer: the shell's (desktop app), else the host's where it allows (`pnpm dev`).
const personShell = shallowRef<PersonShell | null>(props.shell.person ?? null);
onMounted(async () => {
  if (!personShell.value) personShell.value = await personShellFor(props.shell, props.api);
});
const runner = computed(() => props.status?.runner ?? null);

</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div ref="root" class="modal menu" role="dialog" aria-modal="true" :aria-label="panel === 'access' ? S.menu.server : S.menu.label" data-testid="menu">
      <template v-if="panel === 'access'">
        <div class="menu-panel-head">
          <button type="button" class="menu-back" data-testid="menu-back" @click="panel = 'menu'">{{ S.menu.backToMenu }}</button>
          <h2>{{ S.menu.server }}</h2>
        </div>
        <section v-if="!shell.managesHost" class="menu-section" data-testid="menu-connection">
          <h3>{{ S.menu.server }}</h3>
          <p class="menu-facts">{{ S.menu.serverAbout }}</p>
          <SettingsForm :initial="settings" :shell="shell" part="connection" @save="(s) => { emit('saveSettings', s); emit('close'); }" />
        </section>
        <div class="modal-actions"><button type="button" @click="emit('close')">{{ S.common.close }}</button></div>
      </template>
      <template v-else>
        <section v-if="path" class="menu-section">
          <h3>{{ name }}</h3>
          <div v-if="doc" class="menu-actions">
            <button
              v-if="!type!.editor?.layout"
              type="button"
              :class="{ active: showSource }"
              :aria-pressed="showSource"
              data-testid="toggle-source"
              @click="emit('toggleSource'); emit('close')"
            >
              {{ showSource ? S.menu.showDocument : S.menu.editSource }}
            </button>
            <button v-if="hasHeader" type="button" data-testid="menu-header" @click="emit('header'); emit('close')">{{ S.menu.header }}</button>
            <button type="button" :class="{ active: historyOpen }" :aria-pressed="historyOpen" @click="emit('toggleHistory'); emit('close')">
              {{ historyOpen ? S.menu.hideHistory : S.menu.history }}
            </button>
            <button type="button" @click="emit('saveVersion'); emit('close')">{{ S.menu.saveVersion }}</button>
            <button v-if="!type!.editor?.layout" type="button" :title="S.menu.previewTitle(keyLabel(APP_KEYS.preview))" data-testid="menu-preview" @click="emit('preview'); emit('close')">{{ S.menu.preview }}</button>
          </div>
          <div v-if="doc && !type!.editor?.layout && !showSource" class="menu-actions" data-testid="menu-writing">
            <button type="button" :title="keyLabel(APP_KEYS.find)" data-testid="menu-find" @click="emit('close'); emit('find')">{{ S.menu.find }}</button>
            <button type="button" :title="keyLabel(APP_KEYS.outline)" data-testid="menu-outline" @click="emit('close'); emit('outline')">{{ S.menu.outline }}</button>
            <button type="button" data-testid="menu-insert-table" @click="emit('close'); emit('insertTable')">{{ S.menu.insertTable }}</button>
            <button v-if="conflicts" type="button" :title="keyLabel('Mod-Alt-n')" data-testid="menu-next-conflict" @click="emit('close'); emit('nextConflict')">{{ S.menu.nextConflict }}</button>
          </div>
          <p v-if="status" class="menu-facts">
            <span data-testid="last-flush">{{ S.menu.savedAt(time(status.lastFlushAt)) }}</span>
            ·
            <span data-testid="last-commit">{{ S.menu.versionAt(time(status.lastCommitAt)) }}</span>
            <template v-if="status.unsynced > 0"> · {{ S.menu.unsent(status.unsynced) }}</template>
          </p>
          <details v-if="status?.lastCommit" class="menu-details">
            <summary>{{ S.common.details }}</summary>
            <span class="menu-facts" data-testid="last-commit-id">{{ S.menu.versionDetails(status.lastCommit.slice(0, 7)) }}</span>
          </details>
        </section>

        <CodeSection v-if="doc && runner" :runner="runner" @packages="(engine) => { emit('packages', runner!, engine); emit('close'); }" />

        <section class="menu-section">
          <h3>{{ workspace?.name ?? S.app.workspace }}</h3>
          <p class="menu-facts">
            <template v-if="!workspace">{{ hostUrl }}</template>
            <template v-if="status">{{ workspace ? '' : ' · ' }}{{ connectionLabel(status.connection) }}</template>
          </p>
          <ul v-if="status && status.peers.length > 0" class="menu-peers">
            <li v-for="x in status.peers" :key="x.clientId" :title="x.email || x.name">
              <span class="menu-person" :style="{ background: x.color }" />{{ x.name || S.common.anonymous }}{{ x.self ? S.common.you : '' }}
            </li>
          </ul>
          <div class="menu-actions">
            <button type="button" :disabled="!workspace" :title="S.menu.searchTitle(keyLabel(APP_KEYS.search))" data-testid="menu-search" @click="emit('search'); emit('close')">{{ S.menu.search }}</button>
            <button
              v-if="syncable !== false"
              type="button"
              :disabled="syncing || !workspace"
              :title="S.sync.title"
              data-testid="menu-sync"
              @click="emit('sync'); emit('close')"
            >
              {{ syncing ? S.sync.syncing : S.sync.sync }}
            </button>
          </div>
          <p v-if="syncable === false" class="menu-facts" data-testid="menu-sync-none">{{ S.sync.nothingToSync }}</p>
          <details v-if="workspace" class="menu-details">
            <summary>{{ S.common.details }}</summary>
            <span class="menu-facts" data-testid="workspace-details">{{ S.menu.workspaceDetails(workspace.branch, workspace.head?.slice(0, 7) ?? null) }}</span>
          </details>
        </section>

        <DevicesSection :api="api" @invite="emit('invite'); emit('close')" />
        <OnlineCopySection :api="api" />

        <section class="menu-section">
          <h3>{{ S.menu.components }}</h3>
          <p class="menu-facts">{{ S.menu.componentsAbout }}</p>
          <div class="menu-actions">
            <button type="button" @click="emit('components'); emit('close')">{{ S.menu.componentsButton }}</button>
            <button type="button" :title="S.menu.helpTitle(keyLabel(APP_KEYS.help))" data-testid="menu-help" @click="emit('close'); emit('help')">{{ S.menu.help }}</button>
          </div>
        </section>

        <section class="menu-section">
          <h3>{{ S.menu.you }}</h3>
          <SettingsForm :initial="settings" :shell="shell" part="profile" @save="(s) => { emit('saveSettings', s); emit('close'); }" />
          <PersonKey v-if="personShell" :person="personShell" :display-name="settings.name" />
          <div v-if="!shell.managesHost || shell.preferences" class="menu-actions">
            <button v-if="!shell.managesHost" type="button" data-testid="menu-access" @click="panel = 'access'">{{ S.menu.access }}</button>
            <button v-if="shell.preferences" type="button" :title="S.menu.preferencesTitle" data-testid="menu-preferences" @click="emit('close'); shell.preferences()">{{ S.menu.preferences }}</button>
          </div>
        </section>

        <div class="modal-actions"><button type="button" @click="emit('close')">{{ S.common.close }}</button></div>
      </template>
    </div>
  </div>
</template>
