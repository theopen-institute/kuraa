<script setup lang="ts">
// The menu: everything that is not the document. Opened from the bottom of the
// sidebar (or ⌘,). Sections: the workspace (sync, connection, who is here), its
// devices, components (with the online copy, 0059), and you: who you are here,
// and Settings…, the window with your settings and this computer's server's
// (decision 0060). The open document's own settings are a panel of their own,
// Document settings (also opened by right-clicking a file in the sidebar): its
// views, versions and saving, its header, and its code session. It is a modal
// dialog: focus moves into it, and Escape closes it (or goes back from a panel
// opened from the menu).
import { computed, onMounted, ref, useTemplateRef } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import type { HeaderSpec } from '@kuraa/editor-kit';
import type { EditorView } from 'prosemirror-view';
import type { HostApi, WorkspaceInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import type { Settings } from './settings.js';
import type { Shell } from './shell.js';
import type { EditorStatus } from './types.js';
import { time } from './labels.js';
import { APP_KEYS, keyLabel } from './keys.js';
import { connectionLabel, S } from './strings.js';
import { useDialog } from './vue.js';
import CodeSection from './CodeSection.vue';
import DevicesSection from './DevicesSection.vue';
import HeaderForm from './HeaderForm.vue';

/** The menu's parts: the menu itself, and Document settings. */
export type MenuPanel = 'menu' | 'document';

const props = defineProps<{
  /** Where it opens: the menu, or its Document settings. */
  panel?: MenuPanel;
  path: string | null;
  /** What the open file is called: its title, or its filename. */
  name: string | null;
  type: DocumentType | undefined;
  status: EditorStatus | null;
  workspace: WorkspaceInfo | null;
  hostUrl: string;
  viewing: boolean;
  showSource: boolean;
  /** The open document's header, to edit, if its format has one: the live editor's view, and how the format reads it. */
  header: { view: EditorView; spec: HeaderSpec; version: number } | null;
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
  saveVersion: [];
  sync: [];
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
  /** The Settings window: yours, and this computer's server's. */
  settings: [];
  close: [];
}>();

/** The menu itself, or its Document settings. */
const panel = ref<MenuPanel>(props.panel === 'document' && props.path ? 'document' : 'menu');
const root = useTemplateRef<HTMLElement>('root');
const headerForm = useTemplateRef<InstanceType<typeof HeaderForm>>('headerForm');
useDialog(root, () => {
  if (panel.value === 'document' && headerForm.value?.escape()) return;
  // A panel opened from the menu goes back to it; one the menu opened at closes.
  if (panel.value !== 'menu' && props.panel !== panel.value) panel.value = 'menu';
  else emit('close');
});

/**
 * Whether Sync has anything to sync with: other devices, or an online copy.
 * Unknown (null) until asked; then Sync is offered only if it has.
 */
const syncable = ref<boolean | null>(null);
onMounted(async () => {
  try {
    const [peers, syncs] = await Promise.all([props.api.peers(), props.api.syncs()]);
    syncable.value = peers.enabled || syncs.syncs.some((s) => s.targets.length > 0);
  } catch {
    syncable.value = null;
  }
});

const doc = computed(() => !!props.path && !!props.type && !props.viewing);

const runner = computed(() => props.status?.runner ?? null);

</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div ref="root" class="modal menu" role="dialog" aria-modal="true" :class="{ 'menu-document': panel === 'document' && header }" :aria-label="panel === 'document' ? S.menu.documentSettingsTitle : S.menu.label" data-testid="menu">
      <template v-if="panel === 'document'">
        <div class="menu-panel-head">
          <button type="button" class="menu-back" data-testid="menu-back" @click="panel = 'menu'">{{ S.menu.backToMenu }}</button>
          <h2>{{ S.menu.documentSettingsTitle }}</h2>
        </div>
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

        <section v-if="doc && header" class="menu-section">
          <HeaderForm ref="headerForm" :view="header.view" :spec="header.spec" :path="path!" :version="header.version" @saved="emit('close')" />
        </section>

        <div class="modal-actions"><button type="button" @click="emit('close')">{{ S.common.close }}</button></div>
      </template>
      <template v-else>
        <section v-if="path && type" class="menu-section" data-testid="menu-this-document">
          <h3>{{ name }}</h3>
          <div class="menu-actions">
            <button type="button" data-testid="menu-document" @click="panel = 'document'">{{ S.menu.documentSettings }}</button>
          </div>
        </section>

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
          <p v-if="settings.name" class="menu-facts" data-testid="menu-you">{{ settings.email ? `${settings.name} · ${settings.email}` : settings.name }}</p>
          <div class="menu-actions">
            <button type="button" :title="S.menu.settingsTitle(keyLabel(APP_KEYS.preferences))" data-testid="menu-settings" @click="emit('close'); emit('settings')">{{ S.menu.settings }}</button>
            <button v-if="shell.leave" type="button" @click="shell.leave()">{{ S.settings.join }}</button>
          </div>
        </section>

        <div class="modal-actions"><button type="button" @click="emit('close')">{{ S.common.close }}</button></div>
      </template>
    </div>
  </div>
</template>
