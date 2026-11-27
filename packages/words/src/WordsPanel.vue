<script setup lang="ts">
// The Words panel (0094): the open document's words and its target (kept in
// its header, target-words, for everyone); your words today, net and added,
// against a day's target (yours, in this browser), everyone's today, and your
// last seven days, from the workspace's history.
import { computed, ref, watch } from 'vue';
import type { FeaturePanelContext } from '@kuraa/feature-kit/client';
import { targetOf } from './count.js';
import { useLiveWords } from './live.js';
import { DAYS, day, days, dayTarget, isYou, load, setDayTarget, yours } from './session.js';
import { S } from './strings.js';

const props = defineProps<{ ctx: FeaturePanelContext }>();
const ctx = props.ctx;
const { words, target, hasHeader, recount } = useLiveWords(ctx);
void load(ctx);

const todayIs = computed(() => {
  void days.value;
  return day();
});
const today = computed(() => {
  void days.value;
  return yours(ctx, todayIs.value);
});
const everyone = computed(() => days.value?.find((d) => d.date === todayIs.value)?.people ?? []);
/** Your last seven days, newest first, each with its words (nought where none). */
const week = computed(() => {
  void days.value;
  return Array.from({ length: DAYS }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = day(d);
    return { date, label: d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' }), ...yours(ctx, date) };
  });
});
const percent = (n: number, of: number) => Math.min(100, Math.round((n / of) * 100));

// The fields, as typed; saved when left (or Enter).
const docField = ref('');
const dayField = ref('');
watch(target, (t) => (docField.value = t ? String(t) : ''), { immediate: true });
watch(dayTarget, (t) => (dayField.value = t ? String(t) : ''), { immediate: true });

function saveDocTarget() {
  const t = targetOf(docField.value);
  if (t === target.value) return;
  ctx.header()?.set({ 'target-words': t });
  recount();
}
function saveDayTarget() {
  setDayTarget(targetOf(dayField.value));
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
      <div class="words-today-figures">
        <p class="words-big" data-testid="words-panel-net">{{ S.signed(today.net) }} <span>{{ S.net }}</span></p>
        <p class="words-big" data-testid="words-panel-added">{{ today.added.toLocaleString() }} <span>{{ S.added }}</span></p>
      </div>
      <p class="words-about">{{ S.netAbout }}</p>
      <label class="words-field">
        <span>{{ S.dayTarget }}</span>
        <input v-model="dayField" type="text" inputmode="numeric" :placeholder="S.none" data-testid="words-session-target" @change="saveDayTarget" @keydown.enter="saveDayTarget" />
      </label>
      <div v-if="dayTarget" class="words-progress"><span :style="{ width: `${percent(today.added, dayTarget)}%` }" /></div>
      <template v-if="everyone.length > 1">
        <h5>{{ S.everyone }}</h5>
        <table class="words-table" data-testid="words-everyone">
          <tr v-for="p in everyone" :key="p.email || p.name"><td>{{ p.name }}{{ isYou(ctx, p) ? S.you : '' }}</td><td>{{ S.signed(p.net) }} {{ S.net }}</td><td>{{ p.added.toLocaleString() }} {{ S.added }}</td></tr>
        </table>
      </template>
      <p class="words-about">{{ S.dayAbout }}</p>
    </section>
    <section>
      <h4>{{ S.daysTitle }}</h4>
      <table class="words-table" data-testid="words-week">
        <tr v-for="d in week" :key="d.date"><td>{{ d.label }}</td><td>{{ S.signed(d.net) }} {{ S.net }}</td><td>{{ d.added.toLocaleString() }} {{ S.added }}</td></tr>
      </table>
    </section>
    <p class="words-about">{{ S.folders }}</p>
  </div>
</template>

<style>
.words-panel { display: grid; gap: 16px; padding: 10px 12px; align-content: start; }
.words-panel section { display: grid; gap: 6px; }
.words-panel h4 { margin: 0; font-size: 12px; color: var(--muted); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
.words-panel h5 { margin: 4px 0 0; font-size: 12px; color: var(--muted); font-weight: 600; }
.words-big { margin: 0; font-size: 22px; font-variant-numeric: tabular-nums; }
.words-big > span { font-size: 13px; color: var(--muted); }
.words-today-figures { display: flex; gap: 18px; flex-wrap: wrap; }
.words-field { display: grid; gap: 3px; }
.words-field > span { color: var(--muted); font-size: 12px; }
.words-field > input { max-width: 10em; }
.words-progress { height: 6px; border-radius: 3px; background: var(--border); overflow: hidden; }
.words-progress > span { display: block; height: 100%; background: var(--accent); }
.words-about { margin: 0; color: var(--muted); font-size: 12px; }
.words-table { border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
.words-table td { padding: 2px 10px 2px 0; }
.words-table td + td { text-align: right; color: var(--muted); }
</style>
