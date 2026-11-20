<script setup lang="ts">
// Markdown and shortcuts (⌘/, the menu, the desktop app's Help menu): what can
// be typed and pressed, from the editor modules' own help and the client's keys
// (help.ts), shown for this system (⌘ or Ctrl).
import { computed, useTemplateRef } from 'vue';
import type { FormatEditor } from '@kuraa/editor-kit';
import { helpSheet } from './help.js';
import { keyLabel } from './keys.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';

const props = defineProps<{ editors: Record<string, FormatEditor> }>();
const emit = defineEmits<{ close: [] }>();

const groups = computed(() => helpSheet(props.editors));
const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('close'));
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div ref="root" class="modal help-sheet" role="dialog" aria-modal="true" aria-labelledby="help-title" data-testid="help">
      <h2 id="help-title">{{ S.help.title }}</h2>
      <p class="muted">{{ S.help.about }}</p>
      <div class="help-groups">
        <section v-for="g in groups" :key="g.title" class="help-group" :data-testid="`help:${g.title}`">
          <h3>{{ g.title }}</h3>
          <table>
            <tbody>
              <tr v-for="(item, i) in g.items" :key="i">
                <th scope="row">
                  <code v-if="item.type" class="help-type">{{ item.type }}</code>
                  <span v-else class="help-keys">
                    <kbd v-for="k in item.keys" :key="k">{{ keyLabel(k) }}</kbd>
                  </span>
                </th>
                <td>{{ item.does }}</td>
              </tr>
            </tbody>
          </table>
        </section>
      </div>
      <div class="modal-actions"><button type="button" @click="emit('close')">{{ S.common.close }}</button></div>
    </div>
  </div>
</template>
