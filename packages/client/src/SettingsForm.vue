<script setup lang="ts">
// Your settings: name, email, cursor colour, and the host (unless the shell runs it).
import { reactive } from 'vue';
import type { Settings } from './settings.js';
import type { Shell } from './shell.js';
import { vFocus } from './vue.js';

const props = defineProps<{ initial: Settings; shell: Shell; cancellable?: boolean; autoFocus?: boolean }>();
const emit = defineEmits<{ save: [settings: Settings]; cancel: [] }>();

const s = reactive({ ...props.initial });

function submit() {
  emit('save', { ...s, name: s.name.trim(), email: s.email.trim(), hostUrl: s.hostUrl.trim().replace(/\/$/, ''), token: s.token.trim() });
}
</script>

<template>
  <form class="settings-form" @submit.prevent="submit">
    <label class="field">
      <span>Display name</span>
      <input v-model="s.name" v-focus="autoFocus" name="name" required>
    </label>
    <label class="field">
      <span>Email, for co-author credit</span>
      <input v-model="s.email" name="email" type="email">
    </label>
    <label class="field">
      <span>Cursor colour</span>
      <input v-model="s.color" name="color" type="color">
    </label>
    <template v-if="!shell.managesHost">
      <label class="field">
        <span>Host URL</span>
        <input v-model="s.hostUrl" name="hostUrl" type="url" required>
      </label>
      <label class="field">
        <span>Access token</span>
        <input v-model="s.token" name="token" type="password" autocomplete="off" required>
      </label>
    </template>
    <div v-if="shell.openFolder || shell.leave" class="modal-shell">
      <button v-if="shell.openFolder" type="button" @click="shell.openFolder()">Open another folder…</button>
      <button v-if="shell.leave" type="button" @click="shell.leave()">Join a shared host…</button>
    </div>
    <div class="modal-actions">
      <button v-if="cancellable" type="button" @click="emit('cancel')">Cancel</button>
      <button type="submit" class="primary">Save settings</button>
    </div>
  </form>
</template>
