<script setup lang="ts">
// Components: the languages that run code (engines) and where it runs
// (environments), which document formats are on, and, for you alone, each
// format's editing behaviour. The host's components are set by whoever runs it,
// with flags; here they are only shown.
import { computed, ref, shallowRef } from 'vue';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { HostApi, ComponentsInfo } from './api.js';
import { onEscape } from './vue.js';

const props = defineProps<{
  api: HostApi;
  /** Every editor module, by type id, and the ones this person has turned off. */
  editors: Record<string, FormatEditor>;
  editorsOff: string[];
}>();
const emit = defineEmits<{ close: []; editorsOff: [ids: string[]] }>();

const info = shallowRef<ComponentsInfo | null>(null);
const error = ref<string | null>(null);
const title = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
/** An environment's name, without a '(not sandboxed)' its label may carry: that is shown apart. */
const envName = (label: string) => title(label.replace(/\s*\(not sandboxed\)\s*$/i, ''));
const modules = computed(() => Object.entries(props.editors).map(([id, m]) => ({ id, label: m.label ?? id, description: m.description ?? '' })));

props.api.components().then(
  (p) => {
    info.value = p;
  },
  (e: Error) => {
    error.value = e.message;
  },
);

const checked = (e: Event) => (e.target as HTMLInputElement).checked;

function toggleEditor(id: string, on: boolean) {
  emit('editorsOff', on ? props.editorsOff.filter((x) => x !== id) : [...props.editorsOff, id]);
}

onEscape(() => emit('close'));
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <div class="modal components" role="dialog" aria-label="Components" data-testid="components">
      <h2>Components</h2>
      <p v-if="error" class="components-error" role="alert">{{ error }}</p>
      <p v-if="!info && !error" class="muted">Loading…</p>
      <template v-if="info">
        <p class="muted components-note">
          What runs code, and which formats are on, are set by whoever runs this host, when they start it
          (<code>--engine</code>, <code>--env</code>, <code>--format</code>, <code>--component</code>).
        </p>

        <section class="components-group" data-testid="components-run">
          <h3>Running code</h3>
          <label v-for="e in info.engines" :key="e.id" class="component">
            <input type="checkbox" :checked="e.on" disabled :aria-label="e.label">
            <span class="component-text">
              <span class="component-name">{{ e.label }}</span>
              <span class="component-about">{{ e.description }}</span>
            </span>
          </label>
          <h4>Where code runs</h4>
          <label v-for="e in info.environments" :key="e.id" class="component" :data-testid="`environment:${e.id}`">
            <input type="checkbox" :checked="e.on" disabled :aria-label="envName(e.label)">
            <span class="component-text">
              <span class="component-name">{{ envName(e.label) }}<span v-if="!e.sandboxed" class="component-warn"> · not sandboxed</span></span>
              <span class="component-about">{{ e.description }}</span>
              <span v-if="e.on && !e.available" class="component-about component-unavailable">Not available: {{ e.message }}</span>
            </span>
          </label>
          <p v-if="!info.environments.length" class="muted components-note">No environment is loaded, so no code runs here.</p>
        </section>

        <section class="components-group" data-testid="components-formats">
          <h3>Document formats</h3>
          <label v-for="t in info.formats" :key="t.id" class="component">
            <input type="checkbox" :checked="t.on" disabled :aria-label="t.label">
            <span class="component-text">
              <span class="component-name">{{ t.label }}</span>
              <span class="component-about">{{ t.description || `${t.extensions.join(', ')} files` }}</span>
            </span>
          </label>
          <p class="muted components-note">A file whose format is off opens as a Text file, while that is on.</p>
        </section>
      </template>

      <section v-if="modules.length" class="components-group" data-testid="components-editing">
        <h3>Editing · just you</h3>
        <label v-for="m in modules" :key="m.id" class="component">
          <input type="checkbox" :checked="!editorsOff.includes(m.id)" :aria-label="m.label" @change="toggleEditor(m.id, checked($event))">
          <span class="component-text">
            <span class="component-name">{{ m.label }}</span>
            <span class="component-about">{{ m.description }}</span>
          </span>
        </label>
      </section>

      <div class="modal-actions"><button type="button" @click="emit('close')">Close</button></div>
    </div>
  </div>
</template>
