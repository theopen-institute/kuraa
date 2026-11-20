<script setup lang="ts">
// Components: the languages that run code (engines) and where it runs
// (environments), which document formats are on, and, for you alone, each
// format's editing behaviour. The host's components are set by whoever runs it,
// with flags; here they are only shown. Tools (TeX, decision 0045) are the
// exception: where the host allows installs, people download and remove them.
import { computed, onBeforeUnmount, shallowRef, useTemplateRef, watch } from 'vue';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { HostApi, ComponentsInfo, ToolInfo, ToolsInfo } from './api.js';
import { megabytes } from './labels.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{
  api: HostApi;
  /** Every editor module, by type id, and the ones this person has turned off. */
  editors: Record<string, FormatEditor>;
  editorsOff: string[];
  /** Goes up when the host says a tool changed. */
  toolsKey?: number;
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

const tools = shallowRef<ToolsInfo | null>(null);
const toolError = shallowRef<unknown>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(timer));
const busy = (t: ToolInfo) => t.state === 'downloading' || t.state === 'adding' || t.state === 'removing';

/** How the tools stand; followed while one is being downloaded or removed. */
async function loadTools() {
  clearTimeout(timer);
  try {
    tools.value = await props.api.tools();
    if (tools.value.tools.some(busy)) timer = setTimeout(() => void loadTools(), 700);
  } catch (e) {
    toolError.value = e;
  }
}
void loadTools();
watch(() => props.toolsKey, () => void loadTools());

async function toolAction(t: ToolInfo, action: 'download' | 'remove') {
  toolError.value = null;
  try {
    await (action === 'download' ? props.api.downloadTool(t.id) : props.api.removeTool(t.id));
  } catch (e) {
    toolError.value = e;
  }
  await loadTools();
}

const toolStatus = (t: ToolInfo) => {
  if (busy(t)) return t.progress ?? S.components.toolBusy[t.state]!;
  if (t.state === 'ready') return S.components.toolReady(megabytes(t.size ?? 0)) + (t.parts ? S.components.toolParts(t.parts.added, t.parts.label) : '');
  return S.components.toolSize(megabytes(t.downloadBytes));
};

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

      <section v-if="tools?.tools.length" class="components-group" data-testid="components-tools">
        <h3>{{ S.components.tools }}</h3>
        <p class="muted components-note">{{ S.components.toolsAbout }}</p>
        <ErrorBanner v-if="toolError" :error="toolError" inline />
        <div v-for="t in tools.tools" :key="t.id" class="component tool" :data-testid="`tool:${t.id}`">
          <span class="component-text">
            <span class="component-name">{{ t.label }}</span>
            <span class="component-about">{{ t.description }}</span>
            <span class="component-about" role="status" :data-testid="`tool-status:${t.id}`">{{ toolStatus(t) }}</span>
            <span v-if="t.unavailable" class="component-about component-unavailable">{{ t.unavailable }}</span>
            <span v-else-if="t.note" class="component-about">{{ t.note }}</span>
            <span v-if="t.error && !busy(t)" class="component-about component-unavailable">{{ S.components.failed(t.error) }}</span>
          </span>
          <span v-if="tools.allowInstalls" class="tool-actions">
            <button
              v-if="t.state === 'absent' || t.state === 'downloading'"
              type="button"
              :disabled="busy(t) || !!t.unavailable"
              :title="S.components.downloadTitle(t.label, megabytes(t.downloadBytes))"
              :data-testid="`tool-download:${t.id}`"
              @click="toolAction(t, 'download')"
            >{{ S.components.download }}</button>
            <button
              v-else
              type="button"
              :disabled="busy(t)"
              :title="S.components.removeTitle(t.label)"
              :data-testid="`tool-remove:${t.id}`"
              @click="toolAction(t, 'remove')"
            >{{ S.components.remove }}</button>
          </span>
        </div>
        <p v-if="!tools.allowInstalls" class="muted components-note">{{ S.components.toolsOff }}</p>
      </section>

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
