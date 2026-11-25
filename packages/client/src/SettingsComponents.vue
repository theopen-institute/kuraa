<script setup lang="ts">
// Settings › Components (decisions 0083, 0084): every component the host has,
// grouped by kind (document formats, features, languages, environments, tools,
// syncs), each kind saying what it is, with its switches beside it: a format or
// feature on or off and running code (the host's owner's, in the host's
// settings, shared with Settings › Host and applied with them as the window
// closes), downloading a tool (anyone's, where the host allows installs), a
// sync's settings for the open workspace (in a subpanel). Which components the
// host has is decided as it starts (--component); what its owner cannot change
// here is shown, not offered. Under Host in the window's list: they are the
// host's, for everyone using it.
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { FeatureStatus } from '@kuraa/feature-kit/client';
import type { ComponentsInfo, HostApi, SyncInfo, ToolInfo, ToolsInfo } from './api.js';
import { FLAGS, type HostSettingsForm } from './hostSettings.js';
import { megabytes } from './labels.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';
import SubpanelLink from './SubpanelLink.vue';
import SyncsSection from './SyncsSection.vue';

const props = defineProps<{
  api: HostApi;
  /** The host's settings, as its owner changes them (shared with Settings › Host). */
  form: HostSettingsForm;
  /** The host's settings may be changed here (its owner, decision 0047). */
  canChangeSettings: boolean;
  /** Goes up when the host says a tool changed. */
  toolsKey?: number;
  /** The open workspace's name: a sync's settings are that workspace's. */
  workspaceName: string | null;
  /** Features (0082) as the open workspace's host has them: which the host has on, shown to everyone. */
  features?: FeatureStatus[];
}>();
const { view, f, editable, flagged } = props.form;

// Syncs (the online copy): each one's settings, for the open workspace, in a subpanel.
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

/** Where code runs, as the section says it: the chosen environment, else the first. */
const shownEnvironment = computed(() => {
  const envs = view.value?.environments ?? [];
  return envs.find((e) => e.id === f.environment) ?? envs[0] ?? null;
});

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
</script>

<template>
  <div ref="root" class="settings-components">
    <template v-if="sub">
      <div class="subpanel-head">
        <button type="button" class="subpanel-back" data-testid="subpanel-back" @click="sub = null">{{ S.person.back(S.sections.components) }}</button>
        <h4 data-testid="subpanel-title">{{ subSync?.label ?? '' }}</h4>
      </div>
      <section class="settings-part" :data-testid="`subpanel-sync:${sub}`">
        <p class="pref-note">{{ S.components.syncFor(workspaceName ?? '') }}</p>
        <SyncsSection :api="api" :only="sub" />
      </section>
    </template>
    <!-- The owner's switches are the host's settings: applied with Settings › Host's, as the window closes. -->
    <form v-show="!sub" :data-testid="canChangeSettings ? 'preferences-components' : undefined" novalidate @submit.prevent>
      <section class="settings-part components-part" data-testid="components">
        <p class="pref-note">{{ S.components.about }}</p>
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

    </form>
  </div>
</template>
