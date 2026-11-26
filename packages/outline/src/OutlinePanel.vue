<script setup lang="ts">
// The Outline (⌥⌘O, or the menu): the document's headings as they are now;
// click one to go there. Arrows move through it, Enter goes, Escape closes.
// Drawn over the document's top left (an `over` panel, 0089).
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, useTemplateRef } from 'vue';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { FeaturePanelContext } from '@kuraa/feature-kit/client';
import { currentHeading, outlineOf } from './outline.js';
import { KEYS, S } from './strings.js';

const props = defineProps<{ ctx: FeaturePanelContext }>();

/** Goes up with every change to the document, so the outline follows it. */
const tick = ref(0);
const view = shallowRef<EditorView | null>(props.ctx.view());
const stop = props.ctx.onDocument(() => {
  view.value = props.ctx.view();
  tick.value++;
});
onBeforeUnmount(stop);

const entries = computed(() => {
  void tick.value;
  return view.value ? outlineOf(view.value.state.doc) : [];
});
const here = computed(() => {
  void tick.value;
  return view.value ? currentHeading(entries.value, view.value.state.selection.from) : -1;
});
const minLevel = computed(() => Math.min(6, ...entries.value.map((e) => e.level)));
const active = ref(-1);
const list = useTemplateRef<HTMLElement>('list');

onMounted(() => {
  active.value = Math.max(0, here.value);
  (list.value?.querySelectorAll('button')[active.value] as HTMLElement | undefined)?.focus();
});

function close() {
  const v = view.value;
  props.ctx.close();
  if (v && !v.isDestroyed) v.focus();
}

function go(i: number) {
  const e = entries.value[i];
  const v = view.value;
  if (!e || !v || v.isDestroyed) return;
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
    close();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    buttons[Math.max(0, Math.min(buttons.length - 1, i + (e.key === 'ArrowDown' ? 1 : -1)))]?.focus();
  }
}
</script>

<template>
  <nav class="outline-panel" :aria-label="S.title" data-testid="outline" @keydown="onKey">
    <div class="outline-head">
      <span>{{ S.title }}</span>
      <button type="button" :title="`${S.close} (${ctx.keyLabel(KEYS.close)})`" :aria-label="S.close" data-testid="outline-close" @click="close">✕</button>
    </div>
    <p v-if="!entries.length" class="outline-empty">{{ S.empty }}</p>
    <ul v-else ref="list">
      <li v-for="(e, i) in entries" :key="`${i}:${e.pos}`">
        <button
          type="button"
          :class="['outline-entry', { current: i === here }]"
          :style="{ paddingLeft: `${8 + (e.level - minLevel) * 14}px` }"
          :data-testid="`outline:${e.text}`"
          :aria-current="i === here ? 'location' : undefined"
          @click="go(i)"
        >{{ e.text || S.untitled }}</button>
      </li>
    </ul>
  </nav>
</template>

<style>
.outline-panel {
  position: absolute; top: 8px; left: 16px; z-index: 20; width: 16rem; max-height: calc(100% - 24px); overflow: auto; padding: 6px;
  background: var(--surface); border: 1px solid var(--border); border-radius: 8px; box-shadow: 0 6px 20px rgb(0 0 0 / 0.12); font: 13px var(--font);
}
.outline-head { display: flex; justify-content: space-between; align-items: center; padding: 2px 6px 6px; color: var(--muted); }
.outline-head button { border: 0; background: none; padding: 0 4px; }
.outline-panel ul { list-style: none; margin: 0; padding: 0; }
.outline-entry { display: block; width: 100%; border: 0; background: none; text-align: left; padding: 3px 8px; border-radius: 5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.outline-entry:hover, .outline-entry:focus-visible { background: var(--selected); outline: none; }
.outline-entry.current { color: var(--accent); font-weight: 600; }
.outline-empty { margin: 4px 6px; color: var(--muted); }
</style>
