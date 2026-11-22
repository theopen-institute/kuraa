<script setup lang="ts">
// Suggesting a change to a document you may not change (0066): its text, to edit
// and send. Those who may change it see it as a suggestion, to accept or not;
// your copy stays as it is until someone does.
import { ref, shallowRef, useTemplateRef } from 'vue';
import type { HostApi } from './api.js';
import { S } from './strings.js';
import { useDialog, vFocus } from './vue.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{ api: HostApi; path: string; title: string; text: string }>();
const emit = defineEmits<{ close: []; sent: [] }>();
const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => emit('close'));

const text = ref(props.text);
const busy = ref(false);
const error = shallowRef<unknown>(null);

async function send() {
  if (text.value === props.text) {
    emit('close');
    return;
  }
  busy.value = true;
  error.value = null;
  try {
    await props.api.suggest(props.path, text.value);
    emit('sent');
  } catch (e) {
    error.value = e;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="emit('close')">
    <form ref="root" class="modal naming suggest" role="dialog" aria-modal="true" aria-labelledby="suggest-title" data-testid="suggest-dialog" @submit.prevent="send">
      <h2 id="suggest-title">{{ S.access.suggestTitle(title) }}</h2>
      <p class="naming-hint">{{ S.access.suggestAbout }}</p>
      <textarea v-model="text" v-focus rows="16" spellcheck="true" :aria-label="S.access.suggestLabel" data-testid="suggest-text" />
      <ErrorBanner v-if="error" :error="error" inline class="naming-error" />
      <div class="modal-actions">
        <button type="button" @click="emit('close')">{{ S.common.cancel }}</button>
        <button type="submit" class="primary" :disabled="busy" data-testid="suggest-send">{{ S.access.send }}</button>
      </div>
    </form>
  </div>
</template>
