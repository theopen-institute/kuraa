<script setup lang="ts">
// The Preview panel: the open document rendered to HTML by the host (where code
// runs), shown in a frame that runs nothing; and Word, PDF and HTML files to
// save. It renders when asked (Render, ⇧⌘R), and, if chosen, each time the
// document is written to its file.
import { computed, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from 'vue';
import type { HostApi, RenderFormat, RenderInfo, RenderState } from './api.js';
import { outputName, previewDocument, saveFile } from './preview.js';
import { time } from './labels.js';
import { APP_KEYS, keyLabel } from './keys.js';
import { S } from './strings.js';
import { useReturnFocus } from './vue.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{
  api: HostApi;
  path: string;
  by: { name: string; email: string; color: string };
  /** Goes up each time a render is asked for from outside (the menu, ⇧⌘R). */
  trigger: number;
  /** When the document was last written to its file: with "update on save", a render follows. */
  writtenAt: string | null;
  /** Edits made here that have not reached the host yet: a render waits for them (briefly). */
  unsynced: number;
}>();
const emit = defineEmits<{ close: [] }>();

const LABELS = S.render.formats;
const root = useTemplateRef<HTMLElement>('root');
useReturnFocus(root);
const ON_SAVE_KEY = 'kuraa:preview-on-save';

const info = shallowRef<RenderInfo | null>(null);
const html = ref<string | null>(null);
const error = shallowRef<unknown>(null);
/** The render whose progress and outcome are shown. */
const shown = shallowRef<RenderState | null>(null);
/** Formats being rendered to be saved once done. */
const toSave = new Set<RenderFormat>();
const onSave = ref(false);
try { onSave.value = localStorage.getItem(ON_SAVE_KEY) === '1'; } catch { /* storage unavailable */ }
watch(onSave, (v) => {
  try { localStorage.setItem(ON_SAVE_KEY, v ? '1' : '0'); } catch { /* storage unavailable */ }
});

let asked = 0;
let opened = false;
let timer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(timer));

const busy = computed(() => !!info.value?.renders.some((r) => r.state === 'rendering'));

async function loadPreview(path: string) {
  try {
    const text = await (await props.api.renderOutput(path, 'html')).text();
    if (path === props.path) html.value = previewDocument(text);
  } catch {
    if (path === props.path) html.value = null;
  }
}

/** Ask the host how the document's renders stand; follow them while any is under way. */
async function refresh(first = false) {
  const path = props.path;
  const n = asked;
  clearTimeout(timer);
  try {
    const next = await props.api.renders(path);
    if (n !== asked || path !== props.path) return;
    const before = info.value;
    info.value = next;
    error.value = null;
    for (const r of next.renders) {
      const was = before?.renders.find((x) => x.format === r.format);
      const finished = r.state !== 'rendering' && (first || was?.state === 'rendering' || was?.finishedAt !== r.finishedAt);
      if (r.format === 'html' && r.state === 'done' && (first || finished)) void loadPreview(path);
      if (finished && !first && toSave.has(r.format)) {
        toSave.delete(r.format);
        if (r.state === 'done') void save(r.format);
      }
      if (shown.value?.format === r.format) shown.value = r;
    }
    if (first && !shown.value) shown.value = next.renders.find((r) => r.format === 'html') ?? null;
    if (next.renders.some((r) => r.state === 'rendering')) timer = setTimeout(() => void refresh(), 700);
  } catch (e) {
    if (n === asked) error.value = e;
  }
}

/** Until what was typed here has reached the host (at most a few seconds): it renders the document as the host has it. */
function synced(ms = 3000): Promise<void> {
  if (!props.unsynced) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(() => props.unsynced, (n) => {
      if (n) return;
      stop();
      clearTimeout(t);
      resolve();
    });
    const t = setTimeout(() => {
      stop();
      resolve();
    }, ms);
  });
}

async function render(format: RenderFormat, thenSave = false) {
  if (thenSave) toSave.add(format);
  try {
    await synced();
    const state = await props.api.render(props.path, format, props.by);
    shown.value = state;
    if (state.state === 'failed') toSave.delete(format);
    await refresh();
  } catch (e) {
    error.value = e;
  }
}

async function save(format: RenderFormat) {
  try {
    saveFile(await props.api.renderOutput(props.path, format), outputName(props.path, format));
  } catch (e) {
    error.value = e;
  }
}

watch(() => props.path, () => {
  asked++;
  info.value = null;
  html.value = null;
  shown.value = null;
  toSave.clear();
  const opening = !opened;
  opened = true;
  // Opened by asking for a render (the menu, ⇧⌘R): render now, once what is there is known.
  void refresh(true).then(() => {
    if (opening && props.trigger) void render('html');
  });
}, { immediate: true });
watch(() => props.trigger, () => void render('html'));
watch(() => props.writtenAt, (at, before) => {
  if (onSave.value && at && at !== before && !busy.value) void render('html');
});

const status = computed(() => {
  const s = shown.value;
  if (!s) return null;
  if (s.state === 'rendering') return S.render.rendering(LABELS[s.format]!, s.progress);
  if (s.state === 'failed') return s.message;
  return S.render.done(s.message, time(s.finishedAt), s.by);
});
</script>

<template>
  <aside ref="root" class="pane pane-right side-panel render-panel" :aria-label="S.render.title" data-testid="preview-panel" @keydown.esc="emit('close')">
    <div class="pane-header">
      <span>{{ S.render.title }}</span>
      <div class="pane-header-actions">
        <button type="button" :title="S.render.close" :aria-label="S.render.close" @click="emit('close')">×</button>
      </div>
    </div>
    <p v-if="info?.unavailable" class="banner warn" data-testid="render-unavailable">{{ info.unavailable }}</p>
    <ErrorBanner v-if="error" :error="error" />
    <div v-if="info && info.formats.length" class="render-actions">
      <button type="button" class="primary" :disabled="!!info.unavailable" :title="info.unavailable ?? S.render.renderTitle(keyLabel(APP_KEYS.preview))" data-testid="render-button" @click="render('html')">{{ S.render.render }}</button>
      <span class="muted">{{ S.render.saveAs }}</span>
      <button
        v-for="f in info.formats"
        :key="f"
        type="button"
        :disabled="!!info.unavailable"
        :title="info.unavailable ?? S.render.saveTitle(LABELS[f]!)"
        :data-testid="`save-${f}`"
        @click="render(f, true)"
      >{{ LABELS[f] }}…</button>
      <label class="render-on-save"><input v-model="onSave" type="checkbox" :disabled="!!info.unavailable" data-testid="render-on-save"> {{ S.render.onSave }}</label>
    </div>
    <p v-else-if="info" class="muted pad">{{ S.render.cannot }}</p>
    <div v-if="status" :class="['render-status', shown?.state]" data-testid="render-status" role="status">
      {{ status }}
      <details v-if="shown?.log && shown.state !== 'rendering'" class="render-log">
        <summary>{{ S.common.details }}</summary>
        <pre data-testid="render-log">{{ shown.log }}</pre>
      </details>
    </div>
    <iframe
      v-if="html"
      class="render-frame"
      sandbox=""
      referrerpolicy="no-referrer"
      :title="S.render.frame"
      data-testid="render-frame"
      :srcdoc="html"
    />
    <p v-else-if="info?.formats.length && !busy && !info.unavailable" class="muted pad">{{ S.render.nothingYet }}</p>
  </aside>
</template>
