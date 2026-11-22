<script setup lang="ts">
// The menu: what to do, beside the document. Opened from the bottom of the
// sidebar (or ⌘,). Sections: the open document (its views, versions, writing
// and code session), the workspace (search, sync, who is here), and you. It
// holds no settings: each section's settings are a section of the Settings
// window (decision 0064), opened from here at that section (Document settings…,
// Workspace settings…, Settings…). It is a modal dialog: focus moves into it,
// and Escape closes it.
import { computed, onMounted, ref, useTemplateRef } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import type { HostApi, WorkspaceInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import type { Settings } from './settings.js';
import type { SettingsSection } from './settingsSections.js';
import type { Shell } from './shell.js';
import type { EditorStatus } from './types.js';
import { time } from './labels.js';
import { APP_KEYS, keyLabel } from './keys.js';
import { connectionLabel, S } from './strings.js';
import { useDialog } from './vue.js';
import CodeSection from './CodeSection.vue';

const props = defineProps<{
  path: string | null;
  /** What the open file is called: its title, or its filename. */
  name: string | null;
  type: DocumentType | undefined;
  status: EditorStatus | null;
  workspace: WorkspaceInfo | null;
  hostUrl: string;
  viewing: boolean;
  showSource: boolean;
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
  /** The Settings window, at a section. */
  settings: [section: SettingsSection];
  close: [];
}>();

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('close'));

/** Close the menu, then do something (the menu is out of the way first). */
function then(fn: () => void) {
  emit('close');
  fn();
}

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
    <div ref="root" class="modal menu" role="dialog" aria-modal="true" :aria-label="S.menu.label" data-testid="menu">
      <section v-if="path && type" class="menu-section" data-testid="menu-this-document">
        <h3>{{ name }}</h3>
        <div v-if="doc" class="menu-actions">
          <button
            v-if="!type.editor?.layout"
            type="button"
            :class="{ active: showSource }"
            :aria-pressed="showSource"
            data-testid="toggle-source"
            @click="then(() => emit('toggleSource'))"
          >
            {{ showSource ? S.menu.showDocument : S.menu.editSource }}
          </button>
          <button type="button" :class="{ active: historyOpen }" :aria-pressed="historyOpen" @click="then(() => emit('toggleHistory'))">
            {{ historyOpen ? S.menu.hideHistory : S.menu.history }}
          </button>
          <button type="button" @click="then(() => emit('saveVersion'))">{{ S.menu.saveVersion }}</button>
          <button v-if="!type.editor?.layout" type="button" :title="S.menu.previewTitle(keyLabel(APP_KEYS.preview))" data-testid="menu-preview" @click="then(() => emit('preview'))">{{ S.menu.preview }}</button>
        </div>
        <div v-if="doc && !type.editor?.layout && !showSource" class="menu-actions" data-testid="menu-writing">
          <button type="button" :title="keyLabel(APP_KEYS.find)" data-testid="menu-find" @click="then(() => emit('find'))">{{ S.menu.find }}</button>
          <button type="button" :title="keyLabel(APP_KEYS.outline)" data-testid="menu-outline" @click="then(() => emit('outline'))">{{ S.menu.outline }}</button>
          <button type="button" data-testid="menu-insert-table" @click="then(() => emit('insertTable'))">{{ S.menu.insertTable }}</button>
          <button v-if="conflicts" type="button" :title="keyLabel('Mod-Alt-n')" data-testid="menu-next-conflict" @click="then(() => emit('nextConflict'))">{{ S.menu.nextConflict }}</button>
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
        <div class="menu-actions">
          <button type="button" data-testid="menu-document" @click="then(() => emit('settings', 'document'))">{{ S.menu.documentSettings }}</button>
        </div>
      </section>

      <CodeSection v-if="doc && runner" :runner="runner" @packages="(engine) => then(() => emit('packages', runner!, engine))" />

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
          <button type="button" :disabled="!workspace" :title="S.menu.searchTitle(keyLabel(APP_KEYS.search))" data-testid="menu-search" @click="then(() => emit('search'))">{{ S.menu.search }}</button>
          <button
            v-if="syncable !== false"
            type="button"
            :disabled="syncing || !workspace"
            :title="S.sync.title"
            data-testid="menu-sync"
            @click="then(() => emit('sync'))"
          >
            {{ syncing ? S.sync.syncing : S.sync.sync }}
          </button>
          <button type="button" :disabled="!workspace" data-testid="menu-workspace-settings" @click="then(() => emit('settings', 'workspace'))">{{ S.menu.workspaceSettings }}</button>
        </div>
        <p v-if="syncable === false" class="menu-facts" data-testid="menu-sync-none">{{ S.sync.nothingToSync }}</p>
        <details v-if="workspace" class="menu-details">
          <summary>{{ S.common.details }}</summary>
          <span class="menu-facts" data-testid="workspace-details">{{ S.menu.workspaceDetails(workspace.branch, workspace.head?.slice(0, 7) ?? null) }}</span>
        </details>
      </section>

      <section class="menu-section">
        <h3>{{ S.menu.you }}</h3>
        <p v-if="settings.name" class="menu-facts" data-testid="menu-you">{{ settings.email ? `${settings.name} · ${settings.email}` : settings.name }}</p>
        <div class="menu-actions">
          <button type="button" :title="S.menu.settingsTitle(keyLabel(APP_KEYS.preferences))" data-testid="menu-settings" @click="then(() => emit('settings', 'you'))">{{ S.menu.settings }}</button>
          <button type="button" :title="S.menu.helpTitle(keyLabel(APP_KEYS.help))" data-testid="menu-help" @click="then(() => emit('help'))">{{ S.menu.help }}</button>
        </div>
      </section>

      <div class="modal-actions"><button type="button" @click="emit('close')">{{ S.common.close }}</button></div>
    </div>
  </div>
</template>
