<script setup lang="ts">
// A past version of the open file, from its history: read only, rendered by its
// type or (for a document) shown as its source.
import { ref } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { CommitInfo } from './api.js';
import ReadOnlyCode from './ReadOnlyCode.vue';
import ReadOnlyDoc from './ReadOnlyDoc.vue';

defineProps<{
  commit: CommitInfo;
  /** The file's text in that commit. */
  text: string;
  type: DocumentType;
  /** The file's path in that commit. */
  path: string;
  formatEditor?: FormatEditor;
}>();
const emit = defineEmits<{ back: [] }>();

const source = ref(false);
</script>

<template>
  <div class="editor-pane past-version" data-testid="past-version">
    <div class="toolbar">
      <span>
        Version <code>{{ commit.hash.slice(0, 7) }}</code>, “{{ commit.subject }}” ({{ new Date(commit.date).toLocaleString() }}). Read only.
      </span>
      <div class="toolbar-spacer" />
      <button v-if="!type.editor?.layout" type="button" :class="{ active: source }" @click="source = !source">{{ source ? 'Rendered' : 'Source' }}</button>
      <button type="button" class="primary" @click="emit('back')">Back to live</button>
    </div>
    <div class="editor-scroll">
      <ReadOnlyCode v-if="source && !type.editor?.layout" :text="text" />
      <ReadOnlyDoc v-else :text="text" :type="type" :path="path" :format-editor="formatEditor" />
    </div>
  </div>
</template>
