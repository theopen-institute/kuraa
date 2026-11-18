<script setup lang="ts">
// Plugins: the languages that run code (engines) and where it runs
// (environments), which document formats are on, and, for you alone, each
// format's editing behaviour. The host's plugins are set by whoever runs it,
// with flags; here they are only shown.
import { computed, ref, shallowRef } from 'vue';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { HostApi, PluginsInfo } from './api.js';
import { onEscape } from './vue.js';

const props = defineProps<{
  api: HostApi;
  /** Every editor module, by type id, and the ones this person has turned off. */
  editors: Record<string, FormatEditor>;
  editorsOff: string[];
}>();
const emit = defineEmits<{ close: []; editorsOff: [ids: string[]] }>();

const info = shallowRef<PluginsInfo | null>(null);
const error = ref<string | null>(null);
const title = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
/** An environment's name, without a '(not sandboxed)' its label may carry: that is shown apart. */
const envName = (label: string) => title(label.replace(/\s*\(not sandboxed\)\s*$/i, ''));
const modules = computed(() => Object.entries(props.editors).map(([id, m]) => ({ id, label: m.label ?? id, description: m.description ?? '' })));

props.api.plugins().then(
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
    <div class="modal plugins" role="dialog" aria-label="Plugins" data-testid="plugins">
      <h2>Plugins</h2>
      <p v-if="error" class="plugins-error" role="alert">{{ error }}</p>
      <p v-if="!info && !error" class="muted">Loading…</p>
      <template v-if="info">
        <p class="muted plugins-note">
          What runs code, and which formats are on, are set by whoever runs this host, when they start it
          (<code>--engine</code>, <code>--env</code>, <code>--format</code>, <code>--plugin</code>).
        </p>

        <section class="plugins-group" data-testid="plugins-run">
          <h3>Running code</h3>
          <label v-for="e in info.engines" :key="e.id" class="plugin">
            <input type="checkbox" :checked="e.on" disabled :aria-label="e.label">
            <span class="plugin-text">
              <span class="plugin-name">{{ e.label }}</span>
              <span class="plugin-about">{{ e.description }}</span>
            </span>
          </label>
          <h4>Where code runs</h4>
          <label v-for="e in info.environments" :key="e.id" class="plugin" :data-testid="`environment:${e.id}`">
            <input type="checkbox" :checked="e.on" disabled :aria-label="envName(e.label)">
            <span class="plugin-text">
              <span class="plugin-name">{{ envName(e.label) }}<span v-if="!e.sandboxed" class="plugin-warn"> · not sandboxed</span></span>
              <span class="plugin-about">{{ e.description }}</span>
              <span v-if="e.on && !e.available" class="plugin-about plugin-unavailable">Not available: {{ e.message }}</span>
            </span>
          </label>
          <p v-if="!info.environments.length" class="muted plugins-note">No environment is loaded, so no code runs here.</p>
        </section>

        <section class="plugins-group" data-testid="plugins-formats">
          <h3>Document formats</h3>
          <label v-for="t in info.formats" :key="t.id" class="plugin">
            <input type="checkbox" :checked="t.on" disabled :aria-label="t.label">
            <span class="plugin-text">
              <span class="plugin-name">{{ t.label }}</span>
              <span class="plugin-about">{{ t.description || `${t.extensions.join(', ')} files` }}</span>
            </span>
          </label>
          <p class="muted plugins-note">A file whose format is off opens as a Text file, while that is on.</p>
        </section>
      </template>

      <section v-if="modules.length" class="plugins-group" data-testid="plugins-editing">
        <h3>Editing · just you</h3>
        <label v-for="m in modules" :key="m.id" class="plugin">
          <input type="checkbox" :checked="!editorsOff.includes(m.id)" :aria-label="m.label" @change="toggleEditor(m.id, checked($event))">
          <span class="plugin-text">
            <span class="plugin-name">{{ m.label }}</span>
            <span class="plugin-about">{{ m.description }}</span>
          </span>
        </label>
      </section>

      <div class="modal-actions"><button type="button" @click="emit('close')">Close</button></div>
    </div>
  </div>
</template>
