<script setup lang="ts">
// Import's dialog (0114): what to import, dropped or chosen; for a Word
// document, where to split it; then sent, a part at a time, and made into a
// folder by the host half, which says what it made and what it could not bring.
import { computed, onBeforeUnmount, ref, shallowRef } from 'vue';
import type { FeaturePanelContext } from '@kuraa/feature-kit/client';
import { fromDrop, fromFile, fromFolder, toBase64, type Chosen } from './choose.js';
import { into } from './store.js';
import { S } from './strings.js';

const props = defineProps<{ ctx: FeaturePanelContext }>();
const ctx = props.ctx;

/** The most one import may send; a part of a file sent at a time. */
const MAX = 1024 * 1024 * 1024;
const PART = 8 * 1024 * 1024;

type Result = { folder: string; first: string | null; documents: number; folders: number; images: number; others: number; left: string[] };
const chosen = shallowRef<Chosen | null>(null);
const split = ref<'chapters' | 'sections' | 'none'>('chapters');
const stage = ref<'choose' | 'sending' | 'importing' | 'done'>('choose');
const sent = ref({ done: 0, total: 0 });
const result = shallowRef<Result | null>(null);
const error = ref<string | null>(null);
const over = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);
const folderInput = ref<HTMLInputElement | null>(null);
let session = '';
let stopped = false;

const where = computed(() => (into.value ? into.value.split('/').pop()! : null));
const busy = computed(() => stage.value === 'sending' || stage.value === 'importing');

function take(c: Chosen | null) {
  error.value = null;
  if (!c) {
    error.value = S.notOne;
    return;
  }
  if (c.size > MAX) {
    error.value = S.big;
    return;
  }
  chosen.value = c;
}
async function dropped(e: DragEvent) {
  over.value = false;
  if (busy.value || !e.dataTransfer) return;
  take(await fromDrop(e.dataTransfer).catch(() => null));
}
async function pickedFile() {
  const f = fileInput.value?.files?.[0];
  if (f) take(await fromFile(f).catch(() => null));
  if (fileInput.value) fileInput.value.value = '';
}
function pickedFolder() {
  const fs = [...(folderInput.value?.files ?? [])];
  if (fs.length) take(fromFolder(fs));
  if (folderInput.value) folderInput.value.value = '';
}

async function run() {
  const c = chosen.value;
  if (!c || busy.value) return;
  error.value = null;
  stopped = false;
  session = crypto.randomUUID();
  ctx.holdOpen(true);
  try {
    stage.value = 'sending';
    sent.value = { done: 0, total: c.files.length };
    for (const f of c.files) {
      const bytes = await f.bytes();
      for (let start = 0; start === 0 || start < bytes.length; start += PART) {
        if (stopped) return;
        await ctx.request('POST', 'upload', { session, path: f.path, data: toBase64(bytes.subarray(start, start + PART)), start });
        if (bytes.length === 0) break;
      }
      sent.value = { ...sent.value, done: sent.value.done + 1 };
    }
    stage.value = 'importing';
    const r = (await ctx.request('POST', 'run', { session, kind: c.kind, into: into.value ?? '', name: c.name, split: split.value, snapshots: c.snapshots })) as unknown as Result;
    result.value = r;
    stage.value = 'done';
  } catch (e) {
    if (!stopped) error.value = ctx.explain(e).text;
    stage.value = 'choose';
    void ctx.request('POST', 'cancel', { session }).catch(() => undefined);
  } finally {
    ctx.holdOpen(false);
  }
}

function cancel() {
  if (busy.value) {
    stopped = true;
    void ctx.request('POST', 'cancel', { session }).catch(() => undefined);
    stage.value = 'choose';
    ctx.holdOpen(false);
  } else ctx.close();
}
function openIt() {
  if (result.value?.first) ctx.openFile(result.value.first);
  ctx.close();
}
onBeforeUnmount(() => {
  if (busy.value) {
    stopped = true;
    void ctx.request('POST', 'cancel', { session }).catch(() => undefined);
  }
});
</script>

