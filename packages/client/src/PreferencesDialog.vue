<script setup lang="ts">
// Preferences: the owner's settings for the server on their own computer (the
// host's settings.ts), the same in a browser and in the desktop app (decision
// 0047). The ones most people need are in view, the others under Advanced. A
// value that is wrong is refused, saying what, and the dialog stays open; a
// setting a flag overrides says so. Saving reopens every workspace with them
// (writing and committing first), then the page reloads.
import { computed, reactive, ref, shallowRef, useTemplateRef } from 'vue';
import type { HubApi, HubSettings, SettingsView } from './api.js';
import type { FolderPurpose, Shell } from './shell.js';
import { S } from './strings.js';
import { useDialog } from './vue.js';
import ErrorBanner from './ErrorBanner.vue';
import FolderPicker from './FolderPicker.vue';

const props = defineProps<{ hub: HubApi; shell: Shell }>();
const emit = defineEmits<{ close: []; saved: [] }>();

/** The flag that sets each setting, said where a flag overrides it. */
const FLAGS: Partial<Record<keyof HubSettings, string>> = {
  syncDevices: '--peer', bootstrap: '--bootstrap', formats: '--format', runCode: '--engine', environment: '--env',
  allowInstalls: '--allow-installs', memory: '--memory', cpus: '--cpus', disk: '--disk', allowWrite: '--allow-write',
  allowNetwork: '--allow-network', rImages: '--r-image', dataDir: '--data-dir', workspaces: '--workspaces',
  saveSeconds: '--flush-ms', versionSeconds: '--commit-ms',
};

const view = shallowRef<SettingsView | null>(null);
const loadError = shallowRef<unknown>(null);
const error = ref('');
const busy = ref(false);
const f = reactive({
  syncDevices: false, bootstrap: '', runCode: true, environment: '', allowInstalls: true,
  memory: '', cpus: '', disk: '', allowWrite: false, allowNetwork: false, rImages: '',
  dataDir: null as string | null, workspaces: null as string | null, saveSeconds: '', versionSeconds: '',
  formats: [] as string[],
});

props.hub.settings().then((v) => {
  const p = v.settings;
  Object.assign(f, {
    syncDevices: p.syncDevices, bootstrap: p.bootstrap.join('\n'), runCode: p.runCode, environment: p.environment ?? '',
    allowInstalls: p.allowInstalls, memory: p.memory ?? '', cpus: p.cpus === null ? '' : String(p.cpus), disk: p.disk ?? '',
    allowWrite: p.allowWrite, allowNetwork: p.allowNetwork, rImages: p.rImages.join('\n'), dataDir: p.dataDir, workspaces: p.workspaces,
    saveSeconds: p.saveSeconds === null ? '' : String(p.saveSeconds), versionSeconds: p.versionSeconds === null ? '' : String(p.versionSeconds),
    // Kinds of documents: each one the app has, on unless the settings name others.
    formats: v.formats.filter((x) => !p.formats || p.formats.includes(x.id)).map((x) => x.id),
  });
  view.value = v;
}, (e: unknown) => {
  loadError.value = e;
});

const flagged = (key: keyof HubSettings) => !!view.value?.fromFlags.includes(key);
/** Where code runs, as the dialog says it: the chosen environment, else the first. */
const shownEnvironment = computed(() => {
  const envs = view.value?.environments ?? [];
  return envs.find((e) => e.id === f.environment) ?? envs[0] ?? null;
});

const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
const empty = (s: string) => (s.trim() === '' ? null : s.trim());

/** Choosing a folder: the shell's own dialog, else the page's. */
const picking = shallowRef<{ purpose: FolderPurpose; title: string; start: string | null } | null>(null);
async function choose(purpose: 'workspaces' | 'data') {
  const current = purpose === 'data' ? f.dataDir ?? view.value!.defaultDataDir : f.workspaces ?? view.value!.defaultWorkspaces;
  if (props.shell.chooseFolder) {
    const picked = await props.shell.chooseFolder(purpose);
    if (picked) chosen(purpose, picked);
  } else {
    picking.value = { purpose, title: purpose === 'data' ? S.preferences.whereData : S.preferences.whereNew, start: current };
  }
}
function chosen(purpose: FolderPurpose, path: string) {
  picking.value = null;
  if (purpose === 'data') f.dataDir = path;
  else f.workspaces = path;
}

