<script setup lang="ts">
// Settings on their own: the first time, before a host is known. The menu has the same form.
import type { Settings } from './settings.js';
import type { Shell } from './shell.js';
import SettingsForm from './SettingsForm.vue';

defineProps<{ initial: Settings; shell: Shell; cancellable: boolean }>();
const emit = defineEmits<{ save: [settings: Settings]; cancel: [] }>();
</script>

<template>
  <div class="modal-backdrop">
    <div class="modal">
      <h2>Settings</h2>
      <SettingsForm :initial="initial" :shell="shell" :cancellable="cancellable" auto-focus @save="(s) => emit('save', s)" @cancel="emit('cancel')" />
    </div>
  </div>
</template>
