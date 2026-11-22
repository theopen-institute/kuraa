<script setup lang="ts">
// Settings › You (decision 0064): what is yours alone, kept in this browser.
// Your name, email and colour, saved as each is changed (others see your name
// and colour beside what you type); you on this computer (your key); how each
// kind of document is edited for you (its editor module, on or off); and, where
// the shell does not run the server, the server and its access code, used as
// the window closes (pending): half an address would connect nowhere.
import { computed, onMounted, shallowRef, useTemplateRef } from 'vue';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { HostApi } from './api.js';
import { personShellFor } from './hostPerson.js';
import type { Settings } from './settings.js';
import type { PersonShell, Shell } from './shell.js';
import { S } from './strings.js';
import PersonKey from './PersonKey.vue';
import SettingsForm from './SettingsForm.vue';

const props = defineProps<{
  api: HostApi;
  shell: Shell;
  settings: Settings;
  /** Every editor module, by type id, and the ones this person has turned off. */
  editors: Record<string, FormatEditor>;
  editorsOff: string[];
}>();
const emit = defineEmits<{ saveSettings: [settings: Settings]; editorsOff: [ids: string[]] }>();

// You on this computer: through the host, where it listens only on this computer (0047).
const personShell = shallowRef<PersonShell | null>(null);
onMounted(async () => {
  personShell.value = await personShellFor(props.api);
});

const modules = computed(() => Object.entries(props.editors).map(([id, m]) => ({ id, label: m.label ?? id, description: m.description ?? '' })));
const checked = (e: Event) => (e.target as HTMLInputElement).checked;
function toggleEditor(id: string, on: boolean) {
  emit('editorsOff', on ? props.editorsOff.filter((x) => x !== id) : [...props.editorsOff, id]);
}

const connection = useTemplateRef<InstanceType<typeof SettingsForm>>('connection');
/** The server and access code changed here, to use as the window closes (SettingsForm.pending). */
const pending = () => connection.value?.pending() ?? null;
defineExpose({ pending });
</script>

<template>
  <div data-testid="settings-you">
    <section class="settings-part">
      <SettingsForm :initial="settings" :shell="shell" part="profile" autosave @save="(s) => emit('saveSettings', s)" />
      <PersonKey v-if="personShell" :person="personShell" :display-name="settings.name" />
    </section>
    <section v-if="modules.length" class="settings-part" data-testid="components-editing">
      <fieldset class="pref-group">
        <legend>{{ S.components.editing }}</legend>
        <label v-for="m in modules" :key="m.id" class="component">
          <input type="checkbox" :checked="!editorsOff.includes(m.id)" :aria-label="m.label" @change="toggleEditor(m.id, checked($event))">
          <span class="component-text">
            <span class="component-name">{{ m.label }}</span>
            <span class="component-about">{{ m.description }}</span>
          </span>
        </label>
      </fieldset>
    </section>
    <section v-if="!shell.managesHost" class="settings-part" data-testid="settings-connection">
      <fieldset class="pref-group">
        <legend>{{ S.preferences.connection }}</legend>
        <p class="pref-note">{{ S.preferences.connectionAbout }}</p>
        <SettingsForm ref="connection" :initial="settings" :shell="shell" part="connection" deferred />
      </fieldset>
    </section>
  </div>
</template>
