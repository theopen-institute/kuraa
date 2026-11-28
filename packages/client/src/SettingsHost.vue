<script setup lang="ts">
// Settings › Host (decisions 0064, 0083, 0084): how the host program itself
// works, for everyone using it and every workspace on it: other computers,
// running code's limits and permissions, new workspaces, saving. Its owner's to
// change (0047), the ones most people need in view and the others under
// Advanced; a setting a flag overrides says so. What the host can do, its
// components, is Settings › Components, beneath it in the window's list.
//
// The owner's changes, here and in Components (one form, hostSettings.ts), are
// applied once, as the window closes: every workspace reopens (writing and
// committing first), then the page reloads; a value that is wrong is refused,
// saying what (0063).
import { shallowRef } from 'vue';
import type { HubApi } from './api.js';
import type { FolderPurpose, Shell } from './shell.js';
import { FLAGS, type HostSettingsForm } from './hostSettings.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';
import FolderPicker from './FolderPicker.vue';

const props = defineProps<{
  hub: HubApi;
  shell: Shell;
  /** The host's settings, as its owner changes them (shared with Settings › Components). */
  form: HostSettingsForm;
  /** Its settings may be changed here (its owner, decision 0047). */
  canChangeSettings: boolean;
  /** Why they cannot be, if they cannot. */
  ownerOff: string | null;
}>();
const { view, loadError, error, f, editable, flagged } = props.form;

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

defineExpose({ picking });
</script>

<template>
  <div class="settings-host">
    <form :data-testid="canChangeSettings ? 'preferences' : undefined" novalidate @submit.prevent>
      <div v-if="error" class="components-error" role="alert" data-testid="pref-error">{{ error }}</div>
      <section class="settings-part" data-testid="host-settings">
        <p v-if="!canChangeSettings" class="pref-note" data-testid="settings-owner-off">{{ ownerOff ?? S.preferences.notYours }}</p>
        <template v-if="canChangeSettings">
          <ErrorBanner v-if="loadError" :error="loadError" inline />
          <p v-if="!view && !loadError" class="muted">{{ S.common.loading }}</p>
        </template>
        <template v-if="editable && view">
          <fieldset class="pref-group">
            <legend>{{ S.preferences.network }}</legend>
            <p class="pref-note" data-testid="pref-sync">{{ S.preferences.syncHint }}</p>
            <details data-testid="pref-network-advanced">
              <summary>{{ S.preferences.advanced }}</summary>
              <div>
                <div>
                  <label for="pref-bootstrap" class="pref-note">{{ S.preferences.bootstrap }}</label>
                  <textarea id="pref-bootstrap" v-model="f.bootstrap" data-testid="pref-bootstrap" spellcheck="false" placeholder="node.example.org:49737" />
                  <span v-if="flagged('bootstrap')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.bootstrap!) }}</span>
                </div>
                <div>
                  <label for="pref-relays" class="pref-note">{{ S.preferences.relays }}</label>
                  <textarea id="pref-relays" v-model="f.relays" data-testid="pref-relays" spellcheck="false" />
                  <span v-if="flagged('relays')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.relays!) }}</span>
                </div>
              </div>
            </details>
          </fieldset>

          <fieldset class="pref-group">
            <legend>{{ S.preferences.running }}</legend>
            <label class="pref-check"><input v-model="f.allowInstalls" type="checkbox" data-testid="pref-installs"> {{ S.preferences.installs }}
              <span class="pref-hint">{{ S.preferences.installsHint }}</span>
              <span v-if="flagged('allowInstalls')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.allowInstalls!) }}</span>
            </label>
            <label class="pref-check"><input v-model="f.renderWhereCodeRuns" type="checkbox" data-testid="pref-render-where-code-runs"> {{ S.preferences.renderWhereCodeRuns }}
              <span class="pref-hint">{{ S.preferences.renderWhereCodeRunsHint }}</span>
              <span v-if="flagged('renderWhereCodeRuns')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.renderWhereCodeRuns!) }}</span>
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
        </template>
      </section>
    </form>
    <FolderPicker v-if="picking" :hub="hub" :title="picking.title" :start="picking.start" @chosen="(p) => chosen(picking!.purpose, p)" @cancel="picking = null" />
  </div>
</template>
