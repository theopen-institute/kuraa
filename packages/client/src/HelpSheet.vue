<script setup lang="ts">
// Markdown and shortcuts (⌘/, the menu, the desktop app's Help menu): what can
// be typed and pressed, from the editor modules' own help and the client's keys
// (help.ts), shown for this system (⌘ or Ctrl). One row for each thing: what it
// is, what to type for it, the keys for it. Writing in one column, the app in
// the other, each one table so its columns line up; a filter narrows them
// (decision 0085).
import { computed, ref, useTemplateRef } from 'vue';
import type { FormatEditor, HelpItem } from '@kuraa/editor-kit';
import { helpMatches, helpSheet, type HelpGroup } from './help.js';
import { keyLabel } from './keys.js';
import { S } from './strings.js';
import { useDialog, vFocus } from './vue.js';

const props = defineProps<{ editors: Record<string, FormatEditor> }>();
const emit = defineEmits<{ close: [] }>();

const query = ref('');
const groups = computed<HelpGroup[]>(() =>
  helpSheet(props.editors)
    .map((g) => ({ ...g, items: g.items.filter((i) => helpMatches(i, query.value, keyLabel)) }))
    .filter((g) => g.items.length),
);

/** Two columns, each kept in its place as the filter empties one: writing (the editor modules' and features' groups), then the app's keys. */
const columns = computed<HelpGroup[][]>(() => [groups.value.filter((g) => !g.app), groups.value.filter((g) => g.app)]);

/**
 * The keys as shown: Heading's ⌥⌘1, ⌥⌘2, ⌥⌘3 as one, ⌥⌘1–3 (the same
 * modifiers, numbers one after another); otherwise each as it is.
 */
function keyLabels(keys: string[] = []): string[] {
  const parts = keys.map((k) => /^(.*-)(\d)$/.exec(k));
  const run = keys.length > 2 && parts.every((p, i) => p && p[1] === parts[0]![1] && Number(p[2]) === Number(parts[0]![2]) + i);
  if (run) return [`${keyLabel(keys[0]!)}–${parts.at(-1)![2]}`];
  return keys.map((k) => keyLabel(k));
}

/** A note with the keys it names in braces ({Mod-Click}) shown for this system; other braces ({r label}) as they are. */
const noteText = (item: HelpItem) => item.note?.replace(/\{((?:Mod|Ctrl|Alt|Shift)-[^}]+)\}/g, (_, k: string) => keyLabel(k));

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('close'));
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div ref="root" class="modal help-sheet" role="dialog" aria-modal="true" aria-labelledby="help-title" data-testid="help">
      <header class="help-head">
        <div class="help-heading">
          <h2 id="help-title">{{ S.help.title }}</h2>
          <p class="muted">{{ S.help.about }}</p>
        </div>
        <input
          v-model="query"
          v-focus
          class="help-filter"
          type="search"
          :placeholder="S.help.filter"
          :aria-label="S.help.filterLabel"
          data-testid="help-filter"
        >
        <button type="button" @click="emit('close')">{{ S.common.close }}</button>
      </header>
      <div class="help-body">
        <p v-if="!groups.length" class="muted help-none" data-testid="help-none">{{ S.help.none(query.trim()) }}</p>
        <table v-for="(column, c) in columns" :key="c" class="help-column">
          <tbody v-for="g in column" :key="g.title" :data-testid="`help:${g.title}`">
            <tr class="help-group-row">
              <th colspan="3" scope="colgroup"><h3>{{ g.title }}</h3></th>
            </tr>
            <tr v-for="(item, i) in g.items" :key="i" class="help-row">
              <th scope="row" class="help-does">
                {{ item.does }}<span v-if="item.note" class="help-note">{{ noteText(item) }}</span>
              </th>
              <td class="help-cue">
                <template v-if="item.type">
                  <code>{{ item.type }}</code>
                  <template v-if="item.enter">
                    <span class="help-then">{{ S.help.then }}</span>
                    <kbd>{{ keyLabel('Enter') }}</kbd>
                  </template>
                </template>
              </td>
              <td class="help-keys">
                <template v-for="(k, j) in keyLabels(item.keys)" :key="k">
                  <span v-if="j" class="help-or" :aria-label="S.help.or">/</span>
                  <kbd>{{ k }}</kbd>
                </template>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
