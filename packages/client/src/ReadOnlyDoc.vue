<script setup lang="ts">
// A document rendered by its type, not editable.
import { onBeforeUnmount, onMounted, useTemplateRef, watch } from 'vue';
import type { DocumentType } from '@kuraa/kernel';
import type { FormatEditor } from '@kuraa/editor-kit';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { highlightPlugin } from './lines.js';
import { editorContext, nodeViewsFor } from './editing.js';

const props = defineProps<{ text: string; type: DocumentType; path: string; formatEditor?: FormatEditor }>();
const mount = useTemplateRef<HTMLDivElement>('mount');
let view: EditorView | null = null;

function render() {
  view?.destroy();
  const { type, text, path, formatEditor } = props;
  const layout = type.editor?.layout;
  const ctx = editorContext(type);
  view = new EditorView(mount.value!, {
    state: EditorState.create({ doc: type.parse(text).doc, plugins: layout ? [highlightPlugin(layout, path)] : (formatEditor?.plugins?.(ctx) ?? []) }),
    editable: () => false,
    nodeViews: nodeViewsFor(type, ctx, formatEditor),
    attributes: { class: layout ? 'lines-doc' : 'prose' },
  });
}

onMounted(render);
watch([() => props.text, () => props.type, () => props.path, () => props.formatEditor], render);
onBeforeUnmount(() => view?.destroy());
</script>

<template>
  <div ref="mount" :class="type.editor?.layout ? 'editor-mount editor-mount-lines' : 'editor-mount'" />
</template>
