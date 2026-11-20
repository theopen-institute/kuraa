<script setup lang="ts">
// Components: the languages that run code (engines) and where it runs
// (environments), which document formats are on, and, for you alone, each
// format's editing behaviour. The host's components are set by whoever runs it,
// with flags; here they are only shown.
import { computed, shallowRef, useTemplateRef } from 'vue';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { HostApi, ComponentsInfo } from './api.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{
  api: HostApi;
  /** Every editor module, by type id, and the ones this person has turned off. */
  editors: Record<string, FormatEditor>;
  editorsOff: string[];
}>();
const emit = defineEmits<{ close: []; editorsOff: [ids: string[]] }>();

const info = shallowRef<ComponentsInfo | null>(null);
const error = shallowRef<unknown>(null);
const title = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
/** An environment's name, without a '(not sandboxed)' its label may carry: that is shown apart. */
const envName = (label: string) => title(label.replace(/\s*\(not sandboxed\)\s*$/i, ''));
const modules = computed(() => Object.entries(props.editors).map(([id, m]) => ({ id, label: m.label ?? id, description: m.description ?? '' })));

props.api.components().then(
  (p) => {
    info.value = p;
  },
  (e: unknown) => {
    error.value = e;
  },
);

const checked = (e: Event) => (e.target as HTMLInputElement).checked;

function toggleEditor(id: string, on: boolean) {
  emit('editorsOff', on ? props.editorsOff.filter((x) => x !== id) : [...props.editorsOff, id]);
}

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('close'));
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div ref="root" class="modal components" role="dialog" aria-modal="true" aria-labelledby="components-title" data-testid="components">
      <h2 id="components-title">{{ S.components.title }}</h2>
      <ErrorBanner v-if="error" :error="error" inline />
      <p v-if="!info && !error" class="muted">{{ S.common.loading }}</p>
      <template v-if="info">
        <p class="muted components-note">{{ S.components.setBy }}</p>
        <details class="components-note">
          <summary>{{ S.common.details }}</summary>
          <span class="muted">{{ S.components.flags }}</span>
        </details>

        <section class="components-group" data-testid="components-run">
          <h3>{{ S.components.running }}</h3>
          <label v-for="e in info.engines" :key="e.id" class="component">
            <input type="checkbox" :checked="e.on" disabled :aria-label="e.label">
            <span class="component-text">
              <span class="component-name">{{ e.label }}</span>
              <span class="component-about">{{ e.description }}</span>
            </span>
          </label>
          <h4>{{ S.components.where }}</h4>
          <label v-for="e in info.environments" :key="e.id" class="component" :data-testid="`environment:${e.id}`">
            <input type="checkbox" :checked="e.on" disabled :aria-label="envName(e.label)">
            <span class="component-text">
              <span class="component-name">{{ envName(e.label) }}<span v-if="!e.sandboxed" class="component-warn">{{ S.components.notSandboxed }}</span></span>
              <span class="component-about">{{ e.description }}</span>
              <span v-if="e.on && !e.available" class="component-about component-unavailable">{{ S.components.unavailable(e.message) }}</span>
            </span>
          </label>
          <p v-if="!info.environments.length" class="muted components-note">{{ S.components.noEnvironment }}</p>
        </section>

        <section class="components-group" data-testid="components-formats">
          <h3>{{ S.components.formats }}</h3>
          <label v-for="t in info.formats" :key="t.id" class="component">
            <input type="checkbox" :checked="t.on" disabled :aria-label="t.label">
            <span class="component-text">
              <span class="component-name">{{ t.label }}</span>
              <span class="component-about">{{ t.description || S.components.files(t.extensions.join(', ')) }}</span>
            </span>
          </label>
          <p class="muted components-note">{{ S.components.formatOff }}</p>
        </section>
      </template>

      <section v-if="modules.length" class="components-group" data-testid="components-editing">
        <h3>{{ S.components.editing }}</h3>
        <label v-for="m in modules" :key="m.id" class="component">
          <input type="checkbox" :checked="!editorsOff.includes(m.id)" :aria-label="m.label" @change="toggleEditor(m.id, checked($event))">
          <span class="component-text">
            <span class="component-name">{{ m.label }}</span>
            <span class="component-about">{{ m.description }}</span>
          </span>
        </label>
      </section>

      <div class="modal-actions"><button type="button" @click="emit('close')">{{ S.common.close }}</button></div>
    </div>
  </div>
</template>
