<script setup lang="ts">
// The menu: everything that is not the document. Opened from the bottom of the
// sidebar (or ⌘,). Sections: this document (views, versions, saving), code (the
// session, packages), the workspace (sync, connection, who is here), and you
// (your settings, you on this computer, and the shell's own actions). The host
// and its token, where the shell does not run the host, is a panel of its own,
// opened from You.
import { computed, onMounted, ref, shallowRef } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import type { HostApi, WorkspaceInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import type { Settings } from './settings.js';
import type { PersonShell, Shell } from './shell.js';
import { personShellFor } from './hostPerson.js';
import type { EditorStatus } from './types.js';
import { CONNECTION, time } from './labels.js';
import { onEscape } from './vue.js';
import CodeSection from './CodeSection.vue';
import DevicesSection from './DevicesSection.vue';
import OnlineCopySection from './OnlineCopySection.vue';
import SettingsForm from './SettingsForm.vue';
import PersonKey from './PersonKey.vue';

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
  close: [];
}>();

/** The menu itself, or its Host panel. */
const panel = ref<'menu' | 'access'>('menu');
onEscape(() => {
  if (panel.value === 'access') panel.value = 'menu';
  else emit('close');
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
    <div v-if="panel === 'access'" class="modal menu" role="dialog" aria-label="Host" data-testid="menu">
      <div class="menu-panel-head">
        <button type="button" class="menu-back" data-testid="menu-back" @click="panel = 'menu'">‹ Menu</button>
        <h2>Host</h2>
      </div>
      <section v-if="!shell.managesHost" class="menu-section" data-testid="menu-connection">
        <h3>Host</h3>
        <p class="menu-facts">The host this app works with, and the token it lets you in by.</p>
        <SettingsForm :initial="settings" :shell="shell" part="connection" @save="(s) => { emit('saveSettings', s); emit('close'); }" />
      </section>
      <div class="modal-actions"><button type="button" @click="emit('close')">Close</button></div>
    </div>
    <div v-else class="modal menu" role="dialog" aria-label="Menu" data-testid="menu">
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
          <button v-if="hasHeader" type="button" data-testid="menu-header" @click="emit('header'); emit('close')">Header…</button>
          <button type="button" :class="{ active: historyOpen }" :aria-pressed="historyOpen" @click="emit('toggleHistory'); emit('close')">
            {{ historyOpen ? 'Hide history' : 'History' }}
          </button>
          <button type="button" @click="emit('saveVersion'); emit('close')">Save version…</button>
          <button v-if="!type!.editor?.layout" type="button" title="Render the document to HTML, Word or PDF (⇧⌘R)" data-testid="menu-preview" @click="emit('preview'); emit('close')">Preview</button>
        </div>
        <div v-if="doc && !type!.editor?.layout && !showSource" class="menu-actions" data-testid="menu-writing">
          <button type="button" title="⌘F" data-testid="menu-find" @click="emit('close'); emit('find')">Find and replace…</button>
          <button type="button" title="⌥⌘O" data-testid="menu-outline" @click="emit('close'); emit('outline')">Outline</button>
          <button type="button" data-testid="menu-insert-table" @click="emit('close'); emit('insertTable')">Insert table</button>
          <button v-if="conflicts" type="button" title="⌥⌘N" data-testid="menu-next-conflict" @click="emit('close'); emit('nextConflict')">Next conflict</button>
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
          <button type="button" :disabled="!workspace" title="Search every file (⇧⌘F)" data-testid="menu-search" @click="emit('search'); emit('close')">Search…</button>
          <button type="button" :disabled="syncing || !workspace" title="Save, bring in what the others online have done, and update the online copy, if there is one" @click="emit('sync'); emit('close')">
            {{ syncing ? 'Syncing…' : 'Sync' }}
          </button>
        </div>
      </section>

      <DevicesSection :api="api" @invite="emit('invite'); emit('close')" />
      <OnlineCopySection :api="api" />

      <section class="menu-section">
        <h3>Components</h3>
        <p class="menu-facts">What runs code and where, the document formats, and your editing behaviour.</p>
        <div class="menu-actions">
          <button type="button" @click="emit('components'); emit('close')">Components…</button>
        </div>
      </section>

      <section class="menu-section">
        <h3>You</h3>
        <SettingsForm :initial="settings" :shell="shell" part="profile" @save="(s) => { emit('saveSettings', s); emit('close'); }" />
        <PersonKey v-if="personShell" :person="personShell" :display-name="settings.name" />
        <div v-if="!shell.managesHost" class="menu-actions">
          <button type="button" data-testid="menu-access" @click="panel = 'access'">Host and token…</button>
        </div>
      </section>

      <div class="modal-actions"><button type="button" @click="emit('close')">Close</button></div>
    </div>
  </div>
</template>
