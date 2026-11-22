<script setup lang="ts">
// Above a document, who may change it (0066): for someone who may not, that it
// is read only, who may, and Suggest a change…; and the document's open
// suggestions, each to read, compare, and (for those who may change it) accept
// or dismiss.
import type { FileAccess, SuggestionInfo } from './api.js';
import { S } from './strings.js';

defineProps<{ access: FileAccess }>();
const emit = defineEmits<{ suggest: []; view: [suggestion: SuggestionInfo] }>();
</script>

<template>
  <div v-if="!access.canWrite || access.suggestions.length" class="banner info access-bar" data-testid="access">
    <span v-if="!access.canWrite" data-testid="read-only">{{ S.access.readOnly(access.rule?.by ?? []) }}</span>
    <button v-if="!access.canWrite" type="button" data-testid="suggest" @click="emit('suggest')">{{ S.access.suggest }}</button>
    <span v-if="access.suggestions.length" class="access-suggestions" data-testid="suggestions">
      {{ S.access.suggestions(access.suggestions.length) }}
      <button v-for="(s, i) in access.suggestions" :key="s.commit" type="button" :data-testid="`suggestion:${i}`" @click="emit('view', s)">
        {{ S.access.suggestionBy(s.name, S.versions.date(s.date)) }}
      </button>
    </span>
  </div>
</template>
