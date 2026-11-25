<script setup lang="ts">
// Settings › Host (decisions 0064, 0083): the host this app works with, for
// everyone using it and every workspace on it, in two parts kept apart.
//
// - Components: every one it has, grouped by kind (document formats, features,
//   languages, environments, tools, syncs), each kind saying what it is, with
//   its switches beside it: a format or feature on or off and running code (its
//   owner's), downloading a tool (anyone's, where the host allows installs), a
//   sync's settings for the open workspace (in a subpanel). Which components it
//   has is decided as it starts (--component); what its owner cannot change here
//   is shown, not offered.
// - Host settings: how the host program itself works (other computers, limits
//   and permissions for running code, new workspaces, saving), its owner's to
//   change (0047), the ones most people need in view and the others under
//   Advanced; a setting a flag overrides says so.
//
// The owner's changes, in either part, are applied once, as the window closes
// (save): every workspace reopens (writing and committing first), then the page
// reloads; a value that is wrong is refused, saying what (0063).
import { computed, onBeforeUnmount, reactive, ref, shallowRef, watch } from 'vue';
import type { FeatureStatus } from '@kuraa/feature-kit/client';
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
  /** Features (0082) as the open workspace's host has them: which the host has on, shown to everyone. */
  features?: FeatureStatus[];
}>();
const emit = defineEmits<{ saved: [] }>();

