<script setup lang="ts">
// A problem, in plain words with what to do next (errors.ts), and what was
// actually said behind Details for whoever wants it. Actions (Try again,
// Dismiss) go in the default slot.
import { computed } from 'vue';
import { explain } from './errors.js';
import { S } from './strings.js';

const props = defineProps<{
  error: unknown;
  /** Said first: what was being done ("Could not open Field notes."). */
  lead?: string;
  /** A banner across the page (the default), or a line inside a panel or dialog. */
  inline?: boolean;
}>();
const shown = computed(() => explain(props.error));
</script>

<template>
  <div :class="inline ? 'error-line' : 'banner warn'" role="alert" data-testid="error">
    <span>
      <template v-if="lead">{{ lead }} </template>{{ shown.text }}
    </span>
    <slot />
    <details v-if="shown.details" class="error-details">
      <summary>{{ S.common.details }}</summary>
      <pre>{{ shown.details }}</pre>
    </details>
  </div>
</template>
