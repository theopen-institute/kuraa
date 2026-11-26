<script setup lang="ts">
// Along the open document's foot (0094): its words (of its target, with a bar),
// and the words written today (of a day's target). A click opens the panel,
// where the targets are set.
import { computed } from 'vue';
import type { FeaturePanelContext } from '@kuraa/feature-kit/client';
import { useLiveWords } from './live.js';
import { sessionTarget, sessionTick, written } from './session.js';
import { S } from './strings.js';

const props = defineProps<{ ctx: FeaturePanelContext }>();
const { words, target } = useLiveWords(props.ctx);
const today = computed(() => {
  void sessionTick.value;
  return { written: written(), target: sessionTarget() };
});
const share = (n: number, of: number) => `${Math.min(100, Math.round((n / of) * 100))}%`;
</script>

<template>
  <button v-if="words !== null" type="button" class="words-status" data-testid="words-status" :title="S.statusTitle" @click="ctx.openPanel('words')">
    <span data-testid="words-count">{{ S.count(words, target) }}</span>
    <span v-if="target" class="words-bar" aria-hidden="true"><span :style="{ width: share(words, target) }" /></span>
    <span v-if="today.written || today.target" class="words-today" data-testid="words-today">· {{ S.today(today.written, today.target) }}</span>
  </button>
</template>

<style>
.words-status { display: inline-flex; align-items: center; gap: 6px; border: 0; background: none; padding: 0 2px; color: var(--muted); font-size: 12px; cursor: pointer; font-variant-numeric: tabular-nums; }
.words-status:hover { color: var(--text); }
.words-bar { width: 48px; height: 4px; border-radius: 2px; background: var(--border); overflow: hidden; display: inline-block; }
.words-bar > span { display: block; height: 100%; background: var(--accent); }
</style>
