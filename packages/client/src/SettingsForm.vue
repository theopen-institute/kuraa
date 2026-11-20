<script setup lang="ts">
// Your settings: name, email, cursor colour, and the host and its token (unless
// the shell runs it). `part` shows some of them: the menu keeps the host and token
// in its Identity and access panel, apart from the rest.
import { reactive } from 'vue';
import type { Settings } from './settings.js';
import type { Shell } from './shell.js';
import { vFocus } from './vue.js';

const props = withDefaults(defineProps<{ initial: Settings; shell: Shell; part?: 'all' | 'profile' | 'connection'; cancellable?: boolean; autoFocus?: boolean }>(), { part: 'all' });
const emit = defineEmits<{ save: [settings: Settings]; cancel: [] }>();

const s = reactive({ ...props.initial });

function submit() {
  emit('save', { ...s, name: s.name.trim(), email: s.email.trim(), hostUrl: s.hostUrl.trim().replace(/\/$/, ''), token: s.token.trim() });
}
</script>

<template>
  <form class="settings-form" @submit.prevent="submit">
    <template v-if="part !== 'connection'">
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
    </template>
    <template v-if="part !== 'profile' && !shell.managesHost">
      <label class="field">
        <span>Host URL</span>
        <input v-model="s.hostUrl" name="hostUrl" type="url" required>
      </label>
      <label class="field">
        <span>Access token</span>
        <input v-model="s.token" name="token" type="password" autocomplete="off" required>
      </label>
    </template>
    <div v-if="part !== 'connection' && (shell.openFolder || shell.leave)" class="modal-shell">
      <button v-if="shell.openFolder" type="button" @click="shell.openFolder()">Open another folder…</button>
      <button v-if="shell.leave" type="button" @click="shell.leave()">Join a shared host…</button>
    </div>
    <div class="modal-actions">
      <button v-if="cancellable" type="button" @click="emit('cancel')">Cancel</button>
      <button type="submit" class="primary">{{ part === 'connection' ? 'Save connection' : 'Save settings' }}</button>
    </div>
  </form>
</template>
