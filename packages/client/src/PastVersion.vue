<script setup lang="ts">
// A past version of the open file, from its history: read only, rendered by its
// type or (for a document) shown as its source; compared with the document as
// it is now; or restored, as an edit to the live document (everyone with it open
// sees it, it can be undone, and it is saved like any edit). The copy of an
// outside edit the host kept beside the file (decision 0037) is shown the same
// way, to read, compare with now, or take.
import { computed, onMounted, ref } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { CommitInfo } from './api.js';
import { blocksFrom, compareTexts, type Comparison } from './compare.js';
import { peopleOf } from './history.js';
import { S } from './strings.js';
import ReadOnlyCode from './ReadOnlyCode.vue';
import type { Node as PMNode } from 'prosemirror-model';
import type { Plugin } from 'prosemirror-state';
import ReadOnlyDoc from './ReadOnlyDoc.vue';

const props = defineProps<{
  /** The version from the history; null for an outside edit's copy. */
  commit: CommitInfo | null;
  /** The path of the outside edit's copy shown, if that is what this is. */
  outside?: string;
  /** Open comparing with now (Compare on an outside edit's note). */
  startComparing?: boolean;
  /** The file's text in that version. */
  text: string;
  type: DocumentType;
  /** The file's path in that commit. */
  path: string;
  formatEditor?: FormatEditor;
  /** The document's text as it is now, in the live editor (null if it is not open). */
  now?: () => string | null;
  /** Whether this person may make the document read as this version (false: they may not change it, 0066). */
  canRestore?: boolean;
  /** What features show on it, with what was kept beside it then (0082). */
  extend?: (doc: PMNode) => { plugins: Plugin[]; destroy(): void };
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
    compareError.value = S.past.notOpen;
    return;
  }
  comparison.value = compareTexts(props.text, now, blocksFrom((t) => props.type.parse(t)));
  compareError.value = null;
  mode.value = 'compare';
}

const date = computed(() => (props.commit ? S.versions.date(props.commit.date) : null));
const people = computed(() => (props.commit ? peopleOf([props.commit]) : ''));
const outsideName = computed(() => props.outside?.slice(props.outside.lastIndexOf('/') + 1) ?? '');
onMounted(() => {
  if (props.startComparing) compare();
});
</script>

<template>
  <div class="editor-pane past-version" data-testid="past-version">
    <div class="toolbar">
      <span class="past-label">
        <template v-if="commit"><strong data-testid="past-date">{{ date }}</strong> · {{ people }}</template>
        <strong v-else data-testid="past-outside">{{ S.outside.title(outsideName) }}</strong>
        <span class="muted"> {{ mode === 'compare' ? S.past.comparedWithNow : S.past.readOnly }}</span>
      </span>
      <details v-if="commit" class="past-details">
        <summary>{{ S.common.details }}</summary>
        <div class="past-details-body">
          <div>{{ commit.subject }}</div>
          <div class="muted">{{ S.past.version('') }}<code data-testid="past-hash">{{ commit.hash }}</code><template v-if="commit.path !== path">{{ S.past.then(commit.path) }}</template></div>
        </div>
      </details>
      <div class="toolbar-spacer" />
      <button v-if="!type.editor?.layout && mode !== 'compare'" type="button" :class="{ active: mode === 'source' }" @click="mode = mode === 'source' ? 'read' : 'source'">{{ mode === 'source' ? S.past.rendered : S.past.source }}</button>
      <button type="button" :class="{ active: mode === 'compare' }" :aria-pressed="mode === 'compare'" data-testid="compare-now" @click="compare">{{ mode === 'compare' ? S.past.showVersion : S.past.compare }}</button>
      <button v-if="canRestore !== false" type="button" data-testid="restore-version" :title="S.past.restoreTitle" @click="emit('restore')">{{ commit ? S.past.restore : `${S.versions.useOutside}…` }}</button>
      <button type="button" class="primary" @click="emit('back')">{{ S.past.back }}</button>
    </div>
    <p v-if="compareError" class="banner warn">{{ compareError }}</p>
    <p v-if="commit?.kind === 'not-kept'" class="banner info" data-testid="not-kept">{{ S.past.notKept }}</p>
    <div class="editor-scroll">
      <div v-if="mode === 'compare' && comparison" class="compare" data-testid="compare">
        <p class="compare-summary muted">
          <template v-if="!comparison.changes">{{ S.past.same }}</template>
          <template v-else>
            {{ S.past.differ(comparison.changes) }}
            <span class="compare-key"><del>{{ S.past.onlyThen }}</del> <ins>{{ S.past.onlyNow }}</ins></span>
          </template>
        </p>
        <template v-for="(b, i) in comparison.blocks" :key="i">
          <p v-if="b.kind === 'folded'" class="compare-folded">{{ S.past.folded(b.count) }}</p>
          <div v-else-if="b.kind === 'changed'" class="compare-block compare-changed" data-testid="compare-changed"><template v-for="(w, j) in b.words" :key="j"><del v-if="w.kind === 'removed'">{{ w.text }}</del><ins v-else-if="w.kind === 'added'">{{ w.text }}</ins><span v-else>{{ w.text }}</span></template></div>
          <div v-else :class="['compare-block', `compare-${b.kind}`]" :data-testid="`compare-${b.kind}`">{{ b.text }}</div>
        </template>
      </div>
      <ReadOnlyCode v-else-if="mode === 'source' && !type.editor?.layout" :text="text" />
      <ReadOnlyDoc v-else :text="text" :type="type" :path="path" :format-editor="formatEditor" :extend="extend" />
    </div>
  </div>
</template>
