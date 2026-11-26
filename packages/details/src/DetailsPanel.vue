<script setup lang="ts">
// The Details panel (0094): the open document's synopsis, label, status and
// keywords, as its header has them; each saved to the header as it is left
// (Enter, or choosing), as one edit everyone sees and that can be undone.
// Suggestions: the labels and keywords the workspace already uses, and its
// statuses.
import { computed, onBeforeUnmount, ref } from 'vue';
import type { FeaturePanelContext } from '@kuraa/feature-kit/client';
import { detailsOf, keywordsOf, type Details } from './details.js';
import { remember, statusesOf, used } from './store.js';
import { S } from './strings.js';

const props = defineProps<{ ctx: FeaturePanelContext }>();
const ctx = props.ctx;

const path = ref<string | null>(null);
const hasHeader = ref(false);
const synopsis = ref('');
const label = ref('');
const status = ref('');
const keywords = ref('');
/** What the header said when last read: a field is read again only if it changed there, not while it is being typed in. */
let shown: Details | null = null;

function read() {
  const header = ctx.header();
  const p = ctx.path();
  hasHeader.value = !!header;
  const d = header ? detailsOf((k) => header.get(k)) : null;
  const other = p !== path.value;
  path.value = p;
  if (!d) {
    shown = null;
    return;
  }
  // Another document, or a field changed in the header (by someone else, or undone): shown as it is.
  if (other || shown?.synopsis !== d.synopsis) synopsis.value = d.synopsis ?? '';
  if (other || shown?.label !== d.label) label.value = d.label ?? '';
  if (other || shown?.status !== d.status) status.value = d.status ?? '';
  if (other || JSON.stringify(shown?.keywords) !== JSON.stringify(d.keywords)) keywords.value = d.keywords.join(', ');
  shown = d;
}
const stop = ctx.onDocument(read);
const first = setTimeout(read, 50);
read();
onBeforeUnmount(() => {
  stop();
  clearTimeout(first);
});

/** One field to the header, if it changed. */
function save(key: 'synopsis' | 'label' | 'status' | 'keywords') {
  const header = ctx.header();
  const p = ctx.path();
  if (!header || !p || !shown) return;
  const value = key === 'keywords' ? keywordsOf(keywords.value) : { synopsis, label, status }[key].value.trim() || null;
  const was = shown[key];
  if (JSON.stringify(was) === JSON.stringify(key === 'keywords' ? value : value ?? null)) return;
  header.set({ [key]: value });
  read();
  if (shown) remember(ctx, p, shown);
}

const statuses = computed(() => {
  const list = statusesOf(ctx);
  return status.value && !list.includes(status.value) ? [...list, status.value] : list;
});
const labels = computed(() => used((d) => [d.label]));
const knownKeywords = computed(() => used((d) => d.keywords));
</script>

<template>
  <div class="details-panel" data-testid="details-panel">
    <p v-if="!path" class="details-about">{{ S.noDocument }}</p>
    <p v-else-if="!hasHeader" class="details-about">{{ S.noHeader }}</p>
    <template v-else>
      <label class="details-field">
        <span>{{ S.synopsis }}</span>
        <textarea v-model="synopsis" rows="4" :placeholder="S.synopsisPlaceholder" data-testid="details-synopsis" @change="save('synopsis')" />
      </label>
      <label class="details-field">
        <span>{{ S.label }}</span>
        <input v-model="label" type="text" list="details-labels" :placeholder="S.labelPlaceholder" data-testid="details-label" @change="save('label')" @keydown.enter="save('label')" />
        <datalist id="details-labels"><option v-for="l in labels" :key="l" :value="l" /></datalist>
      </label>
      <label class="details-field">
        <span>{{ S.status }}</span>
        <select v-model="status" data-testid="details-status" @change="save('status')">
          <option value="">{{ S.noStatus }}</option>
          <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
        </select>
      </label>
      <label class="details-field">
        <span>{{ S.keywords }}</span>
        <input v-model="keywords" type="text" list="details-keywords" :placeholder="S.keywordsPlaceholder" data-testid="details-keywords" @change="save('keywords')" @keydown.enter="save('keywords')" />
        <datalist id="details-keywords"><option v-for="k in knownKeywords" :key="k" :value="k" /></datalist>
      </label>
      <p class="details-about">{{ S.about }}</p>
    </template>
  </div>
</template>

<style>
.details-panel { display: grid; gap: 12px; padding: 10px 12px; align-content: start; }
.details-field { display: grid; gap: 3px; }
.details-field > span { color: var(--muted); font-size: 12px; }
.details-field > textarea { resize: vertical; font: inherit; }
.details-about { margin: 0; color: var(--muted); font-size: 12px; }
</style>
