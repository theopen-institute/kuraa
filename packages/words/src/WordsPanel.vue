<script setup lang="ts">
// The Words panel (0094): the open document's words and its target (kept in
// its header, target-words, for everyone), and today's words and a day's
// target (yours, in this browser).
import { computed, ref, watch } from 'vue';
import type { FeaturePanelContext } from '@kuraa/feature-kit/client';
import { targetOf } from './count.js';
import { useLiveWords } from './live.js';
import { restart, sessionTarget, sessionTick, setSessionTarget, written } from './session.js';
import { S } from './strings.js';

const props = defineProps<{ ctx: FeaturePanelContext }>();
const ctx = props.ctx;
const { words, target, hasHeader, recount } = useLiveWords(ctx);
const today = computed(() => {
  void sessionTick.value;
  return { written: written(), target: sessionTarget() };
});
const percent = (n: number, of: number) => Math.min(100, Math.round((n / of) * 100));

// The fields, as typed; saved when left (or Enter).
const docField = ref('');
const dayField = ref('');
watch(target, (t) => (docField.value = t ? String(t) : ''), { immediate: true });
watch(() => today.value.target, (t) => (dayField.value = t ? String(t) : ''), { immediate: true });

function saveDocTarget() {
  const t = targetOf(docField.value);
  if (t === target.value) return;
  ctx.header()?.set({ 'target-words': t });
  recount();
}
function saveDayTarget() {
  setSessionTarget(targetOf(dayField.value));
}
</script>

<template>
  <div class="words-panel" data-testid="words-panel">
    <section>
      <h4>{{ S.thisDocument }}</h4>
      <p class="words-big" data-testid="words-panel-count">{{ (words ?? 0).toLocaleString() }} <span>{{ S.words }}</span></p>
      <label class="words-field">
        <span>{{ S.documentTarget }}</span>
        <input v-model="docField" type="text" inputmode="numeric" :placeholder="S.none" :disabled="!hasHeader" data-testid="words-document-target" @change="saveDocTarget" @keydown.enter="saveDocTarget" />
      </label>
      <div v-if="target" class="words-progress"><span :style="{ width: `${percent(words ?? 0, target)}%` }" /></div>
      <p class="words-about">{{ hasHeader ? S.documentTargetAbout : S.noHeader }}</p>
    </section>
    <section>
      <h4>{{ S.todayTitle }}</h4>
      <p class="words-big" data-testid="words-panel-today">{{ today.written > 0 ? '+' : '' }}{{ today.written.toLocaleString() }} <span>{{ S.written(today.written) }}</span></p>
      <label class="words-field">
        <span>{{ S.sessionTarget }}</span>
        <input v-model="dayField" type="text" inputmode="numeric" :placeholder="S.none" data-testid="words-session-target" @change="saveDayTarget" @keydown.enter="saveDayTarget" />
      </label>
      <div v-if="today.target" class="words-progress"><span :style="{ width: `${percent(Math.max(0, today.written), today.target)}%` }" /></div>
      <p class="words-about">{{ S.sessionAbout }}</p>
      <button type="button" data-testid="words-restart" @click="restart()">{{ S.restart }}</button>
    </section>
    <p class="words-about">{{ S.folders }}</p>
  </div>
</template>

<style>
.words-panel { display: grid; gap: 16px; padding: 10px 12px; align-content: start; }
.words-panel section { display: grid; gap: 6px; }
.words-panel h4 { margin: 0; font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.words-big { margin: 0; font-size: 22px; font-variant-numeric: tabular-nums; }
.words-big > span { font-size: 13px; color: var(--muted); }
.words-field { display: grid; gap: 3px; }
.words-field > span { color: var(--muted); font-size: 12px; }
.words-field > input { max-width: 10em; }
.words-progress { height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.words-progress > span { display: block; height: 100%; background: var(--accent); }
.words-about { margin: 0; color: var(--muted); font-size: 12px; }
.words-panel button { justify-self: start; }
</style>