<template>
  <div class="import-dialog" data-testid="import-dialog">
    <h3 class="import-heading">{{ S.heading(where) }}</h3>
    <template v-if="stage === 'done' && result">
      <p class="import-made" data-testid="import-made"><strong>{{ S.made(result.folder.split('/').pop()!) }}</strong>: {{ S.counts(result) }}</p>
      <template v-if="result.left.length">
        <p class="import-note">{{ S.left }}</p>
        <ul class="import-left" data-testid="import-left"><li v-for="l in result.left" :key="l">{{ l }}</li></ul>
      </template>
      <div class="import-actions">
        <button type="button" class="primary" data-testid="import-open" :disabled="!result.first" @click="openIt">{{ S.open }}</button>
        <button type="button" @click="ctx.close()">{{ S.close }}</button>
      </div>
    </template>
    <template v-else>
      <p class="import-note">{{ S.intro }}</p>
      <div
        v-if="!chosen"
        :class="['import-drop', { over }]"
        data-testid="import-drop"
        @dragover.prevent="over = true"
        @dragleave="over = false"
        @drop.prevent="dropped"
      >
        <p>{{ S.drop }}</p>
        <p class="import-note">{{ S.or }}</p>
        <div class="import-actions">
          <button type="button" data-testid="import-choose-file" @click="fileInput?.click()">{{ S.chooseFile }}</button>
          <button type="button" data-testid="import-choose-project" @click="folderInput?.click()">{{ S.chooseProject }}</button>
        </div>
        <p class="import-note">{{ S.kinds }}</p>
        <input ref="fileInput" type="file" hidden accept=".docx,.odt,.rtf,.epub,.html,.htm,.zip" data-testid="import-file" @change="pickedFile" />
        <input ref="folderInput" type="file" hidden webkitdirectory data-testid="import-folder" @change="pickedFolder" />
      </div>
      <template v-else>
        <p class="import-chosen" data-testid="import-chosen">
          {{ chosen.kind === 'word' ? S.chosenWord(chosen.name) : S.chosenProject(chosen.name, chosen.files.length) }}
          <button v-if="!busy" type="button" class="link" @click="chosen = null">{{ S.other }}</button>
        </p>
        <label v-if="chosen.kind === 'word'" class="import-field">
          <span>{{ S.split }}</span>
          <select v-model="split" :disabled="busy" data-testid="import-split">
            <option v-for="(label, k) in S.splits" :key="k" :value="k">{{ label }}</option>
          </select>
        </label>
        <p v-if="stage === 'sending'" class="import-status" data-testid="import-status">{{ S.sending(sent.done, sent.total) }}</p>
        <p v-else-if="stage === 'importing'" class="import-status" data-testid="import-status">{{ S.importing }}</p>
        <div class="import-actions">
          <button type="button" class="primary" data-testid="import-run" :disabled="busy" @click="run">{{ S.import }}</button>
          <button type="button" @click="cancel">{{ S.cancel }}</button>
        </div>
      </template>
      <p v-if="error" class="import-warn" data-testid="import-error">{{ error }}</p>
    </template>
  </div>
</template>

<style>
.import-dialog { display: grid; gap: 10px; padding: 14px 16px; width: min(460px, 90vw); }
.import-heading { margin: 0; font-size: 15px; }
.import-note { margin: 0; color: var(--muted); font-size: 12px; }
.import-drop { display: grid; gap: 8px; justify-items: center; text-align: center; padding: 18px 12px; border: 1.5px dashed var(--border); border-radius: 8px; }
.import-drop.over { border-color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, transparent); }
.import-drop > p { margin: 0; }
.import-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.import-chosen { margin: 0; }
.import-chosen .link { margin-left: 6px; border: 0; background: none; color: var(--accent); cursor: pointer; padding: 0; font: inherit; }
.import-field { display: grid; gap: 3px; }
.import-field > span { color: var(--muted); font-size: 12px; }
.import-status { margin: 0; font-size: 13px; }
.import-made { margin: 0; }
.import-left { margin: 0; padding-left: 18px; font-size: 13px; }
.import-warn { margin: 0; color: var(--warn); font-size: 13px; }
</style>
