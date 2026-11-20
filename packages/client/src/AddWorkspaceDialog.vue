<script setup lang="ts">
// Adding a workspace to a hub: a new one (a folder of its own, made a git
// repository), or one someone shared, joined with the invite link they gave
// (kuraa-invite:…).
import { computed, ref, shallowRef, useTemplateRef } from 'vue';
import type { HubApi, HubWorkspace } from './api.js';
import { S } from './strings.js';
import { useDialog, vFocus } from './vue.js';
import ErrorBanner from './ErrorBanner.vue';

const props = defineProps<{ hub: HubApi }>();
const emit = defineEmits<{ added: [workspace: HubWorkspace]; cancel: [] }>();

const mode = ref<'new' | 'join'>('new');
const name = ref('');
const invitation = ref('');
const busy = ref(false);
const error = shallowRef<unknown>(null);

const isLink = computed(() => invitation.value.trim().startsWith('kuraa-invite:'));

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => {
  if (!busy.value) emit('cancel');
});

async function submit() {
  error.value = null;
  if (mode.value === 'new' && !name.value.trim()) {
    error.value = S.addWorkspace.needsName;
    return;
  }
  if (mode.value === 'join' && !isLink.value) {
    error.value = S.addWorkspace.needsLink;
    return;
  }
  busy.value = true;
  try {
    const w = mode.value === 'new' ? await props.hub.create(name.value) : await props.hub.join(invitation.value.trim(), name.value);
    emit('added', w);
  } catch (e) {
    error.value = e;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="!busy && emit('cancel')">
    <form ref="root" class="modal naming add-workspace" role="dialog" aria-modal="true" aria-labelledby="add-workspace-title" data-testid="add-workspace" @submit.prevent="submit">
      <h2 id="add-workspace-title">{{ S.addWorkspace.title }}</h2>
      <div class="segmented" role="group" :aria-label="S.addWorkspace.how">
        <button type="button" :class="{ active: mode === 'new' }" :aria-pressed="mode === 'new'" data-testid="add-workspace-new" :disabled="busy" @click="mode = 'new'; error = null">{{ S.addWorkspace.newFolder }}</button>
        <button type="button" :class="{ active: mode === 'join' }" :aria-pressed="mode === 'join'" data-testid="add-workspace-join" :disabled="busy" @click="mode = 'join'; error = null">{{ S.addWorkspace.join }}</button>
      </div>
      <p class="naming-hint">
        <template v-if="mode === 'new'">{{ S.addWorkspace.newAbout }}</template>
        <template v-else>{{ S.addWorkspace.joinAbout }}</template>
      </p>
      <label v-if="mode === 'join'" class="field">
        <span>{{ S.addWorkspace.link }}</span>
        <textarea
          v-model="invitation"
          v-focus
          name="invitation"
          rows="3"
          spellcheck="false"
          placeholder="kuraa-invite:…"
          data-testid="add-workspace-invitation"
          :disabled="busy"
          @input="error = null"
        />
      </label>
      <label class="field">
        <span>{{ S.addWorkspace.name }}</span>
        <input
          v-model="name"
          v-focus="mode === 'new'"
          name="name"
          :placeholder="mode === 'new' ? S.addWorkspace.namePlaceholder : S.addWorkspace.joinNamePlaceholder"
          data-testid="add-workspace-name"
          :disabled="busy"
          @input="error = null"
        >
      </label>
      <p v-if="busy && mode === 'join'" class="naming-hint" role="status">{{ S.addWorkspace.looking }}</p>
      <ErrorBanner v-if="error" :error="error" inline class="naming-error" />
      <div class="modal-actions">
        <button type="button" :disabled="busy" @click="emit('cancel')">{{ S.common.cancel }}</button>
        <button type="submit" class="primary" data-testid="add-workspace-submit" :disabled="busy">
          {{ busy ? (mode === 'new' ? S.addWorkspace.creating : S.addWorkspace.joining) : mode === 'new' ? S.addWorkspace.create : S.addWorkspace.joinButton }}
        </button>
      </div>
    </form>
  </div>
</template>
