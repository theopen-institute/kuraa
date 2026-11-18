<script setup lang="ts">
// News in passing (an outside edit merged, a conflict, a version saved): a note
// in the corner. Information fades; warnings stay until dismissed.
import { ref, watch } from 'vue';
import type { Notice } from './types.js';

const props = defineProps<{ notice: Notice | null }>();
const emit = defineEmits<{ dismiss: [] }>();
const hidden = ref<string | null>(null);

watch(() => props.notice, (notice, _prev, onCleanup) => {
  if (!notice || notice.kind === 'warn') return;
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
    <span>{{ notice.text }}</span>
    <button type="button" aria-label="Dismiss" @click="dismiss">×</button>
  </div>
</template>