async function save() {
  if (!view.value || busy.value) return;
  error.value = '';
  busy.value = true;
  try {
    await props.hub.saveSettings({
      syncDevices: f.syncDevices,
      bootstrap: lines(f.bootstrap),
      runCode: f.runCode,
      environment: f.environment || null,
      rImages: lines(f.rImages),
      memory: empty(f.memory),
      cpus: empty(f.cpus) as unknown as number | null,
      disk: empty(f.disk),
      allowWrite: f.allowWrite,
      allowNetwork: f.allowNetwork,
      allowInstalls: f.allowInstalls,
      dataDir: f.dataDir,
      // All on is the default: kept as such, so kinds added later are on too.
      formats: f.formats.length === view.value.formats.length ? null : view.value.formats.filter((x) => f.formats.includes(x.id)).map((x) => x.id),
      saveSeconds: empty(f.saveSeconds) as unknown as number | null,
      versionSeconds: empty(f.versionSeconds) as unknown as number | null,
      workspaces: f.workspaces,
    });
    emit('saved');
  } catch (e) {
    error.value = S.preferences.couldNotSave((e as Error).message);
    busy.value = false;
  }
}

const root = useTemplateRef<HTMLElement>('root');
useDialog(root, () => {
  if (!busy.value && !picking.value) emit('close');
});
</script>

