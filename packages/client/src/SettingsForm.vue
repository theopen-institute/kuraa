<script setup lang="ts">
// Your settings: name, email, cursor colour, and the server and its access code
// (unless the shell runs it). `part` shows some of them: the menu keeps the
// server and access code in a panel of their own, apart from the rest.
// With `autosave` (the menu's name, email and colour), each field is saved as
// it is changed (on leaving it, or Enter; the colour as it is picked), and what
// is still being typed when the form goes away (the menu closed), with no
// button. A name left empty goes back to the saved one; an email that is not
// one is not saved. With `deferred` (the server and access code, in Settings),
// there is no button either: the window asks what changed as it closes
// (pending), and uses it then.
import { onBeforeUnmount, reactive, useTemplateRef } from 'vue';
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
  /** Save each field as it is changed, with no save button. */
  autosave?: boolean;
  /** No save button: whoever shows it asks what changed (pending), as it closes. */
  deferred?: boolean;
}>(), { part: 'all' });
const emit = defineEmits<{ save: [settings: Settings]; cancel: [] }>();

const s = reactive({ ...props.initial });

const cleaned = (): Settings => ({ ...s, name: s.name.trim(), email: s.email.trim(), hostUrl: s.hostUrl.trim().replace(/\/$/, ''), token: s.token.trim() });

function submit() {
  emit('save', cleaned());
}

const emailInput = useTemplateRef<HTMLInputElement>('emailInput');

/** Your name, email and colour as they would be saved (autosave): each field that is not valid as it was saved; null if nothing differs. */
function edited(): Settings | null {
  const was = props.initial;
  const next = { ...was, name: s.name.trim() || was.name, email: emailInput.value?.validity.valid === false ? was.email : s.email.trim(), color: s.color };
  return next.name === was.name && next.email === was.email && next.color === was.color ? null : next;
}

/** A field changed, or Enter in one (autosave): saved, or, if it is not valid, said why. */
function saveField(event: Event) {
  if (!props.autosave) return;
  const input = event.target;
  if (!(input instanceof HTMLInputElement)) return;
  if (input.name === 'name' && !s.name.trim()) {
    s.name = props.initial.name;
    return;
  }
  if (!input.checkValidity()) {
    input.reportValidity();
    return;
  }
  const next = edited();
  if (next) emit('save', next);
}

const form = useTemplateRef<HTMLFormElement>('form');

/**
 * What changed, for whoever shows it to use as it closes (deferred): the
 * settings to use, null if nothing changed, or 'invalid' if a field is not
 * valid (said at it).
 */
function pending(): Settings | null | 'invalid' {
  const next = cleaned();
  const was = props.initial;
  if (next.hostUrl === was.hostUrl && next.token === was.token) return null;
  if (form.value && !form.value.reportValidity()) return 'invalid';
  return next;
}
defineExpose({ pending });

// The menu closed (Escape, a click outside) with a field still being typed in: it changes no more, so it is kept.
onBeforeUnmount(() => {
  if (!props.autosave) return;
  const next = edited();
  if (next) emit('save', next);
});
</script>

<template>
  <form ref="form" class="settings-form" @submit.prevent="autosave || deferred ? undefined : submit()" @change="saveField" @keydown.enter="autosave && saveField($event)">
    <template v-if="part !== 'connection'">
      <label class="field">
        <span>{{ S.settings.name }}</span>
        <input v-model="s.name" v-focus="autoFocus" name="name" autocomplete="name" required>
      </label>
      <label class="field">
        <span>{{ S.settings.email }}</span>
        <input ref="emailInput" v-model="s.email" name="email" type="email" autocomplete="email">
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
    <div v-if="!autosave && !deferred" class="modal-actions">
      <button v-if="cancellable" type="button" @click="emit('cancel')">{{ S.common.cancel }}</button>
      <button type="submit" class="primary">{{ submitLabel ?? (part === 'connection' ? S.settings.saveConnection : S.settings.save) }}</button>
    </div>
  </form>
</template>
