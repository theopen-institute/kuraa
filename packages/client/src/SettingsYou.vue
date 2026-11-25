<script setup lang="ts">
// Settings › You (decision 0064): what is yours alone, kept in this browser.
// Your name, email and colour, saved as each is changed (others see your name
// and colour beside what you type); you on this computer (your key), with two
// subpanels of its own, Sign in from another device and Account recovery (the
// recovery key alone since 0078: no trustees, escrow or email checks); how
// each kind of document is edited for you (its editor module, on or off); and,
// where the shell does not run the host, the host and its access code, used
// as the window closes (pending): half an address would connect nowhere. The rest
// of You stays while a subpanel shows (hidden), so nothing typed there is lost.
import { computed, onMounted, ref, shallowRef, useTemplateRef } from 'vue';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { HostApi } from './api.js';
import { personShellFor } from './hostPerson.js';
import type { Settings } from './settings.js';
import type { PersonShell, Shell } from './shell.js';
import { S } from './strings.js';
import PersonKey from './PersonKey.vue';
import SettingsForm from './SettingsForm.vue';
import SubpanelLink from './SubpanelLink.vue';
import FeatureMount from './FeatureMount.vue';
import type { FeatureStatus } from '@kuraa/feature-kit/client';
import type { ActiveFeature } from './features.js';

const props = defineProps<{
  api: HostApi;
  shell: Shell;
  settings: Settings;
  /** Every editor module, by type id, and the ones this person has turned off. */
  editors: Record<string, FormatEditor>;
  editorsOff: string[];
  /** Features (0082): how each stands, the client halves on for the workspace, and those this person hid. */
  features: FeatureStatus[];
  featureParts: ActiveFeature[];
  hiddenFeatures: string[];
}>();
const emit = defineEmits<{ saveSettings: [settings: Settings]; editorsOff: [ids: string[]]; hiddenFeatures: [ids: string[]] }>();

/** The features on for the workspace, which each person may hide for themselves. */
const shownFeatures = computed(() => props.featureParts.map((p) => p.status));
function toggleFeature(id: string, shown: boolean) {
  emit('hiddenFeatures', shown ? props.hiddenFeatures.filter((x) => x !== id) : [...props.hiddenFeatures, id]);
}
/** A feature's own part of You, open as a subpanel. */
const featureSub = ref<string | null>(null);
const subPart = computed(() => props.featureParts.find((f) => f.feature.id === featureSub.value && f.feature.settings?.you) ?? null);
const subMount = computed(() => {
  const part = subPart.value;
  const panel = part?.feature.settings?.you;
  return part && panel ? (el: HTMLElement) => panel.mount(el, part.ctx) : null;
});

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

/** A subpanel of You, if one is open. */
const sub = ref<'devices' | 'recovery' | null>(null);
const subTitle = computed(() => (sub.value === 'devices' ? S.person.signInTitle : sub.value === 'recovery' ? S.person.recoveryTitle : ''));

const connection = useTemplateRef<InstanceType<typeof SettingsForm>>('connection');
/** The host and access code changed here, to use as the window closes (SettingsForm.pending). */
const pending = () => connection.value?.pending() ?? null;
defineExpose({ pending });
</script>

<template>
  <div data-testid="settings-you">
    <div v-if="sub" class="subpanel-head">
      <button type="button" class="subpanel-back" data-testid="subpanel-back" @click="sub = null">{{ S.person.back(S.sections.you) }}</button>
      <h4 data-testid="subpanel-title">{{ subTitle }}</h4>
    </div>
    <section v-show="!sub" class="settings-part">
      <SettingsForm :initial="settings" :shell="shell" part="profile" autosave @save="(s) => emit('saveSettings', s)" />
    </section>
    <section v-if="personShell" class="settings-part" :data-testid="sub ? `subpanel-${sub}` : undefined">
      <PersonKey :person="personShell" :display-name="settings.name" :view="sub ?? 'summary'" />
      <template v-if="!sub">
        <SubpanelLink :title="S.person.signInTitle" :about="S.person.signInAbout" testid="open-sign-in" @open="sub = 'devices'" />
        <SubpanelLink :title="S.person.recoveryTitle" :about="S.person.recoveryAbout" testid="open-recovery" @open="sub = 'recovery'" />
      </template>
    </section>
    <section v-if="modules.length" v-show="!sub" class="settings-part" data-testid="components-editing">
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
    <section v-if="shownFeatures.length && !subPart" v-show="!sub" class="settings-part" data-testid="features-shown">
      <fieldset class="pref-group">
        <legend>{{ S.features.shown }}</legend>
        <p class="pref-note">{{ S.features.shownAbout }}</p>
        <label v-for="f in shownFeatures" :key="f.id" class="component">
          <input type="checkbox" :checked="!hiddenFeatures.includes(f.id)" :aria-label="f.label" :data-testid="`feature-shown-${f.id}`" @change="toggleFeature(f.id, checked($event))">
          <span class="component-text">
            <span class="component-name">{{ f.label }}</span>
            <span class="component-about">{{ f.description }}</span>
          </span>
        </label>
      </fieldset>
      <template v-for="p in featureParts" :key="p.feature.id">
        <SubpanelLink v-if="p.feature.settings?.you" :title="p.feature.settings.you.label" :about="p.status.description" :testid="`open-feature-you-${p.feature.id}`" @open="featureSub = p.feature.id" />
      </template>
    </section>
    <section v-if="subPart && subMount" class="settings-part" :data-testid="`feature-you-${subPart.feature.id}`">
      <div class="subpanel-head">
        <button type="button" class="subpanel-back" @click="featureSub = null">{{ S.person.back(S.sections.you) }}</button>
        <h4>{{ subPart.feature.settings!.you!.label }}</h4>
      </div>
      <FeatureMount :mount="subMount" />
    </section>
    <section v-if="!shell.managesHost" v-show="!sub" class="settings-part" data-testid="settings-connection">
      <fieldset class="pref-group">
        <legend>{{ S.preferences.connection }}</legend>
        <p class="pref-note">{{ S.preferences.connectionAbout }}</p>
        <SettingsForm ref="connection" :initial="settings" :shell="shell" part="connection" deferred />
      </fieldset>
    </section>
  </div>
</template>