/** The flag that sets each setting, said where a flag overrides it. */
const FLAGS: Partial<Record<keyof HubSettings, string>> = {
  bootstrap: '--bootstrap', relays: '--relay', formats: '--format', features: '--feature', runCode: '--engine', environment: '--env',
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
  features: [] as string[],
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
    // Features (0082): each one the host has, on unless the settings name others.
    features: (v.features ?? []).filter((x) => !p.features || p.features.includes(x.id)).map((x) => x.id),
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
      features: f.features.length === (view.value.features ?? []).length ? null : (view.value.features ?? []).filter((x) => f.features.includes(x.id)).map((x) => x.id),
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

// The components, by kind. Where its owner may switch one here (formats, features), it shows as switched; else as it is now.
const editable = computed(() => props.canChangeSettings && !!view.value);
const formatRows = computed(() => components.value?.formats
  ?? view.value?.formats.map((x) => ({ ...x, description: '', extensions: [] as string[], on: true }))
  ?? []);
const formatOn = (t: { id: string; on: boolean }) => (editable.value ? f.formats.includes(t.id) : t.on);
/** Its owner's: the features the host has, as its settings will have them; anyone else's: whether the host has each on. */
const featureRows = computed(() => (editable.value
  ? (view.value!.features ?? []).map((x) => ({ id: x.id, label: x.label, description: x.description, on: true }))
  : (props.features ?? []).map((x) => ({ id: x.id, label: x.label, description: x.description, on: x.host }))));
const featureOn = (x: { id: string; on: boolean }) => (editable.value ? f.features.includes(x.id) : x.on);
const inUse = computed(() => components.value?.environments.find((e) => e.on) ?? null);

type Kind = 'formats' | 'features' | 'engines' | 'environments' | 'tools' | 'syncs';
/** Each kind the host has any of, with how many, for the row of kinds at the top. */
const kinds = computed(() => {
  const c = components.value;
  const all: [Kind, number][] = [
    ['formats', formatRows.value.length],
    ['features', featureRows.value.length],
    ['engines', c?.engines.length ?? 0],
    ['environments', c?.environments.length ?? 0],
    ['tools', tools.value?.tools.length ?? 0],
    ['syncs', syncs.value.length],
  ];
  return all.filter(([, n]) => n > 0).map(([id, n]) => ({ id, n, label: S.components.kinds[id] }));
});
const root = ref<HTMLElement | null>(null);
function goTo(kind: Kind) {
  root.value?.querySelector(`[data-kind="${kind}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

defineExpose({ changed, save, busy, picking });
</script>


<template>
  <div ref="root" class="settings-host">
    <template v-if="sub">
      <div class="subpanel-head">
        <button type="button" class="subpanel-back" data-testid="subpanel-back" @click="sub = null">{{ S.person.back(S.sections.host) }}</button>
        <h4 data-testid="subpanel-title">{{ subSync?.label ?? '' }}</h4>
      </div>
      <section class="settings-part" :data-testid="`subpanel-sync:${sub}`">
        <p class="pref-note">{{ S.components.syncFor(workspaceName ?? '') }}</p>
        <SyncsSection :api="api" :only="sub" />
      </section>
    </template>
    <!-- One form, its owner's: the switches beside the components and the host's settings beneath are applied together, as the window closes. -->
    <form v-show="!sub" :data-testid="canChangeSettings ? 'preferences' : undefined" novalidate @submit.prevent>
      <div v-if="error" class="components-error" role="alert" data-testid="pref-error">{{ error }}</div>

      <!-- Components: every one the host has, by kind, each kind's switches with it. -->
      <section class="settings-part host-part" data-testid="components">
        <header class="host-part-head">
          <h3>{{ S.components.title }}</h3>
          <p class="pref-note">{{ S.components.about }}</p>
        </header>
        <ErrorBanner v-if="componentsError" :error="componentsError" inline />
        <nav v-if="kinds.length" class="component-kinds" :aria-label="S.components.kindsLabel" data-testid="component-kinds">
          <button v-for="k in kinds" :key="k.id" type="button" class="component-kind-chip" :data-testid="`kind:${k.id}`" @click="goTo(k.id)">
            {{ k.label }} <span class="component-kind-n">{{ k.n }}</span>
          </button>
        </nav>

        <div v-if="formatRows.length" class="component-kind" data-kind="formats" data-testid="components-formats">
          <div class="component-kind-head">
            <h4>{{ S.components.kinds.formats }}</h4>
            <span class="component-kind-state">{{ S.components.onOf(formatRows.filter(formatOn).length, formatRows.length) }}</span>
          </div>
          <p class="component-kind-about">{{ S.components.kindAbout.formats }}</p>
          <div class="component-list" :data-testid="editable ? 'pref-formats' : undefined">
            <label v-for="t in formatRows" :key="t.id" class="component">
              <input v-if="editable" v-model="f.formats" type="checkbox" :value="t.id" :aria-label="t.label" :data-testid="`pref-format-${t.id}`">
              <input v-else type="checkbox" :checked="t.on" disabled :aria-label="t.label">
              <span class="component-text">
                <span class="component-name">{{ t.label }}</span>
                <span class="component-about">{{ t.description || S.components.files(t.extensions.join(', ')) }}</span>
              </span>
            </label>
          </div>
          <span v-if="flagged('formats')" class="pref-note flag">{{ S.preferences.fromFlag(FLAGS.formats!) }}</span>
        </div>

        <div v-if="featureRows.length" class="component-kind" data-kind="features" data-testid="components-features">
          <div class="component-kind-head">
            <h4>{{ S.components.kinds.features }}</h4>
            <span class="component-kind-state">{{ S.components.onOf(featureRows.filter(featureOn).length, featureRows.length) }}</span>
          </div>
          <p class="component-kind-about">{{ S.components.kindAbout.features }}</p>
          <div class="component-list" :data-testid="editable ? 'pref-features' : undefined">
            <label v-for="x in featureRows" :key="x.id" class="component">
              <input v-if="editable" v-model="f.features" type="checkbox" :value="x.id" :aria-label="x.label" :data-testid="`pref-feature-${x.id}`">
              <input v-else type="checkbox" :checked="x.on" disabled :aria-label="x.label">
              <span class="component-text">
                <span class="component-name">{{ x.label }}</span>
                <span v-if="x.description" class="component-about">{{ x.description }}</span>
              </span>
            </label>
          </div>
          <span v-if="flagged('features')" class="pref-note flag">{{ S.preferences.fromFlag(FLAGS.features!) }}</span>
        </div>

        <template v-if="components">
          <div class="component-kind" data-kind="engines" data-testid="components-run">
            <div class="component-kind-head">
              <h4>{{ S.components.kinds.engines }}</h4>
              <span class="component-kind-state">{{ S.components.onOf(components.engines.filter((e) => e.on).length, components.engines.length) }}</span>
            </div>
            <p class="component-kind-about">{{ S.components.kindAbout.engines }}</p>
            <!-- Its owner's switch: whether documents' code runs at all. -->
            <div v-if="editable" class="component-switches">
              <label class="pref-check"><input v-model="f.runCode" type="checkbox" data-testid="pref-run"> {{ S.preferences.run }}
                <span :class="['pref-status', shownEnvironment ? (shownEnvironment.available ? 'ok' : 'no') : '']" data-testid="pref-environments">
                  {{ shownEnvironment ? (shownEnvironment.available ? S.preferences.runsIn(shownEnvironment.label) : shownEnvironment.message) : S.preferences.noEnvironment }}
                </span>
                <span v-if="flagged('runCode')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.runCode!) }}</span>
              </label>
            </div>
            <div class="component-list">
              <label v-for="e in components.engines" :key="e.id" class="component">
                <input type="checkbox" :checked="e.on" disabled :aria-label="e.label">
                <span class="component-text">
                  <span class="component-name">{{ e.label }}</span>
                  <span class="component-about">{{ e.description }}</span>
                </span>
              </label>
            </div>
          </div>

          <div class="component-kind" data-kind="environments" data-testid="components-environments">
            <div class="component-kind-head">
              <h4>{{ S.components.kinds.environments }}</h4>
              <span class="component-kind-state">{{ S.components.inUse(inUse ? envName(inUse.label) : null) }}</span>
            </div>
            <p class="component-kind-about">{{ S.components.kindAbout.environments }}</p>
            <!-- Its owner's choice of one: only when there is one to make. -->
            <div v-if="editable && view!.environments.length > 1" class="component-switches">
              <label class="field">
                <span>{{ S.preferences.where }}</span>
                <select v-model="f.environment" data-testid="pref-environment">
                  <option value="">{{ S.preferences.onlyOne }}</option>
                  <option v-for="e in view!.environments" :key="e.id" :value="e.id">{{ e.label }}</option>
                </select>
                <span v-if="flagged('environment')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.environment!) }}</span>
              </label>
            </div>
            <div class="component-list">
              <label v-for="e in components.environments" :key="e.id" class="component" :data-testid="`environment:${e.id}`">
                <input type="checkbox" :checked="e.on" disabled :aria-label="envName(e.label)">
                <span class="component-text">
                  <span class="component-name">{{ envName(e.label) }}<span v-if="!e.sandboxed" class="component-warn">{{ S.components.notSandboxed }}</span></span>
                  <span class="component-about">{{ e.description }}</span>
                  <span v-if="e.on && !e.available" class="component-about component-unavailable">{{ S.components.unavailable(e.message) }}</span>
                </span>
              </label>
            </div>
            <p v-if="!components.environments.length" class="muted components-note">{{ S.components.noEnvironment }}</p>
          </div>
        </template>

        <div v-if="tools?.tools.length" class="component-kind" data-kind="tools" data-testid="components-tools">
          <div class="component-kind-head">
            <h4>{{ S.components.kinds.tools }}</h4>
            <span class="component-kind-state">{{ S.components.downloadedOf(tools.tools.filter((t) => t.state === 'ready' || t.state === 'adding').length, tools.tools.length) }}</span>
          </div>
          <p class="component-kind-about">{{ S.components.kindAbout.tools }}</p>
          <ErrorBanner v-if="toolError" :error="toolError" inline />
          <div class="component-list">
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
          </div>
          <p v-if="!tools.allowInstalls" class="muted components-note">{{ S.components.toolsOff }}</p>
        </div>

        <!-- Syncs (0059): each one's settings are the open workspace's, in a subpanel. -->
        <div v-if="syncs.length" class="component-kind" data-kind="syncs" data-testid="components-syncs">
          <div class="component-kind-head">
            <h4>{{ S.components.kinds.syncs }}</h4>
          </div>
          <p class="component-kind-about">{{ S.components.kindAbout.syncs }}</p>
          <div class="component-list">
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
          </div>
          <p v-if="!workspaceName" class="muted components-note">{{ S.components.syncNoWorkspace }}</p>
        </div>

        <div class="components-note">
          <span class="muted">{{ canChangeSettings ? S.components.ownerSets : S.components.setBy }}</span>
          <details>
            <summary>{{ S.common.details }}</summary>
            <span class="muted">{{ S.components.flags }}</span>
          </details>
        </div>
      </section>

      <!-- Host settings: how the host program itself works; its owner's to change. -->
      <section class="settings-part host-part" data-testid="host-settings">
        <header class="host-part-head">
          <h3>{{ S.preferences.hostSettings }}</h3>
          <p class="pref-note">{{ S.preferences.hostSettingsAbout }}</p>
        </header>
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
