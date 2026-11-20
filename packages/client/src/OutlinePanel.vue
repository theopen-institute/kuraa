<script setup lang="ts">
// The Outline (⌥⌘O, or the menu): the document's headings as they are now;
// click one to go there. Arrows move through it, Enter goes, Escape closes.
import { computed, onMounted, ref, useTemplateRef } from 'vue';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { currentHeading, outlineOf } from './outline.js';

const props = defineProps<{
  view: EditorView;
  /** Goes up with every change to the editor, so the outline follows it. */
  tick: number;
}>();
const emit = defineEmits<{ close: [] }>();

const entries = computed(() => {
  void props.tick;
  return outlineOf(props.view.state.doc);
});
const here = computed(() => {
  void props.tick;
  return currentHeading(entries.value, props.view.state.selection.from);
});
const minLevel = computed(() => Math.min(6, ...entries.value.map((e) => e.level)));
const active = ref(-1);
const list = useTemplateRef<HTMLElement>('list');

onMounted(() => {
  active.value = Math.max(0, here.value);
  (list.value?.querySelectorAll('button')[active.value] as HTMLElement | undefined)?.focus();
});

function go(i: number) {
  const e = entries.value[i];
  const v = props.view;
  if (!e || v.isDestroyed) return;
  const tr = v.state.tr.setSelection(TextSelection.create(v.state.doc, Math.min(e.pos + 1 + v.state.doc.nodeAt(e.pos)!.content.size, v.state.doc.content.size)));
  v.dispatch(tr);
  v.focus();
  (v.nodeDOM(e.pos) as HTMLElement | null)?.scrollIntoView?.({ block: 'start' });
}

function onKey(e: KeyboardEvent) {
  const buttons = [...(list.value?.querySelectorAll('button') ?? [])] as HTMLElement[];
  const i = buttons.indexOf(document.activeElement as HTMLElement);
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
    props.view.focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  }
}
</script>

<template>
  <nav class="outline-panel" aria-label="Outline" data-testid="outline" @keydown="onKey">
    <div class="outline-head">
      <span>Outline</span>
      <button type="button" title="Close (Esc)" aria-label="Close the outline" data-testid="outline-close" @click="emit('close'); view.focus()">✕</button>
    </div>
    <p v-if="!entries.length" class="outline-empty">No headings yet. Start a line with # and a space for one.</p>
    <ul v-else ref="list">
      <li v-for="(e, i) in entries" :key="`${i}:${e.pos}`">
        <button
          type="button"
          :class="['outline-entry', { current: i === here }]"
          :style="{ paddingLeft: `${8 + (e.level - minLevel) * 14}px` }"
          :data-testid="`outline:${e.text}`"
          @click="go(i)"
        >{{ e.text || 'Untitled heading' }}</button>
      </li>
    </ul>
  </nav>
</template>
