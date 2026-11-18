<script setup lang="ts">
// The menu: everything that is not the document. Opened from the bottom of the
// sidebar (or ⌘,). Sections: this document (views, versions, saving), code (the
// session, packages), the workspace (sync, connection, who is here), and you
// (your settings, and the shell's own actions).
import { computed } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import type { WorkspaceInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import type { Settings } from './settings.js';
import type { Shell } from './shell.js';
import type { EditorStatus } from './types.js';
import { CONNECTION, time } from './labels.js';
import { onEscape } from './vue.js';
import CodeSection from './CodeSection.vue';
import SettingsForm from './SettingsForm.vue';

const props = defineProps<{
  path: string | null;
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
}>();
const emit = defineEmits<{
  toggleSource: [];
  toggleHistory: [];
  saveVersion: [];
  sync: [];
  saveSettings: [settings: Settings];
  packages: [runner: ChunkRunner, engine: string];
  plugins: [];
  close: [];
}>();

onEscape(() => emit('close'));

const name = computed(() => props.path?.slice(props.path.lastIndexOf('/') + 1) ?? '');
const doc = computed(() => !!props.path && !!props.type && !props.viewing);
const runner = computed(() => props.status?.runner ?? null);

</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div class="modal menu" role="dialog" aria-label="Menu" data-testid="menu">
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
            {{ showSource ? 'Show the document' : 'Edit the source' }}
          </button>
          <button type="button" :class="{ active: historyOpen }" :aria-pressed="historyOpen" @click="emit('toggleHistory'); emit('close')">
            {{ historyOpen ? 'Hide history' : 'History' }}
          </button>
          <button type="button" @click="emit('saveVersion'); emit('close')">Save version…</button>
        </div>
        <p v-if="status" class="menu-facts">
          <span data-testid="last-flush">Written {{ time(status.lastFlushAt) }}</span>
          ·
          <span data-testid="last-commit">Committed {{ status.lastCommit ? `${status.lastCommit.slice(0, 7)} at ${time(status.lastCommitAt)}` : '—' }}</span>
          <template v-if="status.unsynced > 0"> · {{ status.unsynced }} change{{ status.unsynced === 1 ? '' : 's' }} not yet sent</template>
        </p>
      </section>

      <CodeSection v-if="doc && runner" :runner="runner" @packages="(engine) => { emit('packages', runner!, engine); emit('close'); }" />

      <section class="menu-section">
        <h3>{{ workspace?.name ?? 'Workspace' }}</h3>
        <p class="menu-facts">
          <template v-if="workspace">
            On <code>{{ workspace.branch }}</code><template v-if="workspace.head"> at <code>{{ workspace.head.slice(0, 7) }}</code></template>
          </template>
          <template v-else>{{ hostUrl }}</template>
          <template v-if="status"> · {{ CONNECTION[status.connection] ?? status.connection }}</template>
        </p>
        <ul v-if="status && status.peers.length > 0" class="menu-peers">
          <li v-for="x in status.peers" :key="x.clientId" :title="x.email || x.name">
            <span class="menu-person" :style="{ background: x.color }" />{{ x.name || 'Anonymous' }}{{ x.self ? ' (you)' : '' }}
          </li>
        </ul>
        <div class="menu-actions">
          <button type="button" :disabled="syncing || !workspace" title="Commit, fetch, merge and push against the upstream remote" @click="emit('sync'); emit('close')">
            {{ syncing ? 'Syncing…' : 'Sync' }}
          </button>
        </div>
      </section>

      <section class="menu-section">
        <h3>Plugins</h3>
        <p class="menu-facts">What runs code and where, the document formats, and your editing behaviour.</p>
        <div class="menu-actions">
          <button type="button" @click="emit('plugins'); emit('close')">Plugins…</button>
        </div>
      </section>

      <section class="menu-section">
        <h3>You</h3>
        <SettingsForm :initial="settings" :shell="shell" @save="(s) => { emit('saveSettings', s); emit('close'); }" />
      </section>

      <div class="modal-actions"><button type="button" @click="emit('close')">Close</button></div>
    </div>
  </div>
</template>
