<script setup lang="ts">
// The Export panel (Preview's): the open document rendered to HTML by the host
// (where code runs), shown in a frame that runs nothing; and Word, PDF and HTML
// files to save. It renders when asked (Render, ⇧⌘R, Export… on the ⋯ menu, 0114), and, if chosen, each
// time the document is written to its file. A render that needs a tool this
// computer lacks (LaTeX, for a PDF) offers to download it, and renders again
// once it is there (decision 0045). A component (0089): the rendering is the
// host's, asked through the core.
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, useTemplateRef, watch } from 'vue';
import type { FeaturePanelContext, RenderFormat, RenderInfo, RenderState } from '@kuraa/feature-kit/client';
import { megabytes, outputName, previewDocument, saveFile, time } from './preview.js';
import { KEYS, S } from './strings.js';
import { exportAsked } from './exporting.js';

const props = defineProps<{ ctx: FeaturePanelContext }>();
const ctx = props.ctx;

/** The open document as the client follows it: its path, when it was last written to its file, edits not yet at the host. */
const doc = shallowRef(ctx.document());
const stopDocument = ctx.onDocument(() => {
  const next = ctx.document();
  const was = doc.value;
  if (next?.path !== was?.path || next?.writtenAt !== was?.writtenAt || next?.unsynced !== was?.unsynced) doc.value = next;
});
const path = computed(() => doc.value?.path ?? '');
const writtenAt = computed(() => doc.value?.writtenAt ?? null);
const unsynced = computed(() => doc.value?.unsynced ?? 0);

const LABELS = S.formats;
const ON_SAVE_KEY = 'kuraa:preview-on-save';

const info = shallowRef<RenderInfo | null>(null);
const html = ref<string | null>(null);
const error = shallowRef<unknown>(null);
const explained = computed(() => (error.value ? ctx.explain(error.value) : null));
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
let timer: ReturnType<typeof setTimeout> | undefined;
let toolTimer: ReturnType<typeof setTimeout> | undefined;
const stopTools = ctx.host.tools.onChanged(() => {
  if (fetching.value) void followTool();
});
onBeforeUnmount(() => {
  clearTimeout(timer);
  clearTimeout(toolTimer);
  stopDocument();
  stopTools();
  stopAsk();
  clearTimeout(exportTimer);
});

/** A tool being downloaded for a render: which, what it is doing, and the render to make once it is there. */
const fetching = shallowRef<{ tool: string; label: string; progress: string | null; format: RenderFormat; save: boolean } | null>(null);

async function download(needs: NonNullable<RenderState['needs']>, format: RenderFormat) {
  const save = toSave.has(format) || shown.value?.format === format && format !== 'html';
  fetching.value = { tool: needs.tool, label: needs.label, progress: null, format, save };
  error.value = null;
  try {
    await ctx.host.tools.download(needs.tool);
  } catch (e) {
    fetching.value = null;
    error.value = e;
    return;
  }
  await followTool();
}

/** Follow the download; render again once the tool is there. */
async function followTool() {
  clearTimeout(toolTimer);
  const f = fetching.value;
  if (!f) return;
  try {
    const t = (await ctx.host.tools.list()).tools.find((x) => x.id === f.tool);
    if (fetching.value !== f) return;
    if (t?.state === 'ready') {
      fetching.value = null;
      void render(f.format, f.save);
    } else if (!t || (t.state === 'absent' && t.error)) {
      fetching.value = null;
      error.value = new Error(S.downloadFailed(f.label, t?.error ?? ''));
    } else {
      fetching.value = { ...f, progress: t.progress };
      toolTimer = setTimeout(() => void followTool(), 700);
    }
  } catch (e) {
    fetching.value = null;
    error.value = e;
  }
}

const busy = computed(() => !!info.value?.renders.some((r) => r.state === 'rendering'));

async function loadPreview(p: string) {
  try {
    const text = await (await ctx.host.renders.output(p, 'html')).text();
    if (p === path.value) html.value = previewDocument(text);
  } catch {
    if (p === path.value) html.value = null;
  }
}

