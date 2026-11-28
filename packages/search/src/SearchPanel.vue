<script setup lang="ts">
// Search across the workspace (⇧⌘F): every text file, and open documents as
// they are being edited. Results are grouped by file, documents by their title;
// choosing one opens the file at the match (the core's openMatch). Asked for
// again while open, the field takes focus (0089). Its host half searches (0124).
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import type { FeaturePanelContext } from '@kuraa/feature-kit/client';
import type { SearchMatch, SearchResult } from './search.js';
import { S } from './strings.js';

const props = defineProps<{ ctx: FeaturePanelContext }>();

const query = ref('');
const caseSensitive = ref(false);
const result = shallowRef<SearchResult | null>(null);
const searched = ref('');
const error = shallowRef<{ text: string; details: string | null } | null>(null);
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
    const r = (await props.ctx.request('GET', `search?q=${encodeURIComponent(q)}${caseSensitive.value ? '&case=1' : ''}`)) as unknown as SearchResult;
    if (n !== asked) return;
    result.value = r;
    searched.value = q;
    error.value = null;
  } catch (e) {
    if (n === asked) error.value = props.ctx.explain(e);
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
const focusField = () => {
  field.value?.focus();
  field.value?.select();
};
onMounted(focusField);
const stop = props.ctx.onAsk(focusField);
onBeforeUnmount(() => {
  stop();
  clearTimeout(timer);
});

const count = computed(() => result.value?.files.reduce((n, f) => n + f.matches.length, 0) ?? 0);
const fileName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
/** A match's line, in three parts: before, the phrase, after. */
const parts = (m: SearchMatch) => [m.text.slice(0, m.column), m.text.slice(m.column, m.column + searched.value.length), m.text.slice(m.column + searched.value.length)];
const open = (path: string, m: SearchMatch) => props.ctx.openMatch(path, { line: m.line, at: m.at, query: searched.value, caseSensitive: caseSensitive.value });
</script>

<template>
  <div class="search-panel" data-testid="search-panel">
    <form class="search-form" @submit.prevent="search">
      <input
        ref="field"
        v-model="query"
        type="search"
        :placeholder="S.field"
        :aria-label="S.field"
        spellcheck="false"
        data-testid="search-input"
      >
      <label class="search-case"><input v-model="caseSensitive" type="checkbox" data-testid="search-case"> {{ S.matchCase }}</label>
    </form>
    <div v-if="error" class="banner warn" role="alert" data-testid="error">
      <span>{{ error.text }}</span>
      <details v-if="error.details" class="error-details">
        <summary>{{ S.details }}</summary>
        <pre>{{ error.details }}</pre>
      </details>
    </div>
    <p v-if="result && searched" class="muted pad search-summary" data-testid="search-summary">
      <template v-if="!result.files.length">{{ S.nothing(searched) }}</template>
      <template v-else>{{ S.summary(count, result.files.length, result.truncated) }}</template>
    </p>
    <p v-else-if="searching" class="muted pad">{{ S.searching }}</p>
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
  </div>
</template>

<style>
.search-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.search-form { display: grid; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.search-form input[type='search'] { width: 100%; }
.search-case { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); }
.search-summary { font-size: 12px; margin: 0; }
.search-results { list-style: none; margin: 0; padding: 0 6px 12px; overflow: auto; flex: 1; }
.search-file { margin-top: 8px; }
.search-file-name { display: grid; padding: 2px 6px; }
.search-file-title { font-weight: 600; font-size: 13px; }
.search-file-path { font-size: 11px; }
.search-matches { list-style: none; margin: 0; padding: 0; }
.search-matches button { display: flex; gap: 8px; width: 100%; text-align: left; border: 0; border-radius: 5px; padding: 3px 6px; background: none; font-size: 12px; }
.search-matches button:hover { background: var(--selected); }
.search-line { color: var(--muted); min-width: 2.5em; text-align: right; font-variant-numeric: tabular-nums; }
.search-text { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--mono); }
.search-text mark { background: var(--accent-soft); color: inherit; border-radius: 2px; }
</style>
