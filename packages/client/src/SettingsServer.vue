<script setup lang="ts">
// Settings › Server (decision 0064): the server this app works with, for
// everyone using it and every workspace on it.
//
// - Its settings (the host's settings.ts), the same in a browser and in the
//   desktop app (0047), changed only by its owner: the ones most people need in
//   view, the others under Advanced; a setting a flag overrides says so.
//   Applying them reopens every workspace (writing and committing first), then
//   the page reloads, so the window applies them once, as it closes (save); a
//   value that is wrong is refused, saying what (0063).
// - Its components, every one it has: the engines and environments (set by
//   whoever runs it, with flags: here only shown), the document formats (turned
//   on and off above, by its owner), the tools it downloads (TeX, decision 0045),
//   which anyone may download where it allows installs, and its syncs (the online
//   copy, 0059), each with its settings for the open workspace in a subpanel.
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import type { ComponentsInfo, HostApi, HubApi, HubSettings, SettingsView, SyncInfo, ToolInfo, ToolsInfo } from './api.js';
import type { FolderPurpose, Shell } from './shell.js';
import { megabytes } from './labels.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';
import FolderPicker from './FolderPicker.vue';
import SubpanelLink from './SubpanelLink.vue';
import SyncsSection from './SyncsSection.vue';

const props = defineProps<{
  hub: HubApi;
  api: HostApi;
  shell: Shell;
  /** Its settings may be changed here (its owner, decision 0047). */
  canChangeSettings: boolean;
  /** Why they cannot be, if they cannot. */
  ownerOff: string | null;
  /** Goes up when the host says a tool changed. */
  toolsKey?: number;
  /** The open workspace's name: a sync's settings are that workspace's. */
  workspaceName: string | null;
}>();
const emit = defineEmits<{ saved: [] }>();

/** The flag that sets each setting, said where a flag overrides it. */
const FLAGS: Partial<Record<keyof HubSettings, string>> = {
  bootstrap: '--bootstrap', relays: '--relay', formats: '--format', runCode: '--engine', environment: '--env',
  allowInstalls: '--allow-installs', memory: '--memory', cpus: '--cpus', disk: '--disk', allowWrite: '--allow-write',
  allowNetwork: '--allow-network', rImages: '--r-image', dataDir: '--data-dir', workspaces: '--workspaces',
  saveSeconds: '--flush-ms', versionSeconds: '--commit-ms',
};

// Syncs (the online copy): listed with the components; each one's settings, for the open workspace, in a subpanel.
const syncs = shallowRef<SyncInfo[]>([]);
watch(() => props.api, (api) => {
  syncs.value = [];
  api.syncs().then((r) => {
    if (api === props.api) syncs.value = r.syncs;
  }, () => undefined);
}, { immediate: true });
/** The sync whose settings show, if any. */
const sub = ref<string | null>(null);
const subSync = computed(() => syncs.value.find((x) => x.id === sub.value) ?? null);

const view = shallowRef<SettingsView | null>(null);
const loadError = shallowRef<unknown>(null);
const error = ref('');
const busy = ref(false);
const f = reactive({
  bootstrap: '', relays: '', runCode: true, environment: '', allowInstalls: true,
  memory: '', cpus: '', disk: '', allowWrite: false, allowNetwork: false, rImages: '',
  dataDir: null as string | null, workspaces: null as string | null, saveSeconds: '', versionSeconds: '',
  formats: [] as string[],
});
/** The settings as loaded: changed since, they are applied as the window closes. */
let loaded = '';

if (props.canChangeSettings) props.hub.settings().then((v) => {
  const p = v.settings;
  Object.assign(f, {
    bootstrap: p.bootstrap.join('\n'), relays: p.relays.join('\n'), runCode: p.runCode, environment: p.environment ?? '',
    allowInstalls: p.allowInstalls, memory: p.memory ?? '', cpus: p.cpus === null ? '' : String(p.cpus), disk: p.disk ?? '',
    allowWrite: p.allowWrite, allowNetwork: p.allowNetwork, rImages: p.rImages.join('\n'), dataDir: p.dataDir, workspaces: p.workspaces,
    saveSeconds: p.saveSeconds === null ? '' : String(p.saveSeconds), versionSeconds: p.versionSeconds === null ? '' : String(p.versionSeconds),
    // Kinds of documents: each one the app has, on unless the settings name others.
    formats: v.formats.filter((x) => !p.formats || p.formats.includes(x.id)).map((x) => x.id),
  });
  loaded = JSON.stringify(f);
  view.value = v;
}, (e: unknown) => {
  loadError.value = e;
});

const changed = computed(() => !!view.value && JSON.stringify(f) !== loaded);

const flagged = (key: keyof HubSettings) => !!view.value?.fromFlags.includes(key);
/** Where code runs, as the section says it: the chosen environment, else the first. */
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

