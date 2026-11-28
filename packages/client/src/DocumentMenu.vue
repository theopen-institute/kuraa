<script setup lang="ts">
// The document's ⋯ menu (decision 0065), from the top-right corner of the open
// document: what to do with it, as a menu like any other (0072). Its views
// (Source, History, Export…), writing in it (Find and replace, Outline, Insert
// table, Next conflict), Save version, what features add (each in a group of its
// own: Preview's, the comments', the code session's: 0082, 0092), and the way to
// its permissions, its settings (Settings › Document) and the Markdown
// and shortcuts sheet; below them, when it was last saved. Each item says its
// keys, if it has any. Arrow keys, Home and End move between the items; Escape,
// a click outside, or choosing one closes it.
import { computed, useTemplateRef } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import type { EditorStatus } from './types.js';
import { time } from './labels.js';
import { APP_KEYS, keyLabel } from './keys.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';
import type { MenuLine } from './commands.js';

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
  /** The workspace is shared with other people's devices: Permissions… is offered (0066). */
  shared?: boolean;
  /** What features add (0082, 0092): groups of their own, after the versions; an item or a line of words each. */
  featureGroups?: MenuLine[][];
  /** Lines features add to the foot, above whether it is saved (0094: its word count). */
  featureFooter?: { text: string; testid?: string; title?: string; run?(): void }[];
}>();
const emit = defineEmits<{
  toggleSource: [];
  toggleHistory: [];
  saveVersion: [];
  find: [];
  insertTable: [];
  nextConflict: [];
  /** Settings, at the document's section. */
  settings: [];
  /** The document's permissions: who can read it, and who can change it (0066, 0067). */
  permissions: [];
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

interface Item {
  label: string;
  run: () => void;
  testid?: string;
  /** Its keys (keys.ts), shown at its right. */
  keys?: string;
  /** A view that is on or off: shown with a tick when on. */
  checked?: boolean;
  title?: string;
  disabled?: boolean;
  /** A line of words, not to be chosen (a feature's: 0092), with its classes. */
  note?: string;
  className?: string;
}

const layout = computed(() => !!props.type.editor?.layout);

/** The items, in groups with a line between them: the core's, then each feature's; then the document's own (below). */
const groups = computed<Item[][]>(() => {
  const view: Item[] = [];
  if (!layout.value) view.push({ label: S.menu.source, checked: props.showSource, testid: 'toggle-source', run: () => then(() => emit('toggleSource')) });
  view.push({ label: S.menu.history, checked: props.historyOpen, testid: 'menu-history', run: () => then(() => emit('toggleHistory')) });
  const writing: Item[] = [];
  if (!layout.value && !props.showSource) {
    writing.push(
      { label: S.menu.find, keys: APP_KEYS.find, testid: 'menu-find', run: () => then(() => emit('find')) },
      { label: S.menu.insertTable, keys: 'Mod-Alt-t', testid: 'menu-insert-table', run: () => then(() => emit('insertTable')) },
    );
    if (props.conflicts) writing.push({ label: S.menu.nextConflict, keys: 'Mod-Alt-n', testid: 'menu-next-conflict', run: () => then(() => emit('nextConflict')) });
  }
  const versions: Item[] = [{ label: S.menu.saveVersion, testid: 'menu-save-version', run: () => then(() => emit('saveVersion')) }];
  const features: Item[][] = (props.featureGroups ?? []).map((g) => g.map((i) => ('note' in i
    ? { label: i.note, note: i.note, title: i.title, testid: i.testid, className: i.className, run: () => undefined }
    : { label: i.label, keys: i.keys, testid: i.testid, title: i.title, disabled: i.disabled, run: () => then(() => i.run()) })));
  return [view, writing, versions, ...features].filter((g) => g.length);
});

const own = computed<Item[]>(() => [
  ...(props.shared ? [{ label: S.permissions.menu, testid: 'menu-permissions', run: () => then(() => emit('permissions')) }] : []),
  { label: S.menu.documentSettings, testid: 'menu-document', run: () => then(() => emit('settings')) },
  { label: S.menu.help, keys: APP_KEYS.help, title: S.menu.helpTitle(keyLabel(APP_KEYS.help)), testid: 'menu-help', run: () => then(() => emit('help')) },
]);

/** Arrow keys, Home and End: from item to item (those not disabled), round and round. */
function onKey(e: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const items = [...(root.value?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not(:disabled)') ?? [])];
  if (!items.length) return;
  e.preventDefault();
  const at = items.indexOf(document.activeElement as HTMLButtonElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (at + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}
</script>

<template>
  <div class="popover-backdrop" @mousedown.self="emit('close')">
    <div ref="root" class="document-menu" role="menu" :aria-label="name ? `${S.docMenu.label}: ${name}` : S.docMenu.label" :style="{ top: `${at.top}px`, right: `${at.right}px` }" data-testid="document-menu" @keydown="onKey">
      <template v-for="(group, g) in groups" :key="g">
        <div v-if="g" class="menu-divider" role="separator" />
        <template v-for="item in group" :key="item.label">
        <p v-if="item.note !== undefined" class="menu-note" role="none"><span :class="item.className" :title="item.title" :data-testid="item.testid">{{ item.note }}</span></p>
        <button
          v-else
          type="button"
          :role="item.checked === undefined ? 'menuitem' : 'menuitemcheckbox'"
          :aria-checked="item.checked === undefined ? undefined : item.checked"
          class="menu-item"
          :title="item.title"
          :disabled="item.disabled"
          :data-testid="item.testid"
          @click="item.run()"
        >
          <span class="menu-check" aria-hidden="true">{{ item.checked ? '✓' : '' }}</span>
          <span class="menu-label">{{ item.label }}</span>
          <span v-if="item.keys" class="menu-keys" aria-hidden="true">{{ keyLabel(item.keys) }}</span>
        </button>
        </template>
      </template>

      <div class="menu-divider" role="separator" />
      <button v-for="item in own" :key="item.label" type="button" role="menuitem" class="menu-item" :title="item.title" :data-testid="item.testid" @click="item.run()">
        <span class="menu-check" aria-hidden="true" />
        <span class="menu-label">{{ item.label }}</span>
        <span v-if="item.keys" class="menu-keys" aria-hidden="true">{{ keyLabel(item.keys) }}</span>
      </button>

      <!-- The foot, under one rule: what features add (the word count), then whether it is saved. -->
      <div v-if="status || featureFooter?.length" class="menu-footer" role="none">
        <template v-for="line in featureFooter ?? []" :key="line.text">
          <!-- A line that does something is chosen as an item is (click, Enter; the arrows reach it). -->
          <button v-if="line.run" type="button" role="menuitem" class="menu-footer-line menu-footer-action" :title="line.title" :data-testid="line.testid" @click="then(() => line.run!())">{{ line.text }}</button>
          <p v-else class="menu-footer-line" role="none" :title="line.title" :data-testid="line.testid">{{ line.text }}</p>
        </template>
        <p v-if="status" class="menu-footer-line" role="none" :title="status.lastCommit ? S.menu.versionDetails(status.lastCommit.slice(0, 7)) : undefined">
          <!-- Whether what was typed here is saved (at the host), in plain words; then the latest version, if there is one this session. -->
          <span data-testid="save-state">{{ status.unsynced === 0 ? S.menu.allSaved : status.connection === 'connected' ? S.menu.saving : S.menu.notSaved(status.unsynced) }}</span>
          <template v-if="status.lastCommitAt"> · <span data-testid="last-commit">{{ S.menu.lastVersion(time(status.lastCommitAt)) }}</span></template>
        </p>
      </div>
    </div>
  </div>
</template>
