<script setup lang="ts">
// Adding a workspace to a hub: a new one (a folder of its own, made a git
// repository), or one shared from another device, joined with the invitation
// or subscription link someone gave (kuraa-invite:… or kuraa-link:…).
import { computed, ref } from 'vue';
import type { HubApi, HubWorkspace } from './api.js';
import { onEscape, vFocus } from './vue.js';

const props = defineProps<{ hub: HubApi }>();
const emit = defineEmits<{ added: [workspace: HubWorkspace]; cancel: [] }>();

const mode = ref<'new' | 'join'>('new');
const name = ref('');
const invitation = ref('');
const busy = ref(false);
const error = ref<string | null>(null);

const kind = computed(() => {
  const t = invitation.value.trim();
  return t.startsWith('kuraa-link:') ? 'link' : t.startsWith('kuraa-invite:') ? 'invitation' : null;
});

onEscape(() => {
  if (!busy.value) emit('cancel');
});

async function submit() {
  error.value = null;
  if (mode.value === 'new' && !name.value.trim()) {
    error.value = 'Give the workspace a name.';
    return;
  }
  if (mode.value === 'join' && !kind.value) {
    error.value = 'Paste an invitation (kuraa-invite:…) or a subscription link (kuraa-link:…).';
    return;
  }
  busy.value = true;
  try {
    const w = mode.value === 'new' ? await props.hub.create(name.value) : await props.hub.join(invitation.value.trim(), name.value);
    emit('added', w);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="!busy && emit('cancel')">
    <form class="modal naming add-workspace" role="dialog" aria-modal="true" aria-label="Add a workspace" data-testid="add-workspace" @submit.prevent="submit">
      <h2>Add a workspace</h2>
      <div class="segmented" aria-label="How">
        <button type="button" :class="{ active: mode === 'new' }" :aria-pressed="mode === 'new'" data-testid="add-workspace-new" :disabled="busy" @click="mode = 'new'; error = null">A new folder</button>
        <button type="button" :class="{ active: mode === 'join' }" :aria-pressed="mode === 'join'" data-testid="add-workspace-join" :disabled="busy" @click="mode = 'join'; error = null">Join from an invitation</button>
      </div>
      <p class="naming-hint">
        <template v-if="mode === 'new'">A folder of its own, kept with git. Files you make in it are committed as you work.</template>
        <template v-else>Paste the invitation or subscription link someone gave you. This copy syncs with their devices: what you do reaches them, and what they do reaches you.</template>
      </p>
      <label v-if="mode === 'join'" class="field">
        <span>Invitation or link</span>
        <textarea
          v-model="invitation"
          v-focus
          name="invitation"
          rows="3"
          spellcheck="false"
          placeholder="kuraa-link:…"
          data-testid="add-workspace-invitation"
          :disabled="busy"
          @input="error = null"
        />
      </label>
      <label class="field">
        <span>Name</span>
        <input
          v-model="name"
          v-focus="mode === 'new'"
          name="name"
          :placeholder="mode === 'new' ? 'Field notes' : 'What to call it here'"
          data-testid="add-workspace-name"
          :disabled="busy"
          @input="error = null"
        >
      </label>
      <p v-if="busy && mode === 'join'" class="naming-hint" role="status">Looking for a device of the workspace to let this one in…</p>
      <p v-if="error" class="naming-error" role="alert">{{ error }}</p>
      <div class="modal-actions">
        <button type="button" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button type="submit" class="primary" data-testid="add-workspace-submit" :disabled="busy">
          {{ busy ? (mode === 'new' ? 'Creating…' : 'Joining…') : mode === 'new' ? 'Create' : 'Join' }}
        </button>
      </div>
    </form>
  </div>
</template>
