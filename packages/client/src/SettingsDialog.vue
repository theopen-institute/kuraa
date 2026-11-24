<script setup lang="ts">
// Settings on their own, before a host is known or a name is set. The first
// time, it is a short welcome: what to call you (and your email and colour),
// with the host's address and access code only if the link did not bring
// them. The menu has the same form.
import { computed, useTemplateRef } from 'vue';
import type { Settings } from './settings.js';
import type { Shell } from './shell.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';
import SettingsForm from './SettingsForm.vue';

const props = defineProps<{ initial: Settings; shell: Shell; cancellable: boolean }>();
const emit = defineEmits<{ save: [settings: Settings]; cancel: [] }>();

/** The first time: nothing to cancel back to. */
const welcome = computed(() => !props.cancellable);
/** Ask for the host only where the shell does not supply it and nothing brought it. */
const part = computed(() => (props.shell.managesHost || (props.initial.hostUrl && props.initial.token) ? 'profile' : 'all'));
const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => {
  if (props.cancellable) emit('cancel');
});
</script>

<template>
  <div class="modal-backdrop">
    <div ref="root" class="modal settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" data-testid="settings">
      <template v-if="welcome">
        <h2 id="settings-title">{{ S.settings.welcome }}</h2>
        <p class="welcome-question">{{ S.settings.welcomeQuestion }}</p>
        <p class="muted">{{ S.settings.welcomeAbout }}</p>
      </template>
      <h2 v-else id="settings-title">{{ S.settings.title }}</h2>
      <SettingsForm
        :initial="initial"
        :shell="shell"
        :part="welcome ? part : 'all'"
        :cancellable="cancellable"
        :submit-label="welcome ? S.settings.start : undefined"
        auto-focus
        @save="(s) => emit('save', s)"
        @cancel="emit('cancel')"
      />
    </div>
  </div>
</template>