<template>
  <div class="modal-backdrop" @mousedown.self="!busy && emit('close')">
    <form ref="root" class="modal preferences" role="dialog" aria-modal="true" aria-labelledby="preferences-title" data-testid="preferences" novalidate @submit.prevent="save">
      <h2 id="preferences-title">{{ S.preferences.title }}</h2>
      <ErrorBanner v-if="loadError" :error="loadError" inline />
      <p v-if="!view && !loadError" class="muted">{{ S.common.loading }}</p>
      <template v-if="view">
        <fieldset class="pref-group">
          <legend>{{ S.preferences.network }}</legend>
          <label class="pref-check"><input v-model="f.syncDevices" type="checkbox" data-testid="pref-sync"> {{ S.preferences.sync }}
            <span class="pref-hint">{{ S.preferences.syncHint }}</span>
            <span v-if="flagged('syncDevices')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.syncDevices!) }}</span>
          </label>
          <details data-testid="pref-network-advanced">
            <summary>{{ S.preferences.advanced }}</summary>
            <div>
              <label for="pref-bootstrap" class="pref-note">{{ S.preferences.bootstrap }}</label>
              <textarea id="pref-bootstrap" v-model="f.bootstrap" data-testid="pref-bootstrap" spellcheck="false" placeholder="node.example.org:49737" />
              <span v-if="flagged('bootstrap')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.bootstrap!) }}</span>
            </div>
          </details>
        </fieldset>

        <fieldset class="pref-group">
          <legend>{{ S.preferences.formats }}</legend>
          <div data-testid="pref-formats">
            <label v-for="x in view.formats" :key="x.id" class="pref-check">
              <input v-model="f.formats" type="checkbox" :value="x.id" :data-testid="`pref-format-${x.id}`"> {{ x.label }}
            </label>
          </div>
          <span class="pref-note">{{ S.preferences.formatsHint }}</span>
          <span v-if="flagged('formats')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.formats!) }}</span>
        </fieldset>

        <fieldset class="pref-group">
          <legend>{{ S.preferences.running }}</legend>
          <label class="pref-check"><input v-model="f.runCode" type="checkbox" data-testid="pref-run"> {{ S.preferences.run }}
            <span :class="['pref-status', shownEnvironment ? (shownEnvironment.available ? 'ok' : 'no') : '']" data-testid="pref-environments">
              {{ shownEnvironment ? (shownEnvironment.available ? S.preferences.runsIn(shownEnvironment.label) : shownEnvironment.message) : S.preferences.noEnvironment }}
            </span>
            <span v-if="flagged('runCode')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.runCode!) }}</span>
          </label>
          <!-- Where code runs: a choice only when there is one to make. -->
          <label v-if="view.environments.length > 1" class="field">
            <span>{{ S.preferences.where }}</span>
            <select v-model="f.environment" data-testid="pref-environment">
              <option value="">{{ S.preferences.onlyOne }}</option>
              <option v-for="e in view.environments" :key="e.id" :value="e.id">{{ e.label }}</option>
            </select>
            <span v-if="flagged('environment')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.environment!) }}</span>
          </label>
          <label class="pref-check"><input v-model="f.allowInstalls" type="checkbox" data-testid="pref-installs"> {{ S.preferences.installs }}
            <span class="pref-hint">{{ S.preferences.installsHint }}</span>
            <span v-if="flagged('allowInstalls')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.allowInstalls!) }}</span>
          </label>
          <details data-testid="pref-run-advanced">
            <summary>{{ S.preferences.advanced }}</summary>
            <div>
              <div>
                <div class="pref-note">{{ S.preferences.limits }}</div>
                <div class="pref-limits">
                  <label class="field">{{ S.preferences.memory }} <input v-model="f.memory" type="text" :placeholder="view.defaults.memory" data-testid="pref-memory" spellcheck="false"></label>
                  <label class="field">{{ S.preferences.cpus }} <input v-model="f.cpus" type="number" min="0.1" step="0.1" :placeholder="String(view.defaults.cpus)" data-testid="pref-cpus"></label>
                  <label class="field">{{ S.preferences.disk }} <input v-model="f.disk" type="text" :placeholder="view.defaults.disk" data-testid="pref-disk" spellcheck="false"></label>
                </div>
                <span class="pref-note">{{ S.preferences.limitsHint }}</span>
              </div>
              <div>
                <div class="pref-note">{{ S.preferences.mayAsk }}</div>
                <label class="pref-check"><input v-model="f.allowWrite" type="checkbox" data-testid="pref-allow-write"> {{ S.preferences.allowWrite }}
                  <span class="pref-hint warn">{{ S.preferences.allowWriteHint }}</span>
                  <span v-if="flagged('allowWrite')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.allowWrite!) }}</span>
                </label>
                <label class="pref-check"><input v-model="f.allowNetwork" type="checkbox" data-testid="pref-allow-network"> {{ S.preferences.allowNetwork }}
                  <span class="pref-hint warn">{{ S.preferences.allowNetworkHint }}</span>
                  <span v-if="flagged('allowNetwork')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.allowNetwork!) }}</span>
                </label>
              </div>
              <div>
                <label for="pref-images" class="pref-note">{{ S.preferences.images }}</label>
                <textarea id="pref-images" v-model="f.rImages" data-testid="pref-images" spellcheck="false" placeholder="docker.io/rocker/r-ver:4.4.2" />
                <span v-if="flagged('rImages')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.rImages!) }}</span>
              </div>
              <div>
                <div class="pref-note">{{ S.preferences.dataDir }}</div>
                <div class="pref-row">
                  <input type="text" readonly :value="f.dataDir ?? view.defaultDataDir" :aria-label="S.preferences.dataDir" data-testid="pref-data-dir">
                  <button type="button" data-testid="pref-data-dir-choose" @click="choose('data')">{{ S.preferences.choose }}</button>
                  <button type="button" @click="f.dataDir = null">{{ S.preferences.default }}</button>
                </div>
                <span class="pref-note">{{ S.preferences.dataDirHint }}</span>
                <span v-if="flagged('dataDir')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.dataDir!) }}</span>
              </div>
            </div>
          </details>
        </fieldset>

        <fieldset v-if="view.canAdd" class="pref-group">
          <legend>{{ S.preferences.workspaces }}</legend>
          <div class="pref-row">
            <input type="text" readonly :value="f.workspaces ?? view.defaultWorkspaces" :aria-label="S.preferences.whereNew" data-testid="pref-workspaces">
            <button type="button" data-testid="pref-workspaces-choose" @click="choose('workspaces')">{{ S.preferences.choose }}</button>
            <button type="button" @click="f.workspaces = null">{{ S.preferences.default }}</button>
          </div>
          <span v-if="flagged('workspaces')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.workspaces!) }}</span>
        </fieldset>

        <fieldset class="pref-group">
          <legend>{{ S.preferences.saving }}</legend>
          <details data-testid="pref-saving-advanced">
            <summary>{{ S.preferences.advanced }}</summary>
            <div class="pref-timing">
              <label for="pref-save-seconds">{{ S.preferences.saveSeconds }}</label>
              <input id="pref-save-seconds" v-model="f.saveSeconds" type="number" min="0.2" max="3600" step="0.1" :placeholder="String(view.defaults.saveSeconds)" data-testid="pref-save-seconds">
              <label for="pref-version-seconds">{{ S.preferences.versionSeconds }}</label>
              <input id="pref-version-seconds" v-model="f.versionSeconds" type="number" min="1" max="3600" step="1" :placeholder="String(view.defaults.versionSeconds)" data-testid="pref-version-seconds">
            </div>
            <span v-if="flagged('saveSeconds') || flagged('versionSeconds')" class="pref-hint flag">{{ S.preferences.fromFlag(`${FLAGS.saveSeconds} / ${FLAGS.versionSeconds}`) }}</span>
          </details>
        </fieldset>

        <p class="pref-note">{{ S.preferences.restarts }}</p>
      </template>
      <div v-if="error" class="components-error" role="alert" data-testid="pref-error">{{ error }}</div>
      <div class="modal-actions">
        <button type="button" :disabled="busy" @click="emit('close')">{{ S.common.cancel }}</button>
        <button type="submit" class="primary" data-testid="pref-save" :disabled="!view || busy">{{ busy ? S.preferences.savingNow : S.common.save }}</button>
      </div>
    </form>
    <FolderPicker v-if="picking" :hub="hub" :title="picking.title" :start="picking.start" @chosen="(p) => chosen(picking!.purpose, p)" @cancel="picking = null" />
  </div>
</template>
