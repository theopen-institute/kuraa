<script setup lang="ts">
// The find bar (⌘F): find in the document, the next and previous match, how
// many there are, case, and replacing one or all. Replacing is ordinary editing.
import { computed, nextTick, onMounted, ref, useTemplateRef, watch } from 'vue';
import type { EditorView } from 'prosemirror-view';
import { findState, replaceAll, replaceOne, setQuery, step } from './find.js';

const props = defineProps<{
  view: EditorView;
  /** Goes up with every change to the editor, so the count follows. */
  tick: number;
  /** What to look for when opened (the selected text). */
  initial: string;
  /** Goes up each time ⌘F is pressed again while open. */
  focusKey: number;
}>();
const emit = defineEmits<{ close: [] }>();

const query = ref(props.initial);
const replacement = ref('');
const caseSensitive = ref(false);
const replacing = ref(false);
const input = useTemplateRef<HTMLInputElement>('input');
const editable = computed(() => props.view.editable);

const counts = computed(() => {
  void props.tick;
  const s = findState(props.view);
  return { total: s?.matches.length ?? 0, current: s && s.current >= 0 ? s.current + 1 : 0 };
});

watch([query, caseSensitive], () => setQuery(props.view, query.value, caseSensitive.value));
onMounted(() => {
  setQuery(props.view, query.value, caseSensitive.value);
  input.value?.select();
});
watch(() => props.focusKey, () => {
  if (props.initial) query.value = props.initial;
  void nextTick(() => input.value?.select());
});

function close() {
  setQuery(props.view, '', caseSensitive.value);
  emit('close');
  props.view.focus();
}

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'Enter' && (e.target as HTMLElement).dataset.role === 'find') {
    e.preventDefault();
    step(props.view, e.shiftKey ? -1 : 1);
  } else if (e.key === 'Enter' && (e.target as HTMLElement).dataset.role === 'replace') {
    e.preventDefault();
    replaceOne(props.view, replacement.value);
  } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'g') {
    e.preventDefault();
    step(props.view, e.shiftKey ? -1 : 1);
  }
}

function all() {
  replaceAll(props.view, replacement.value);
}
</script>

<template>
  <div class="find-bar" role="search" data-testid="find-bar" @keydown="onKey">
    <div class="find-row">
      <input
        ref="input"
        v-model="query"
        data-role="find"
        data-testid="find-input"
        placeholder="Find"
        aria-label="Find"
        spellcheck="false"
      >
      <span class="find-count" data-testid="find-count">{{ query ? (counts.total ? `${counts.current || '–'} of ${counts.total}` : 'None') : '' }}</span>
      <button
        type="button"
        :class="['find-case', { active: caseSensitive }]"
        :aria-pressed="caseSensitive"
        title="Match case"
        data-testid="find-case"
        @click="caseSensitive = !caseSensitive"
      >Aa</button>
      <button type="button" title="Previous (⇧↩)" aria-label="Previous match" data-testid="find-previous" :disabled="!counts.total" @click="step(view, -1)">↑</button>
      <button type="button" title="Next (↩)" aria-label="Next match" data-testid="find-next" :disabled="!counts.total" @click="step(view, 1)">↓</button>
      <button v-if="editable" type="button" :class="{ active: replacing }" title="Replace" data-testid="find-toggle-replace" @click="replacing = !replacing">Replace</button>
      <button type="button" title="Close (Esc)" aria-label="Close" data-testid="find-close" @click="close">✕</button>
    </div>
    <div v-if="replacing && editable" class="find-row">
      <input v-model="replacement" data-role="replace" data-testid="replace-input" placeholder="Replace with" aria-label="Replace with" spellcheck="false">
      <button type="button" data-testid="replace-one" :disabled="!counts.total" @click="replaceOne(view, replacement)">Replace</button>
      <button type="button" data-testid="replace-all" :disabled="!counts.total" @click="all">Replace all</button>
    </div>
  </div>
</template>
