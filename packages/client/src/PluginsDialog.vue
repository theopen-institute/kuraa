<script setup lang="ts">
// Plugins: what runs code and where, which document formats are on, and (for
// you alone) each format's editing behaviour. The host's plugins can be changed
// only where the host is yours (the desktop app, `pnpm dev`); elsewhere they show
// as they are.
import { computed, ref, shallowRef, triggerRef } from 'vue';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { HostApi, PluginChange, PluginsInfo } from './api.js';
import { onEscape } from './vue.js';

const props = defineProps<{
  api: HostApi;
  /** Every editor module, by type id, and the ones this person has turned off. */
  editors: Record<string, FormatEditor>;
  editorsOff: string[];
}>();
const emit = defineEmits<{ close: []; changed: []; editorsOff: [ids: string[]] }>();

const info = shallowRef<PluginsInfo | null>(null);
const busy = ref(false);
const error = ref<string | null>(null);
const locked = computed(() => !info.value?.canChange || busy.value);
const environmentsOn = computed(() => info.value?.environments.filter((e) => e.on).length ?? 0);
const modules = computed(() => Object.entries(props.editors).map(([id, m]) => ({ id, label: m.label ?? id, description: m.description ?? '' })));
const title = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
/** An environment's name, without the '(not sandboxed)' its label may carry: that is shown apart. */
const envName = (label: string) => title(label.replace(/\s*\(not sandboxed\)\s*$/i, ''));

props.api.plugins().then(
  (p) => {
    info.value = p;
  },
  (e: Error) => {
    error.value = e.message;
  },
);

async function change(c: PluginChange) {
  busy.value = true;
  error.value = null;
  try {
    info.value = await props.api.setPlugins(c);
    emit('changed');
  } catch (e) {
    error.value = (e as Error).message;
    triggerRef(info); // put the boxes back as they were
  } finally {
    busy.value = false;
  }
}

const checked = (e: Event) => (e.target as HTMLInputElement).checked;

function toggleEditor(id: string, on: boolean) {
  emit('editorsOff', on ? props.editorsOff.filter((x) => x !== id) : [...props.editorsOff, id]);
}

const close = () => {
  if (!busy.value) emit('close');
};
onEscape(close);
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="close">
    <div class="modal plugins" role="dialog" aria-label="Plugins" data-testid="plugins">
      <h2>Plugins</h2>
      <p v-if="error" class="plugins-error" role="alert">{{ error }}</p>
      <p v-if="!info && !error" class="muted">Loading…</p>
      <template v-if="info">
        <p class="muted plugins-note">
          <template v-if="info.canChange">Running code and formats are set for this computer, in every workspace you open.</template>
          <template v-else>Running code and formats are set by whoever runs this host. Your editing choices are yours.</template>
        </p>

        <section class="plugins-group" data-testid="plugins-run">
          <h3>Running code</h3>
          <label v-for="e in info.engines" :key="e.id" class="plugin">
            <input type="checkbox" :checked="e.on" :disabled="locked" :aria-label="e.label" @change="change({ engines: { [e.id]: checked($event) } })">
            <span class="plugin-text">
              <span class="plugin-name">{{ e.label }}</span>
              <span class="plugin-about">{{ e.description }}</span>
            </span>
          </label>
          <h4>Where code runs</h4>
          <div v-for="e in info.environments" :key="e.id" class="plugin">
            <input
              :id="`env-${e.id}`"
              type="checkbox"
              :checked="e.on"
              :disabled="locked"
              :aria-label="envName(e.label)"
              @change="change({ environments: { [e.id]: checked($event) } })"
            >
            <label :for="`env-${e.id}`" class="plugin-text">
              <span class="plugin-name">{{ envName(e.label) }}<span v-if="!e.sandboxed" class="plugin-warn"> · not sandboxed</span></span>
              <span class="plugin-about">{{ e.description }}</span>
              <span v-if="e.on && !e.available" class="plugin-about plugin-unavailable">Not available: {{ e.message }}</span>
            </label>
            <label v-if="e.on && environmentsOn > 1" class="plugin-default">
              <input type="radio" name="default-environment" :checked="e.default" :disabled="locked" :aria-label="`Default: ${envName(e.label)}`" @change="change({ defaultEnvironment: e.id })">
              Default
            </label>
          </div>
        </section>

        <section class="plugins-group" data-testid="plugins-formats">
          <h3>Document formats</h3>
          <label v-for="t in info.formats" :key="t.id" class="plugin">
            <input type="checkbox" :checked="t.on" :disabled="locked" :aria-label="t.label" @change="change({ formats: { [t.id]: checked($event) } })">
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

      <div class="modal-actions"><button type="button" :disabled="busy" @click="emit('close')">Close</button></div>
    </div>
  </div>
</template>