/** Apply the settings (reopening every workspace, and reloading the page); false if refused. */
async function save(): Promise<boolean> {
  if (!view.value || busy.value) return false;
  error.value = '';
  busy.value = true;
  try {
    await props.hub.saveSettings({
      bootstrap: lines(f.bootstrap),
      relays: lines(f.relays),
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
    return true;
  } catch (e) {
    error.value = S.preferences.couldNotSave((e as Error).message);
    busy.value = false;
    return false;
  }
}

// What it runs: its components, and the tools it downloads.
const components = shallowRef<ComponentsInfo | null>(null);
const componentsError = shallowRef<unknown>(null);
props.api.components().then((p) => (components.value = p), (e: unknown) => (componentsError.value = e));
const title = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
/** An environment's name, without a '(not sandboxed)' its label may carry: that is shown apart. */
const envName = (label: string) => title(label.replace(/\s*\(not sandboxed\)\s*$/i, ''));

const tools = shallowRef<ToolsInfo | null>(null);
const toolError = shallowRef<unknown>(null);
let timer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(timer));
const toolBusy = (t: ToolInfo) => t.state === 'downloading' || t.state === 'adding' || t.state === 'removing';

/** How the tools stand; followed while one is being downloaded or removed. */
async function loadTools() {
  clearTimeout(timer);
  try {
    tools.value = await props.api.tools();
    if (tools.value.tools.some(toolBusy)) timer = setTimeout(() => void loadTools(), 700);
  } catch (e) {
    toolError.value = e;
  }
}
void loadTools();
watch(() => props.toolsKey, () => void loadTools());

async function toolAction(t: ToolInfo, action: 'download' | 'remove') {
  toolError.value = null;
  try {
    await (action === 'download' ? props.api.downloadTool(t.id) : props.api.removeTool(t.id));
  } catch (e) {
    toolError.value = e;
  }
  await loadTools();
}

const toolStatus = (t: ToolInfo) => {
  if (toolBusy(t)) return t.progress ?? S.components.toolBusy[t.state]!;
  if (t.state === 'ready') return S.components.toolReady(megabytes(t.size ?? 0)) + (t.parts ? S.components.toolParts(t.parts.added, t.parts.label) : '');
  return S.components.toolSize(megabytes(t.downloadBytes));
};

defineExpose({ changed, save, busy, picking });
</script>

<template>
  <div class="settings-server">
    <template v-if="sub">
      <div class="subpanel-head">
        <button type="button" class="subpanel-back" data-testid="subpanel-back" @click="sub = null">{{ S.person.back(S.sections.server) }}</button>
        <h4 data-testid="subpanel-title">{{ subSync?.label ?? '' }}</h4>
      </div>
      <section class="settings-part" :data-testid="`subpanel-sync:${sub}`">
        <p class="pref-note">{{ S.components.syncFor(workspaceName ?? '') }}</p>
        <SyncsSection :api="api" :only="sub" />
      </section>
    </template>
    <div v-show="!sub">
    <section v-if="canChangeSettings" class="settings-part">
      <form data-testid="preferences" novalidate @submit.prevent>
        <ErrorBanner v-if="loadError" :error="loadError" inline />
        <p v-if="!view && !loadError" class="muted">{{ S.common.loading }}</p>
        <template v-if="view">
          <fieldset class="pref-group">
            <legend>{{ S.preferences.network }}</legend>
            <p class="pref-note" data-testid="pref-sync">{{ S.preferences.syncHint }}</p>
            <details data-testid="pref-network-advanced">
              <summary>{{ S.preferences.advanced }}</summary>
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
        </template>
        <div v-if="error" class="components-error" role="alert" data-testid="pref-error">{{ error }}</div>
      </form>
    </section>
    <p v-else-if="ownerOff" class="pref-note" data-testid="settings-owner-off">{{ ownerOff }}</p>

    <!-- What it runs: shown to everyone; set by whoever runs it. -->
    <section class="settings-part" data-testid="components">
      <ErrorBanner v-if="componentsError" :error="componentsError" inline />
      <template v-if="components">
        <fieldset class="pref-group" data-testid="components-run">
          <legend>{{ S.sections.components }}</legend>
          <h4>{{ S.sections.engines }}</h4>
          <label v-for="e in components.engines" :key="e.id" class="component">
            <input type="checkbox" :checked="e.on" disabled :aria-label="e.label">
            <span class="component-text">
              <span class="component-name">{{ e.label }}</span>
              <span class="component-about">{{ e.description }}</span>
            </span>
          </label>
          <h4>{{ S.components.where }}</h4>
          <label v-for="e in components.environments" :key="e.id" class="component" :data-testid="`environment:${e.id}`">
            <input type="checkbox" :checked="e.on" disabled :aria-label="envName(e.label)">
            <span class="component-text">
              <span class="component-name">{{ envName(e.label) }}<span v-if="!e.sandboxed" class="component-warn">{{ S.components.notSandboxed }}</span></span>
              <span class="component-about">{{ e.description }}</span>
              <span v-if="e.on && !e.available" class="component-about component-unavailable">{{ S.components.unavailable(e.message) }}</span>
            </span>
          </label>
          <p v-if="!components.environments.length" class="muted components-note">{{ S.components.noEnvironment }}</p>
          <p class="muted components-note">{{ S.components.setBy }}</p>
          <details class="components-note">
            <summary>{{ S.common.details }}</summary>
            <span class="muted">{{ S.components.flags }}</span>
          </details>
        </fieldset>

        <!-- Which are on: its owner turns them on and off above. -->
        <div class="pref-group" data-testid="components-formats">
          <h4>{{ S.components.formats }}</h4>
          <label v-for="t in components.formats" :key="t.id" class="component">
            <!-- Its owner's checkboxes are above: here, only whether each is on. -->
            <span v-if="canChangeSettings" :class="['component-state', { on: t.on }]">{{ t.on ? S.components.on : S.components.off }}</span>
            <input v-else type="checkbox" :checked="t.on" disabled :aria-label="t.label">
            <span class="component-text">
              <span class="component-name">{{ t.label }}</span>
              <span class="component-about">{{ t.description || S.components.files(t.extensions.join(', ')) }}</span>
            </span>
          </label>
          <p class="muted components-note">{{ S.components.formatOff }}</p>
        </div>
      </template>

      <div v-if="tools?.tools.length" class="pref-group" data-testid="components-tools">
        <h4>{{ S.components.tools }}</h4>
        <p class="muted components-note">{{ S.components.toolsAbout }}</p>
        <ErrorBanner v-if="toolError" :error="toolError" inline />
        <div v-for="t in tools.tools" :key="t.id" class="component tool" :data-testid="`tool:${t.id}`">
          <span class="component-text">
            <span class="component-name">{{ t.label }}</span>
            <span class="component-about">{{ t.description }}</span>
            <span class="component-about" role="status" :data-testid="`tool-status:${t.id}`">{{ toolStatus(t) }}</span>
            <span v-if="t.unavailable" class="component-about component-unavailable">{{ t.unavailable }}</span>
            <span v-else-if="t.note" class="component-about">{{ t.note }}</span>
            <span v-if="t.error && !toolBusy(t)" class="component-about component-unavailable">{{ S.components.failed(t.error) }}</span>
          </span>
          <span v-if="tools.allowInstalls" class="tool-actions">
            <button
              v-if="t.state === 'absent' || t.state === 'downloading'"
              type="button"
              :disabled="toolBusy(t) || !!t.unavailable"
              :title="S.components.downloadTitle(t.label, megabytes(t.downloadBytes))"
              :data-testid="`tool-download:${t.id}`"
              @click="toolAction(t, 'download')"
            >{{ S.components.download }}</button>
            <button
              v-else
              type="button"
              :disabled="toolBusy(t)"
              :title="S.components.removeTitle(t.label)"
              :data-testid="`tool-remove:${t.id}`"
              @click="toolAction(t, 'remove')"
            >{{ S.components.remove }}</button>
          </span>
        </div>
        <p v-if="!tools.allowInstalls" class="muted components-note">{{ S.components.toolsOff }}</p>
      </div>

      <!-- Syncs (0059): where a workspace keeps a copy beyond its devices; each one's settings are the open workspace's. -->
      <div v-if="syncs.length" class="pref-group" data-testid="components-syncs">
        <h4>{{ S.components.syncs }}</h4>
        <div v-for="x in syncs" :key="x.id" class="component tool" :data-testid="`component-sync:${x.id}`">
          <span class="component-text">
            <span class="component-name">{{ x.label }}</span>
            <span class="component-about">{{ x.description }}</span>
            <span class="component-about">{{ x.targets.length ? S.components.syncTargets(x.targets.map((t) => t.url)) : S.components.syncNone }}</span>
          </span>
          <span class="tool-actions">
            <SubpanelLink
              class="inline"
              :title="S.components.syncSettings"
              :testid="`sync-settings:${x.id}`"
              :disabled="!workspaceName"
              @open="sub = x.id"
            />
          </span>
        </div>
        <p v-if="!workspaceName" class="muted components-note">{{ S.components.syncNoWorkspace }}</p>
      </div>
    </section>
    </div>
    <FolderPicker v-if="picking" :hub="hub" :title="picking.title" :start="picking.start" @chosen="(p) => chosen(picking!.purpose, p)" @cancel="picking = null" />
  </div>
</template>
