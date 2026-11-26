<script setup lang="ts">
// Compile's panel (0093): the folder chosen (Compile… on its menu), the book's
// title and format; Compile renders it through the host (its documents in the
// file tree's order, but those left out), follows it, and saves what it made.
// The title and format are kept for the folder, for next time.
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { FeaturePanelContext, RenderInfo, RenderState } from '@kuraa/feature-kit/client';
import { excludedPaths, FORMATS, noHeadingPaths, type CompileFormat } from './settings.js';
import { known, load, settingsOf, target } from './store.js';
import { S } from './strings.js';

const props = defineProps<{ ctx: FeaturePanelContext }>();
const ctx = props.ctx;

const folder = computed(() => target.value);
/** As the host's render takes it: ending in `/`, the top level `/`. */
const renderPath = computed(() => (folder.value === null ? null : folder.value ? `${folder.value}/` : '/'));
const shownName = computed(() => (folder.value ? folder.value.split('/').pop()! : S.top));
const title = ref('');
const format = ref<CompileFormat>('docx');
const info = shallowRef<RenderInfo | null>(null);
const state = shallowRef<RenderState | null>(null);
const error = ref<string | null>(null);
const saved = ref<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
let asked = 0;

/** What is left out of it: every path left out under it. */
const leftOut = computed(() => {
  const f = folder.value;
  if (f === null) return [];
  return excludedPaths(known.value).filter((p) => !f || p.startsWith(`${f}/`));
});
const busy = computed(() => state.value?.state === 'rendering');
const outputName = (f: CompileFormat) => `${(folder.value ? folder.value.split('/').pop() : 'book') || 'book'}.${f}`;

// Another folder chosen: its title and format as last compiled, and how its renders stand.
watch(folder, (f) => {
  asked++;
  clearTimeout(timer);
  state.value = null;
  error.value = null;
  saved.value = null;
  info.value = null;
  if (f === null) return;
  const s = settingsOf(f);
  title.value = s?.title ?? shownName.value;
  format.value = s?.format ?? 'docx';
  void follow(false);
}, { immediate: true });

/** How the folder's render in the chosen format stands; followed while it runs, and saved once it is done if `save`. */
async function follow(save: boolean) {
  const p = renderPath.value;
  const n = asked;
  if (!p) return;
  clearTimeout(timer);
  try {
    const next = await ctx.host.renders(p);
    if (n !== asked) return;
    info.value = next;
    const r = next.renders.find((x) => x.format === format.value) ?? null;
    if (save || r?.state === 'rendering') state.value = r;
    if (r?.state === 'rendering') {
      timer = setTimeout(() => void follow(save), 700);
      return;
    }
    if (save && r?.state === 'done') await saveOutput(r.format as CompileFormat);
  } catch (e) {
    if (n === asked) error.value = ctx.explain(e).text;
  }
}

async function saveOutput(f: CompileFormat) {
  try {
    const blob = await ctx.host.renderOutput(renderPath.value!, f);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = outputName(f);
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    saved.value = S.saved(outputName(f));
  } catch (e) {
    error.value = ctx.explain(e).text;
  }
}

async function compile() {
  const f = folder.value;
  const p = renderPath.value;
  if (f === null || !p) return;
  error.value = null;
  saved.value = null;
  const t = title.value.trim() || shownName.value;
  try {
    // Kept for the folder, for next time (and the mark by its name).
    await ctx.request('POST', 'settings', { folder: f, title: t === shownName.value ? null : t, format: format.value });
    void load(ctx);
  } catch (e) {
    // Not kept (someone may not change the folder): compiled all the same.
    console.warn('[kuraa] Compile could not keep its settings', e);
  }
  try {
    state.value = await ctx.host.render(p, format.value, { exclude: leftOut.value, noHeading: noHeadingPaths(known.value).filter((x) => !f || x.startsWith(`${f}/`)), title: t });
    if (state.value.state !== 'failed') await follow(true);
  } catch (e) {
    error.value = ctx.explain(e).text;
  }
}

onBeforeUnmount(() => {
  asked++;
  clearTimeout(timer);
});
</script>

<template>
  <div class="compile-panel" data-testid="compile-panel">
    <p v-if="folder === null" class="compile-about">{{ S.none }}</p>
    <template v-else>
      <h3 class="compile-folder" data-testid="compile-folder">{{ S.folderTitle(shownName) }}</h3>
      <label class="compile-field">
        <span>{{ S.bookTitle }}</span>
        <input v-model="title" type="text" data-testid="compile-title" :disabled="busy" />
      </label>
      <fieldset class="compile-formats" :disabled="busy">
        <legend>{{ S.format }}</legend>
        <label v-for="f in FORMATS" :key="f"><input v-model="format" type="radio" name="compile-format" :value="f" :data-testid="`compile-format:${f}`" /> {{ S.formats[f] }}</label>
      </fieldset>
      <p class="compile-about">{{ S.about }}<template v-if="leftOut.length"> {{ S.leftOutCount(leftOut.length) }}</template></p>
      <p v-if="info?.unavailable" class="compile-warn" data-testid="compile-unavailable">{{ info.unavailable }}</p>
      <div class="compile-actions">
        <button type="button" class="primary" data-testid="compile-button" :disabled="busy || !!info?.unavailable" @click="compile">{{ busy ? S.compiling : S.compile }}</button>
        <button v-if="state?.state === 'done' && saved" type="button" data-testid="compile-save-again" @click="saveOutput(state.format as CompileFormat)">{{ S.saveAgain }}</button>
      </div>
      <p v-if="busy" class="compile-status" data-testid="compile-status">{{ state?.progress || state?.message }}</p>
      <p v-else-if="saved" class="compile-status" data-testid="compile-saved">{{ saved }}</p>
      <template v-else-if="state?.state === 'failed'">
        <p class="compile-warn" data-testid="compile-failed">{{ state.message }}</p>
        <details v-if="state.log"><summary>{{ S.details }}</summary><pre class="compile-log">{{ state.log }}</pre></details>
      </template>
      <p v-if="error" class="compile-warn">{{ error }}</p>
    </template>
  </div>
</template>

<style>
.compile-panel { display: grid; gap: 10px; padding: 10px 12px; align-content: start; }
.compile-folder { margin: 0; font-size: 14px; }
.compile-field { display: grid; gap: 3px; }
.compile-field > span, .compile-formats legend { color: var(--muted); font-size: 12px; }
.compile-formats { border: 0; margin: 0; padding: 0; display: flex; gap: 12px; flex-wrap: wrap; }
.compile-formats legend { padding: 0; margin-bottom: 3px; }
.compile-about { margin: 0; color: var(--muted); font-size: 12px; }
.compile-actions { display: flex; gap: 6px; }
.compile-status { margin: 0; font-size: 12px; }
.compile-warn { margin: 0; color: var(--warn); font-size: 12px; }
.compile-log { max-height: 240px; overflow: auto; font-size: 11px; white-space: pre-wrap; }
</style>
