<script setup lang="ts">
// Plain text in a read-only CodeMirror editor.
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue';
import { EditorState } from '@codemirror/state';
import { EditorView, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { highlighter } from './languages.js';

const props = defineProps<{ text: string; testId?: string }>();
const mount = useTemplateRef<HTMLDivElement>('mount');
let view: EditorView | null = null;

onMounted(() => {
  view = new EditorView({
    parent: mount.value!,
    state: EditorState.create({
      doc: props.text,
      extensions: [
        lineNumbers(),
        markdown(),
        syntaxHighlighting(highlighter),
        EditorView.lineWrapping,
        EditorState.readOnly.of(true),
        EditorView.editable.of(false),
      ],
    }),
  });
});

watch(() => props.text, (text) => {
  if (view && view.state.doc.toString() !== text) view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
});

onBeforeUnmount(() => view?.destroy());
</script>

<template>
  <div ref="mount" class="source-view" :data-testid="testId" />
</template>
