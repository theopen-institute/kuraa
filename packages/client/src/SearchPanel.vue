<script setup lang="ts">
// Search across the workspace (⇧⌘F): every text file, and open documents as
// they are being edited. Results are grouped by file, documents by their title;
// choosing one opens the file at the match.
import { computed, ref, shallowRef, watch } from 'vue';
import type { HostApi, SearchMatch, SearchResult } from './api.js';
import type { MatchTarget } from './docActions.js';
import { vFocus } from './vue.js';

const props = defineProps<{ api: HostApi; /** Goes up each time search is asked for again (⇧⌘F): the field takes focus. */ focusKey: number }>();
const emit = defineEmits<{ open: [path: string, target: MatchTarget]; close: [] }>();

const query = ref('');
const caseSensitive = ref(false);
const result = shallowRef<SearchResult | null>(null);
const searched = ref('');
const error = ref<string | null>(null);
const searching = ref(false);
const field = ref<HTMLInputElement | null>(null);
let asked = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

async function search() {
  clearTimeout(timer);
  const q = query.value;
  const n = ++asked;
  if (!q.trim()) {
    result.value = null;
    searched.value = '';
    return;
  }
  searching.value = true;
  try {
    const r = await props.api.search(q, caseSensitive.value);
    if (n !== asked) return;
    result.value = r;
    searched.value = q;
    error.value = null;
  } catch (e) {
    if (n === asked) error.value = (e as Error).message;
  } finally {
    if (n === asked) searching.value = false;
  }
}

// As people type, after a pause; at once on Enter, or when the case choice changes.
watch(query, () => {
  clearTimeout(timer);
  timer = setTimeout(() => void search(), 300);
});
watch(caseSensitive, () => void search());
watch(() => props.focusKey, () => {
  field.value?.focus();
  field.value?.select();
});

const count = computed(() => result.value?.files.reduce((n, f) => n + f.matches.length, 0) ?? 0);
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** A match's line, in three parts: before, the phrase, after. */
const parts = (m: SearchMatch) => [m.text.slice(0, m.column), m.text.slice(m.column, m.column + searched.value.length), m.text.slice(m.column + searched.value.length)];
const open = (path: string, m: SearchMatch) => emit('open', path, { line: m.line, at: m.at, query: searched.value, caseSensitive: caseSensitive.value });
</script>

<template>
  <aside class="pane pane-right side-panel search-panel" aria-label="Search" data-testid="search-panel">
    <div class="pane-header">
      <span>Search</span>
      <div class="pane-header-actions">
        <button type="button" title="Close search" aria-label="Close search" @click="emit('close')">×</button>
      </div>
    </div>
    <form class="search-form" @submit.prevent="search">
      <input
        ref="field"
        v-model="query"
        v-focus
        type="search"
        placeholder="Search every file"
        aria-label="Search every file"
        spellcheck="false"
        data-testid="search-input"
        @keydown.esc="emit('close')"
      >
      <label class="search-case"><input v-model="caseSensitive" type="checkbox" data-testid="search-case"> Match case</label>
    </form>
    <p v-if="error" class="banner warn">{{ error }}</p>
    <p v-if="result && searched" class="muted pad search-summary" data-testid="search-summary">
      <template v-if="!result.files.length">Nothing found for “{{ searched }}”.</template>
      <template v-else>{{ count }} match{{ count === 1 ? '' : 'es' }} in {{ result.files.length }} file{{ result.files.length === 1 ? '' : 's' }}{{ result.truncated ? ' (only the first are shown)' : '' }}.</template>
    </p>
    <p v-else-if="searching" class="muted pad">Searching…</p>
    <ol v-if="result" class="search-results" data-testid="search-results">
      <li v-for="f in result.files" :key="f.path" class="search-file" :data-testid="`search-file:${f.path}`">
        <div class="search-file-name" :title="f.path">
          <span class="search-file-title">{{ f.title || fileName(f.path) }}</span>
          <span v-if="f.title || f.path.includes('/')" class="muted search-file-path">{{ f.path }}</span>
        </div>
        <ol class="search-matches">
          <li v-for="(m, i) in f.matches" :key="i">
            <button type="button" data-testid="search-match" @click="open(f.path, m)">
              <span class="search-line">{{ m.line }}</span>
              <span class="search-text">{{ parts(m)[0] }}<mark>{{ parts(m)[1] }}</mark>{{ parts(m)[2] }}</span>
            </button>
          </li>
        </ol>
      </li>
    </ol>
  </aside>
</template>
