<script setup lang="ts">
// Settings › Document (decision 0064): the open document's own settings, saved
// in its file, for everyone who opens it: its header (a title, authors, a
// bibliography, …: HeaderForm), written as the window closes (commit), as one
// edit that can be undone (0063). With no document open, or one whose kind has
// no settings of its own, it says so.
import { useTemplateRef } from 'vue';
import type { HeaderSpec } from '@kuraa/editor-kit';
import type { EditorView } from 'prosemirror-view';
import { S } from './strings.js';
import HeaderForm from './HeaderForm.vue';

defineProps<{
  path: string | null;
  /** The open document's header, to edit, if its format has one: the live editor's view, and how the format reads it. */
  header: { view: EditorView; spec: HeaderSpec; version: number } | null;
  /** The document is still opening (its editor not ready yet). */
  opening: boolean;
}>();

const form = useTemplateRef<InstanceType<typeof HeaderForm>>('form');
/** Write what was changed, as the window closes: false to keep it open (HeaderForm.commit). */
const commit = async () => !form.value || form.value.commit();
/** Escape: out of adding a field, if it is adding one (true: it was). */
const escape = () => !!form.value?.escape();
defineExpose({ commit, escape });
</script>

<template>
  <div data-testid="settings-document">
    <section v-if="path && header" class="settings-part">
      <HeaderForm :key="path" ref="form" :view="header.view" :spec="header.spec" :path="path" :version="header.version" />
    </section>
    <p v-else-if="path && opening" class="muted">{{ S.common.loading }}</p>
    <p v-else class="pref-note settings-none" data-testid="settings-document-none">{{ path ? S.sections.documentNone : S.sections.noDocument }}</p>
  </div>
</template>
