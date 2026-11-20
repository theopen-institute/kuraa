<script setup lang="ts">
// Your settings: name, email, cursor colour, and the server and its access code
// (unless the shell runs it). `part` shows some of them: the menu keeps the
// server and access code in a panel of their own, apart from the rest.
import { reactive } from 'vue';
import type { Settings } from './settings.js';
import type { Shell } from './shell.js';
import { S } from './strings.js';
import { vFocus } from './vue.js';

const props = withDefaults(defineProps<{
  initial: Settings;
  shell: Shell;
  part?: 'all' | 'profile' | 'connection';
  cancellable?: boolean;
  autoFocus?: boolean;
  /** What the save button says, if not the usual. */
  submitLabel?: string;
}>(), { part: 'all' });
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
        <span>{{ S.settings.name }}</span>
        <input v-model="s.name" v-focus="autoFocus" name="name" autocomplete="name" required>
      </label>
      <label class="field">
        <span>{{ S.settings.email }}</span>
        <input v-model="s.email" name="email" type="email" autocomplete="email">
      </label>
      <label class="field">
        <span>{{ S.settings.colour }}</span>
        <input v-model="s.color" name="color" type="color">
      </label>
    </template>
    <template v-if="part !== 'profile' && !shell.managesHost">
      <label class="field">
        <span>{{ S.settings.server }}</span>
        <input v-model="s.hostUrl" name="hostUrl" type="url" required>
      </label>
      <label class="field">
        <span>{{ S.settings.code }}</span>
        <input v-model="s.token" name="token" type="password" autocomplete="off" required>
      </label>
    </template>
    <div v-if="part !== 'connection' && shell.leave" class="modal-shell">
      <button type="button" @click="shell.leave()">{{ S.settings.join }}</button>
    </div>
    <div class="modal-actions">
      <button v-if="cancellable" type="button" @click="emit('cancel')">{{ S.common.cancel }}</button>
      <button type="submit" class="primary">{{ submitLabel ?? (part === 'connection' ? S.settings.saveConnection : S.settings.save) }}</button>
    </div>
  </form>
</template>
