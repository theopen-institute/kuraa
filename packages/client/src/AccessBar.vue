<script setup lang="ts">
// Above a document, who reads it (if fewer than everyone) and, for someone who
// may not change it, that it is read only and who may (0066). And, once, that
// changes of this person's were not kept (0072), with a way to see them.
import { computed, ref } from 'vue';
import type { FileAccess } from './api.js';
import { S } from './strings.js';

const props = defineProps<{ access: FileAccess }>();
const emit = defineEmits<{ show: [commit: string] }>();

/** Told once, on this browser: the changes not kept that this person has seen to. */
const seenKey = (commit: string) => `kuraa.notKept.${commit}`;
const seenNow = ref(0);
const unseen = computed(() => {
  void seenNow.value;
  return (props.access.notKept ?? []).find((n) => {
    try {
      return !localStorage.getItem(seenKey(n.commit));
    } catch {
      return true;
    }
  }) ?? null;
});
function seen(commit: string) {
  try {
    localStorage.setItem(seenKey(commit), '1');
  } catch { /* told again next time */ }
  seenNow.value++;
}
</script>

<template>
  <div v-if="unseen" class="banner warn access-bar" data-testid="not-kept-notice">
    <span>{{ S.access.notKept(S.versions.date(unseen.date)) }}</span>
    <button type="button" data-testid="not-kept-show" @click="emit('show', unseen.commit); seen(unseen.commit)">{{ S.access.show }}</button>
    <button type="button" data-testid="not-kept-ok" @click="seen(unseen.commit)">{{ S.access.dismiss }}</button>
  </div>
  <div v-if="!access.canWrite || access.readers" class="banner info access-bar" data-testid="access">
    <span v-if="access.readers" data-testid="readers-line">{{ S.readers.line(access.readers.words) }}</span>
    <span v-if="!access.canWrite" data-testid="read-only">{{ S.access.readOnly(access.rule?.by ?? []) }}</span>
  </div>
</template>
