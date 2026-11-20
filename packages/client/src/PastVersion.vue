<script setup lang="ts">
// A past version of the open file, from its history: read only, rendered by its
// type or (for a document) shown as its source; compared with the document as
// it is now; or restored, as an edit to the live document (everyone with it open
// sees it, it can be undone, and it is saved like any edit).
import { computed, ref } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { CommitInfo } from './api.js';
import { blocksFrom, compareTexts, type Comparison } from './compare.js';
import { peopleOf } from './history.js';
import ReadOnlyCode from './ReadOnlyCode.vue';
import ReadOnlyDoc from './ReadOnlyDoc.vue';

const props = defineProps<{
  commit: CommitInfo;
  /** The file's text in that commit. */
  text: string;
  type: DocumentType;
  /** The file's path in that commit. */
  path: string;
  formatEditor?: FormatEditor;
  /** The document's text as it is now, in the live editor (null if it is not open). */
  now?: () => string | null;
}>();
const emit = defineEmits<{ back: []; restore: [] }>();

const mode = ref<'read' | 'source' | 'compare'>('read');
const comparison = ref<Comparison | null>(null);
const compareError = ref<string | null>(null);

function compare() {
  if (mode.value === 'compare') {
    mode.value = 'read';
    return;
  }
  const now = props.now?.() ?? null;
  if (now === null) {
    compareError.value = 'The document is not open, so there is nothing to compare with.';
    return;
  }
  comparison.value = compareTexts(props.text, now, blocksFrom((t) => props.type.parse(t)));
  compareError.value = null;
  mode.value = 'compare';
}

const date = computed(() => new Date(props.commit.date).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }));
const people = computed(() => peopleOf([props.commit]));
</script>

<template>
  <div class="editor-pane past-version" data-testid="past-version">
    <div class="toolbar">
      <span class="past-label">
        <strong data-testid="past-date">{{ date }}</strong> · {{ people }}
        <span class="muted">{{ mode === 'compare' ? '· compared with now' : '· read only' }}</span>
      </span>
      <details class="past-details">
        <summary>Details</summary>
        <div class="past-details-body">
          <div>{{ commit.subject }}</div>
          <div class="muted">Version <code data-testid="past-hash">{{ commit.hash }}</code><template v-if="commit.path !== path"> · then {{ commit.path }}</template></div>
        </div>
      </details>
      <div class="toolbar-spacer" />
      <button v-if="!type.editor?.layout && mode !== 'compare'" type="button" :class="{ active: mode === 'source' }" @click="mode = mode === 'source' ? 'read' : 'source'">{{ mode === 'source' ? 'Rendered' : 'Source' }}</button>
      <button type="button" :class="{ active: mode === 'compare' }" :aria-pressed="mode === 'compare'" data-testid="compare-now" @click="compare">{{ mode === 'compare' ? 'Show this version' : 'Compare with now' }}</button>
      <button type="button" data-testid="restore-version" title="Make the document read as this version again" @click="emit('restore')">Restore this version…</button>
      <button type="button" class="primary" @click="emit('back')">Back to live</button>
    </div>
    <p v-if="compareError" class="banner warn">{{ compareError }}</p>
    <div class="editor-scroll">
      <div v-if="mode === 'compare' && comparison" class="compare" data-testid="compare">
        <p class="compare-summary muted">
          <template v-if="!comparison.changes">This version reads the same as the document now.</template>
          <template v-else>
            {{ comparison.changes }} part{{ comparison.changes === 1 ? '' : 's' }} differ.
            <span class="compare-key"><del>Only in this version</del> <ins>Only now</ins></span>
          </template>
        </p>
        <template v-for="(b, i) in comparison.blocks" :key="i">
          <p v-if="b.kind === 'folded'" class="compare-folded">{{ b.count }} unchanged part{{ b.count === 1 ? '' : 's' }}</p>
          <div v-else-if="b.kind === 'changed'" class="compare-block compare-changed" data-testid="compare-changed"><template v-for="(w, j) in b.words" :key="j"><del v-if="w.kind === 'removed'">{{ w.text }}</del><ins v-else-if="w.kind === 'added'">{{ w.text }}</ins><span v-else>{{ w.text }}</span></template></div>
          <div v-else :class="['compare-block', `compare-${b.kind}`]" :data-testid="`compare-${b.kind}`">{{ b.text }}</div>
        </template>
      </div>
      <ReadOnlyCode v-else-if="mode === 'source' && !type.editor?.layout" :text="text" />
      <ReadOnlyDoc v-else :text="text" :type="type" :path="path" :format-editor="formatEditor" />
    </div>
  </div>
</template>
