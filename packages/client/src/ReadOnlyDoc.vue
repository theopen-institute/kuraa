<script setup lang="ts">
// A document rendered by its type, not editable.
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import type { FormatEditor } from '@kuraa/editor-kit';
import { EditorState, type Plugin } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorView } from 'prosemirror-view';
import { highlightPlugin } from './lines.js';
import { editorContext, nodeViewsFor } from './editing.js';

const props = defineProps<{
  text: string;
  type: DocumentType;
  path: string;
  formatEditor?: FormatEditor;
  /** What features show on it (0082: a past version, with what was kept beside it then): their plugins, and how to let go of them. */
  extend?: (doc: PMNode) => { plugins: Plugin[]; destroy(): void };
}>();
const mount = useTemplateRef<HTMLDivElement>('mount');
let view: EditorView | null = null;
let extended: { destroy(): void } | null = null;

function render() {
  view?.destroy();
  extended?.destroy();
  extended = null;
  const { type, text, path, formatEditor } = props;
  const layout = type.editor?.layout;
  const ctx = editorContext(type);
  const doc = type.parse(text).doc;
  const extra = props.extend?.(doc) ?? null;
  extended = extra;
  view = new EditorView(mount.value!, {
    state: EditorState.create({ doc, plugins: [...(extra?.plugins ?? []), ...(layout ? [highlightPlugin(layout, path)] : (formatEditor?.plugins?.(ctx) ?? []))] }),
    editable: () => false,
    nodeViews: nodeViewsFor(type, ctx, formatEditor),
    attributes: { class: layout ? 'lines-doc' : 'prose' },
  });
}

onMounted(render);
watch([() => props.text, () => props.type, () => props.path, () => props.formatEditor, () => props.extend], render);
onBeforeUnmount(() => {
  view?.destroy();
  extended?.destroy();
});
</script>

<template>
  <div ref="mount" :class="type.editor?.layout ? 'editor-mount editor-mount-lines' : 'editor-mount'" />
</template>
