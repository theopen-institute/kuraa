<script setup lang="ts">
// News in passing (an outside edit merged, a conflict, a version saved): a note
// in the corner. Information fades; warnings stay until dismissed.
import { ref, watch } from 'vue';
import type { Notice } from './types.js';
import { S } from './strings.js';

const props = defineProps<{ notice: Notice | null }>();
const emit = defineEmits<{ dismiss: [] }>();
const hidden = ref<string | null>(null);

watch(() => props.notice, (notice, _prev, onCleanup) => {
  // Warnings, and notes with something to do, stay until dismissed.
  if (!notice || notice.kind === 'warn' || notice.actions?.length) return;
  const t = setTimeout(() => {
    hidden.value = notice.text;
  }, 6000);
  onCleanup(() => clearTimeout(t));
}, { immediate: true });

function dismiss() {
  hidden.value = props.notice?.text ?? null;
  emit('dismiss');
}
</script>

<template>
  <div
    v-if="notice && hidden !== notice.text"
    :class="['notice-toast', notice.kind]"
    :role="notice.kind === 'warn' ? 'alert' : 'status'"
    data-testid="notice"
  >
    <span class="notice-text">{{ notice.text }}</span>
    <span v-if="notice.actions?.length" class="notice-actions">
      <button v-for="a in notice.actions" :key="a.label" type="button" :data-testid="a.testid" @click="a.run()">{{ a.label }}</button>
    </span>
    <button type="button" class="notice-dismiss" :aria-label="S.common.dismiss" @click="dismiss">×</button>
  </div>
</template>
