<script setup lang="ts">
// Compile's panel (0093): the folder chosen (Compile… on its menu), the book's
// title and format, and its outline: what is in it, in the file tree's order,
// each row at its heading's level, with whether it is in the book (a folder:
// all in it) and, for a folder, whether its name is a heading. Compile renders
// it through the host, follows it, and saves what it made. The title and
// format are kept for the folder, for next time; what is in and what has a
// heading, as Compile keeps them (each folder's .kuraa-compile.yml).
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { BookContent, FeaturePanelContext, RenderInfo, RenderState } from '@kuraa/feature-kit/client';
import { excludedBy, excludedPaths, FORMATS, noHeadingPaths, type CompileFormat } from './settings.js';
import { known, load, settingsOf, target } from './store.js';
import { S } from './strings.js';

const props = defineProps<{ ctx: FeaturePanelContext }>();
const ctx = props.ctx;

/** What the folder's book could have, as the host last said. */
const contents = shallowRef<BookContent[]>([]);
const contentsAsked = { n: 0 };
async function loadContents() {
  const p = renderPath.value;
  const n = ++contentsAsked.n;
  if (!p) {
    contents.value = [];
    return;
  }
  try {
    const items = await ctx.host.renders.bookContents(p);
    if (n === contentsAsked.n) contents.value = items;
  } catch (e) {
    if (n === contentsAsked.n) error.value = ctx.explain(e).text;
  }
}

/** Each row of the outline: in the book or not (and why not), its heading's level (none for a folder with no heading). */
const outline = computed(() => {
  const noHeading = new Set(noHeadingPaths(known.value));
  return contents.value.map((c) => {
    const by = excludedBy(known.value, c.path);
    // Each folder above it with no heading takes a level away.
    const above = [...noHeading].filter((f) => c.path.startsWith(`${f}/`)).length;
    const headed = c.kind === 'document' || !noHeading.has(c.path);
    return { ...c, included: !by, byParent: !!by && by !== c.path, headed, level: c.depth - above };
  });
});

/** In the book, or left out (a folder: all in it). */
async function setIncluded(path: string, include: boolean) {
  try {
    await ctx.request('POST', 'include', { path, include });
  } catch (e) {
    error.value = ctx.explain(e).text;
  }
  await load(ctx);
}

/** A folder's name a heading, or not. */
async function setHeading(path: string, heading: boolean) {
  try {
    await ctx.request('POST', 'heading', { folder: path, heading });
  } catch (e) {
    error.value = ctx.explain(e).text;
  }
  await load(ctx);
}

// Asked for again (Compile… once more): the outline as the files are now.
const stopAsk = ctx.onAsk(() => void loadContents());
onBeforeUnmount(stopAsk);

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
  void loadContents();
}, { immediate: true });

/** How the folder's render in the chosen format stands; followed while it runs, and saved once it is done if `save`. */
async function follow(save: boolean) {
  const p = renderPath.value;
  const n = asked;
  if (!p) return;
  clearTimeout(timer);
  try {
    const next = await ctx.host.renders.info(p);
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
    const blob = await ctx.host.renders.output(renderPath.value!, f);
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
    state.value = await ctx.host.renders.render(p, format.value, { exclude: leftOut.value, noHeading: noHeadingPaths(known.value).filter((x) => !f || x.startsWith(`${f}/`)), title: t });
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
      <div class="compile-contents">
        <span class="compile-contents-head">{{ S.contents }}</span>
        <p v-if="!outline.length" class="compile-about">{{ S.empty }}</p>
        <ul v-else class="compile-outline" data-testid="compile-outline">
          <li
            v-for="r in outline"
            :key="r.path"
            :class="['compile-row', r.kind, { out: !r.included }]"
            :style="{ paddingLeft: `${(r.depth - 1) * 14}px` }"
            :data-testid="`compile-row:${r.path}`"
          >
            <input
              type="checkbox"
              :checked="r.included"
              :disabled="busy || r.byParent"
              :title="r.byParent ? S.outWithFolder : S.inBook"
              :aria-label="`${S.inBook}: ${r.title}`"
              :data-testid="`compile-include:${r.path}`"
              @change="setIncluded(r.path, ($event.target as HTMLInputElement).checked)"
            />
            <span class="compile-level" :title="r.headed ? S.levelTitle(Math.min(6, r.level)) : S.noHeadingTitle">{{ r.headed ? '#'.repeat(Math.min(6, Math.max(1, r.level))) : '–' }}</span>
            <span class="compile-name">{{ r.title }}</span>
            <label v-if="r.kind === 'folder'" class="compile-heading" :title="S.headingTitle">
              <input
                type="checkbox"
                :checked="r.headed"
                :disabled="busy || !r.included"
                :data-testid="`compile-heading:${r.path}`"
                @change="setHeading(r.path, ($event.target as HTMLInputElement).checked)"
              />{{ S.heading }}
            </label>
          </li>
        </ul>
      </div>
      <p class="compile-about">{{ S.about }}</p>
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
.compile-contents { display: grid; gap: 3px; }
.compile-contents-head { color: var(--muted); font-size: 12px; }
.compile-outline { list-style: none; margin: 0; padding: 0; max-height: 50vh; overflow: auto; border: 1px solid var(--border); border-radius: 4px; }
.compile-row { display: flex; align-items: center; gap: 6px; padding-top: 2px; padding-bottom: 2px; padding-right: 6px; font-size: 13px; }
.compile-row > input { margin: 0 0 0 6px; flex: none; }
.compile-row.folder > .compile-name { font-weight: 600; }
.compile-row.out > .compile-name { opacity: 0.5; text-decoration: line-through; }
.compile-level { flex: none; min-width: 2.6em; color: var(--muted); font-family: var(--mono, ui-monospace, monospace); font-size: 11px; }
.compile-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.compile-heading { flex: none; display: inline-flex; align-items: center; gap: 3px; color: var(--muted); font-size: 11px; cursor: pointer; }
.compile-heading > input { margin: 0; }
.compile-actions { display: flex; gap: 6px; }
.compile-status { margin: 0; font-size: 12px; }
.compile-warn { margin: 0; color: var(--warn); font-size: 12px; }
.compile-log { max-height: 240px; overflow: auto; font-size: 11px; white-space: pre-wrap; }
</style>
