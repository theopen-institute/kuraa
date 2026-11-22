<script setup lang="ts">
// The document's ⋯ menu (decision 0065), from the top-right corner of the open
// document: what to do with it. Its views and versions (Source, History, Save
// version, Preview), writing in it (Find and replace, Outline, Insert table,
// Next conflict), when it was last saved, its code session (CodeSection), and
// the way to its settings (Settings › Document) and to the Markdown and
// shortcuts sheet. It holds no settings: those are in the Settings window
// (0064). It takes focus as a dialog does; Escape or a click outside closes it.
import { computed, useTemplateRef } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import type { ChunkRunner } from './runs.js';
import type { EditorStatus } from './types.js';
import { time } from './labels.js';
import { APP_KEYS, keyLabel } from './keys.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';
import CodeSection from './CodeSection.vue';

const props = defineProps<{
  /** What the open file is called: its title, or its filename. */
  name: string | null;
  type: DocumentType;
  status: EditorStatus | null;
  showSource: boolean;
  historyOpen: boolean;
  /** How many conflicts the open document keeps. */
  conflicts?: number;
  /** Where it opens: under the ⋯ button, its right edge with the button's (px from the window's top and right). */
  at: { top: number; right: number };
}>();
const emit = defineEmits<{
  toggleSource: [];
  toggleHistory: [];
  saveVersion: [];
  preview: [];
  find: [];
  outline: [];
  insertTable: [];
  nextConflict: [];
  packages: [runner: ChunkRunner, engine: string];
  /** Settings, at the document's section. */
  settings: [];
  help: [];
  close: [];
}>();

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('close'));

/** Close the menu, then do something (the menu is out of the way first). */
function then(fn: () => void) {
  emit('close');
  fn();
}

const layout = computed(() => !!props.type.editor?.layout);
const runner = computed(() => props.status?.runner ?? null);
</script>

<template>
  <div class="popover-backdrop" @mousedown.self="emit('close')">
    <div ref="root" class="document-menu" role="dialog" :aria-label="S.docMenu.label" :style="{ top: `${at.top}px`, right: `${at.right}px` }" data-testid="document-menu">
      <section class="menu-section">
        <h3>{{ name }}</h3>
        <div class="menu-actions">
          <button
            v-if="!layout"
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
          <button v-if="!layout" type="button" :title="S.menu.previewTitle(keyLabel(APP_KEYS.preview))" data-testid="menu-preview" @click="then(() => emit('preview'))">{{ S.menu.preview }}</button>
        </div>
        <div v-if="!layout && !showSource" class="menu-actions" data-testid="menu-writing">
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
      </section>

      <CodeSection v-if="runner" :runner="runner" @packages="(engine) => then(() => emit('packages', runner!, engine))" />

      <section class="menu-section menu-links">
        <div class="menu-actions">
          <button type="button" data-testid="menu-document" @click="then(() => emit('settings'))">{{ S.menu.documentSettings }}</button>
          <button type="button" :title="S.menu.helpTitle(keyLabel(APP_KEYS.help))" data-testid="menu-help" @click="then(() => emit('help'))">{{ S.menu.help }}</button>
        </div>
      </section>
    </div>
  </div>
</template>