/** Ask the host how the document's renders stand; follow them while any is under way. */
async function refresh(first = false) {
  const p = path.value;
  const n = asked;
  clearTimeout(timer);
  try {
    const next = await ctx.host.renders.info(p);
    if (n !== asked || p !== path.value) return;
    const before = info.value;
    info.value = next;
    error.value = null;
    for (const r of next.renders) {
      const was = before?.renders.find((x) => x.format === r.format);
      const finished = r.state !== 'rendering' && (first || was?.state === 'rendering' || was?.finishedAt !== r.finishedAt);
      if (r.format === 'html' && r.state === 'done' && (first || finished)) void loadPreview(p);
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
  if (!unsynced.value) return Promise.resolve();
  return new Promise((resolve) => {
    const stop = watch(unsynced, (n) => {
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
    const state = await ctx.host.renders.render(path.value, format);
    if (!exportShown(format)) shown.value = state;
    if (state.state === 'failed') toSave.delete(format);
    await refresh();
  } catch (e) {
    error.value = e;
  }
}

/**
 * Whether a render for the page (HTML) is to leave the status to a format being exported: Export…
 * renders the page as it opens, and a PDF chosen a moment later, its progress and an offer of LaTeX,
 * is what was asked for (0114).
 */
function exportShown(format: RenderFormat): boolean {
  const s = shown.value;
  return format === 'html' && !!s && s.format !== 'html' && (toSave.size > 0 || s.state === 'rendering');
}

async function save(format: RenderFormat) {
  try {
    saveFile(await ctx.host.renders.output(path.value, format), outputName(path.value, format));
  } catch (e) {
    error.value = e;
  }
}

async function saveMadeFrom(format: RenderFormat) {
  try {
    const name = `${outputName(path.value, format).replace(/\.[^.]*$/, '')}-${format}-made-from.zip`;
    saveFile(await ctx.host.renders.madeFrom(path.value, format), name);
  } catch (e) {
    error.value = e;
  }
}

/** What the output shown was made from, when it says. */
const madeFrom = computed(() => (shown.value?.state === 'done' && !fetching.value ? shown.value.output?.madeFrom ?? null : null));
const unsaved = computed(() => (madeFrom.value ? madeFrom.value.uncommitted.length + (madeFrom.value.more ?? 0) : 0));

/** What is known of the open document's renders, asked again for each document opened. */
let known: Promise<void> = Promise.resolve();
watch(path, () => {
  asked++;
  fetching.value = null;
  info.value = null;
  html.value = null;
  shown.value = null;
  toSave.clear();
  known = refresh(true);
}, { immediate: true });
// Asked for (opened by ⇧⌘R or Export…, or asked again while open): render now, once what is there is known.
// Asked by Export… (0100, 0114): the formats to export as, marked and the first focused, as well.
const actions = useTemplateRef<HTMLElement>('actions');
const exporting = ref(false);
let exportTimer: ReturnType<typeof setTimeout> | undefined;
const stopAsk = ctx.onAsk(() => {
  const toExport = exportAsked();
  void known.then(() => render('html'));
  if (!toExport) return;
  void known.then(async () => {
    exporting.value = true;
    await nextTick();
    actions.value?.querySelector<HTMLButtonElement>('[data-export]:not(:disabled)')?.focus();
    clearTimeout(exportTimer);
    exportTimer = setTimeout(() => (exporting.value = false), 2500);
  });
});
watch(writtenAt, (at, before) => {
  if (onSave.value && at && at !== before && !busy.value) void render('html');
});

const status = computed(() => {
  const s = shown.value;
  if (fetching.value) return S.downloading(fetching.value.label, fetching.value.progress);
  if (!s) return null;
  if (s.state === 'rendering') return S.rendering(LABELS[s.format]!, s.progress);
  if (s.state === 'failed') return s.message;
  return S.done(s.message, time(s.finishedAt), s.by);
});
</script>

<template>
  <div class="render-panel" data-testid="preview-panel">
    <p v-if="info?.unavailable" class="banner warn" data-testid="render-unavailable">{{ info.unavailable }}</p>
    <div v-if="explained" class="banner warn" role="alert" data-testid="error">
      <span>{{ explained.text }}</span>
      <details v-if="explained.details" class="error-details">
        <summary>{{ S.details }}</summary>
        <pre>{{ explained.details }}</pre>
      </details>
    </div>
    <div v-if="info && info.formats.length" ref="actions" :class="['render-actions', { exporting }]">
      <button type="button" class="primary" :disabled="!!info.unavailable" :title="info.unavailable ?? S.renderTitle(ctx.keyLabel(KEYS.open))" data-testid="render-button" @click="render('html')">{{ S.render }}</button>
      <span class="muted">{{ S.saveAs }}</span>
      <button
        v-for="f in info.formats"
        :key="f"
        type="button"
        :disabled="!!info.unavailable"
        :title="info.unavailable ?? S.saveTitle(LABELS[f]!)"
        :data-testid="`save-${f}`"
        data-export
        @click="render(f, true)"
      >{{ LABELS[f] }}…</button>
      <label class="render-on-save"><input v-model="onSave" type="checkbox" :disabled="!!info.unavailable" data-testid="render-on-save"> {{ S.onSave }}</label>
    </div>
    <p v-else-if="info" class="muted pad">{{ S.cannot }}</p>
    <div v-if="status" :class="['render-status', fetching ? 'rendering' : shown?.state]" data-testid="render-status" role="status">
      {{ status }}
      <div v-if="shown?.state === 'failed' && shown.needs && !fetching" class="render-needs">
        <button type="button" class="primary" data-testid="render-download-tool" @click="download(shown.needs, shown.format)">{{ S.download(shown.needs.label, megabytes(shown.needs.downloadBytes)) }}</button>
      </div>
      <div v-if="madeFrom && shown" class="render-made-from">
        <button type="button" :title="S.madeFromTitle" data-testid="render-made-from" @click="saveMadeFrom(shown.format)">{{ S.madeFrom }}</button>
        <span v-if="unsaved" class="muted" data-testid="render-made-from-unsaved"> {{ S.madeFromUnsaved(unsaved) }}</span>
      </div>
      <details v-if="shown?.log && shown.state !== 'rendering'" class="render-log">
        <summary>{{ S.details }}</summary>
        <pre data-testid="render-log">{{ shown.log }}</pre>
      </details>
    </div>
    <iframe
      v-if="html"
      class="render-frame"
      sandbox=""
      referrerpolicy="no-referrer"
      :title="S.frame"
      data-testid="render-frame"
      :srcdoc="html"
    />
    <p v-else-if="info?.formats.length && !busy && !info.unavailable" class="muted pad">{{ S.nothingYet }}</p>
  </div>
</template>

<style>
.render-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.render-needs { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 6px; }
.render-made-from { margin-top: 6px; }
.render-made-from button { font-size: inherit; }
.render-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--border); }
.render-actions .muted { margin-left: 6px; font-size: 12px; }
.render-actions [data-export] { transition: box-shadow 0.3s; }
.render-actions.exporting [data-export]:not(:disabled) { box-shadow: 0 0 0 2px var(--accent-soft, rgba(46, 107, 90, 0.25)); }
.render-on-save { display: flex; align-items: center; gap: 4px; font-size: 12px; color: var(--muted); margin-left: auto; }
.render-status { padding: 7px 12px; font-size: 13px; border-bottom: 1px solid var(--border); }
.render-status.failed { background: var(--warn-soft); color: var(--warn); }
.render-log summary { cursor: pointer; margin-top: 4px; color: var(--muted); }
.render-log pre { max-height: 260px; overflow: auto; font: 11px/1.4 var(--mono); white-space: pre-wrap; color: var(--text); background: var(--surface); padding: 6px; border: 1px solid var(--border); border-radius: 4px; }
.render-frame { flex: 1; width: 100%; border: 0; background: #fff; min-height: 0; }
</style>
