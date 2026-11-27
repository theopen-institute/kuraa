<script setup lang="ts">
// Settings › Components (decisions 0083, 0084, 0095): every component, in one
// table, grouped by kind (document formats, features, languages, environments,
// tools, syncs), with a column for each level a component is switched at:
//
// - Host: on or off for everyone using the host, and every workspace on it (its
//   owner's, in the host's settings, shared with Settings › Host and applied with
//   them as the window closes); a tool's Download and Remove (anyone's, where the
//   host allows installs).
// - Workspace: on or off for everyone in the open workspace, saved in it at once
//   (a feature, by whoever may change its settings); a sync's settings for it.
// - You: on or off for you alone, in this browser (a format's editor, a feature
//   shown or hidden).
//
// A level a kind is not switched at shows a dash. A feature's own settings, for
// the workspace or for you, open in a subpanel from its row (or are drawn under
// it, where the feature says so); a sync's too. Which components the host has is
// decided as it starts (--component); what may not be changed here is shown, not
// offered. How many are available at the highest level this person switches
// them at is said to the window, for the list (`available`): to the host's owner,
// every one the host has; to whoever may change the workspace's settings, those
// on for the host; to anyone else, those on for them.
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue';
import type { FormatEditor } from '@kuraa/editor-kit';
import type { FeatureStatus } from '@kuraa/feature-kit/client';
import type { ComponentsInfo, HostApi, SyncInfo, ToolInfo, ToolsInfo } from './api.js';
import type { ActiveFeature } from './features.js';
import { FLAGS, type HostSettingsForm } from './hostSettings.js';
import { megabytes } from './labels.js';
import { S } from './strings.js';
import ErrorBanner from './ErrorBanner.vue';
import FeatureMount from './FeatureMount.vue';
import SyncsSection from './SyncsSection.vue';

const props = defineProps<{
  api: HostApi;
  /** The host's settings, as its owner changes them (shared with Settings › Host). */
  form: HostSettingsForm;
  /** The host's settings may be changed here (its owner, decision 0047). */
  canChangeSettings: boolean;
  /** Goes up when the host says a tool changed. */
  toolsKey?: number;
  /** The open workspace's name: the Workspace column is that workspace's. */
  workspaceName: string | null;
  /** Features (0082) as the open workspace's host has them: on the host, on for the workspace, who may change that. */
  features: FeatureStatus[];
  /** Every client half on for the workspace (hidden or not): for the You column and their parts of Settings. */
  featureParts: ActiveFeature[];
  /** The features you hid, in this browser. */
  hiddenFeatures: string[];
  /** Turn a feature on or off for the workspace (the app's: it goes through if Settings closes meanwhile). */
  turnFeature: (id: string, on: boolean) => Promise<void>;
  /** Every editor module, by format id, and the ones you turned off (in this browser). */
  editors: Record<string, FormatEditor>;
  editorsOff: string[];
}>();
export type ComponentsAvailable = { n: number; level: 'host' | 'workspace' | 'you' };
const emit = defineEmits<{ editorsOff: [ids: string[]]; hiddenFeatures: [ids: string[]]; available: [available: ComponentsAvailable | null] }>();
const { view, f, editable, flagged } = props.form;
const checked = (e: Event) => (e.target as HTMLInputElement).checked;

// ── Subpanels: a sync's settings for the workspace, a feature's for the workspace or for you.
type Sub = { kind: 'sync' | 'workspace' | 'you'; id: string };
const sub = ref<Sub | null>(null);
const subPart = computed(() => (sub.value && sub.value.kind !== 'sync' ? props.featureParts.find((p) => p.feature.id === sub.value!.id) ?? null : null));
const subPanel = computed(() => {
  const s = sub.value;
  const part = subPart.value;
  if (!s || !part) return null;
  const panel = s.kind === 'workspace' ? part.feature.settings?.workspace : s.kind === 'you' ? part.feature.settings?.you : undefined;
  return panel ? { label: panel.label, mount: (el: HTMLElement) => panel.mount(el, part.ctx) } : null;
});
// A subpanel whose feature went out of use (turned off meanwhile) closes.
watch(subPart, (p) => {
  if (sub.value && sub.value.kind !== 'sync' && !p) sub.value = null;
});

// ── Syncs (the online copy): each one's settings, for the open workspace.
const syncs = shallowRef<SyncInfo[]>([]);
watch(() => props.api, (api) => {
  syncs.value = [];
  api.syncs().then((r) => {
    if (api === props.api) syncs.value = r.syncs;
  }, () => undefined);
}, { immediate: true });
const subSync = computed(() => (sub.value?.kind === 'sync' ? syncs.value.find((x) => x.id === sub.value!.id) ?? null : null));
const subTitle = computed(() => subSync.value?.label ?? subPanel.value?.label ?? '');

// ── What the host runs: its components, and the tools it downloads.
const components = shallowRef<ComponentsInfo | null>(null);
const componentsError = shallowRef<unknown>(null);
props.api.components().then((p) => (components.value = p), (e: unknown) => (componentsError.value = e));
const title = (label: string) => label.charAt(0).toUpperCase() + label.slice(1);
/** An environment's name, without a '(not sandboxed)' its label may carry: that is shown apart. */
const envName = (label: string) => title(label.replace(/\s*\(not sandboxed\)\s*$/i, ''));
/** Where code runs, as the switch says it: the chosen environment, else the first. */
const shownEnvironment = computed(() => {
  const envs = view.value?.environments ?? [];
  return envs.find((e) => e.id === f.environment) ?? envs[0] ?? null;
});
const inUse = computed(() => components.value?.environments.find((e) => e.on) ?? null);

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

// ── Formats: on for the host (where its owner may switch one here, as switched; else as it is), and their editors, yours.
const formatRows = computed(() => components.value?.formats
  ?? view.value?.formats.map((x) => ({ ...x, description: '', extensions: [] as string[], on: true }))
  ?? []);
const formatOn = (t: { id: string; on: boolean }) => (editable.value ? f.formats.includes(t.id) : t.on);
function toggleEditor(id: string, on: boolean) {
  emit('editorsOff', on ? props.editorsOff.filter((x) => x !== id) : [...props.editorsOff, id]);
}

// ── Features: on for the host, for the workspace, and shown for you; each with its own settings, if it has them.
type FeatureRow = { id: string; label: string; description: string; host: boolean; status: FeatureStatus | null; part: ActiveFeature | null };
const featureRows = computed<FeatureRow[]>(() => {
  const byId = new Map(props.features.map((x) => [x.id, x]));
  const parts = new Map(props.featureParts.map((p) => [p.feature.id, p]));
  // Its owner's: every feature the host has, as its settings will have them; anyone else's: as the host has them now.
  const base = editable.value ? (view.value!.features ?? []).map((x) => ({ id: x.id, label: x.label, description: x.description })) : props.features;
  const rows = base.map((x) => ({ id: x.id, label: x.label, description: x.description, host: byId.get(x.id)?.host ?? true, status: byId.get(x.id) ?? null, part: parts.get(x.id) ?? null }));
  // Any the workspace knows of that the host's settings do not list (none, as things are): still shown.
  for (const x of props.features) if (!rows.some((r) => r.id === x.id)) rows.push({ id: x.id, label: x.label, description: x.description, host: x.host, status: x, part: parts.get(x.id) ?? null });
  return rows;
});
const featureOn = (x: FeatureRow) => (editable.value ? f.features.includes(x.id) : x.host);
const featureBusy = ref<string | null>(null);
const featureError = ref<string | null>(null);
async function setFeature(x: FeatureRow, on: boolean) {
  featureBusy.value = x.id;
  featureError.value = null;
  try {
    await props.turnFeature(x.id, on);
  } catch (e) {
    featureError.value = S.features.failed(x.label, (e as Error).message);
  } finally {
    featureBusy.value = null;
  }
}
function toggleShown(id: string, shown: boolean) {
  emit('hiddenFeatures', shown ? props.hiddenFeatures.filter((x) => x !== id) : [...props.hiddenFeatures, id]);
}
/** A feature's settings for the workspace drawn in its row instead of a subpanel: mounted once while it is on. */
const inlineMounts = computed(() => {
  const out = new Map<string, (el: HTMLElement) => () => void>();
  for (const part of props.featureParts) {
    const panel = part.feature.settings?.workspace;
    if (panel?.inline) out.set(part.feature.id, (el: HTMLElement) => panel.mount(el, part.ctx));
  }
  return out;
});

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
/** How many components are available at the highest level this person switches them at; null until the host has said. */
const available = computed<ComponentsAvailable | null>(() => {
  const c = components.value;
  if (!c) return null;
  if (editable.value) return { n: kinds.value.reduce((sum, k) => sum + k.n, 0), level: 'host' };
  // Beneath the host: what it has on (the environment in use; every tool and sync, each there when needed).
  const below = c.formats.filter((t) => t.on).length + c.engines.filter((e) => e.on).length
    + c.environments.filter((e) => e.on).length + (tools.value?.tools.length ?? 0) + syncs.value.length;
  if (props.workspaceName && props.features.some((x) => x.mayChange)) return { n: below + props.features.filter((x) => x.host).length, level: 'workspace' };
  return { n: below + props.features.filter((x) => x.on).length, level: 'you' };
});
watch(available, (a) => emit('available', a), { immediate: true });

const root = ref<HTMLElement | null>(null);
function goTo(kind: Kind) {
  root.value?.querySelector(`[data-kind="${kind}"]`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}
const L = S.components.levels;
</script>

<template>
  <div ref="root" class="settings-components">
    <template v-if="sub">
      <div class="subpanel-head">
        <button type="button" class="subpanel-back" data-testid="subpanel-back" @click="sub = null">{{ S.person.back(S.sections.components) }}</button>
        <h4 data-testid="subpanel-title">{{ subTitle }}</h4>
      </div>
      <section v-if="sub.kind === 'sync'" class="settings-part" :data-testid="`subpanel-sync:${sub.id}`">
        <p class="pref-note">{{ S.components.syncFor(workspaceName ?? '') }}</p>
        <SyncsSection :api="api" :only="sub.id" />
      </section>
      <section v-else-if="subPanel" class="settings-part" :data-testid="sub.kind === 'workspace' ? `feature-settings-${sub.id}` : `feature-you-${sub.id}`">
        <p class="pref-note">{{ sub.kind === 'workspace' ? S.components.featureSettingsFor(workspaceName ?? '') : S.components.featureSettingsYou }}</p>
        <FeatureMount :key="`${sub.kind}:${sub.id}`" :mount="subPanel.mount" />
      </section>
    </template>
    <!-- The owner's switches in the Host column are the host's settings: applied with Settings › Host's, as the window closes. -->
    <form v-show="!sub" :data-testid="canChangeSettings ? 'preferences-components' : undefined" novalidate @submit.prevent>
      <section class="settings-part components-part" data-testid="components">
        <ErrorBanner v-if="componentsError" :error="componentsError" inline />
        <nav v-if="kinds.length" class="component-kinds" :aria-label="S.components.kindsLabel" data-testid="component-kinds">
          <button v-for="k in kinds" :key="k.id" type="button" class="component-kind-chip" :data-testid="`kind:${k.id}`" @click="goTo(k.id)">
            {{ k.label }} <span class="component-kind-n">{{ k.n }}</span>
          </button>
        </nav>

        <table class="component-table">
          <thead>
            <tr>
              <th scope="col" class="component-col-name">{{ S.components.component }}</th>
              <th scope="col" :title="L.hostAbout"><span>{{ L.host }}</span><span class="component-col-about">{{ L.hostWho }}</span></th>
              <th scope="col" :title="L.workspaceAbout"><span>{{ L.workspace }}</span><span class="component-col-about">{{ L.workspaceWho }}</span></th>
              <th scope="col" :title="L.youAbout"><span>{{ L.you }}</span><span class="component-col-about">{{ L.youWho }}</span></th>
            </tr>
          </thead>

          <!-- Document formats: on for the host; their editor, yours. -->
          <tbody v-if="formatRows.length" data-kind="formats" data-testid="components-formats">
            <tr class="component-kind-row">
              <th colspan="4" scope="rowgroup">
                <div class="component-kind-head">
                  <h4>{{ S.components.kinds.formats }}</h4>
                  <span class="component-kind-state">{{ S.components.onOf(formatRows.filter(formatOn).length, formatRows.length) }}</span>
                </div>
                <p class="component-kind-about">{{ S.components.kindAbout.formats }}</p>
                <span v-if="flagged('formats')" class="pref-note flag">{{ S.preferences.fromFlag(FLAGS.formats!) }}</span>
              </th>
            </tr>
            <tr v-for="t in formatRows" :key="t.id" class="component-row" :data-testid="`component:format:${t.id}`">
              <td class="component-text">
                <span class="component-name">{{ t.label }}</span>
                <span class="component-about">{{ t.description || S.components.files(t.extensions.join(', ')) }}</span>
              </td>
              <td class="component-cell" :data-testid="editable ? 'pref-formats' : undefined">
                <input v-if="editable" v-model="f.formats" type="checkbox" :value="t.id" :aria-label="t.label" :data-testid="`pref-format-${t.id}`">
                <input v-else type="checkbox" :checked="t.on" disabled :aria-label="t.label">
              </td>
              <td class="component-cell"><span class="component-none" :title="L.notHere">–</span></td>
              <td class="component-cell">
                <input
                  v-if="editors[t.id]"
                  type="checkbox"
                  :checked="!editorsOff.includes(t.id)"
                  :aria-label="editors[t.id]!.label ?? t.label"
                  :title="S.components.editorTitle(editors[t.id]!.label ?? t.label, editors[t.id]!.description ?? '')"
                  :data-testid="`editor-${t.id}`"
                  @change="toggleEditor(t.id, checked($event))"
                >
                <span v-else class="component-none" :title="L.notHere">–</span>
              </td>
            </tr>
          </tbody>

          <!-- Features: on for the host, for the workspace, and shown for you. -->
          <tbody v-if="featureRows.length" data-kind="features" data-testid="components-features">
            <tr class="component-kind-row">
              <th colspan="4" scope="rowgroup">
                <div class="component-kind-head">
                  <h4>{{ S.components.kinds.features }}</h4>
                  <span class="component-kind-state">{{ S.components.onOf(featureRows.filter(featureOn).length, featureRows.length) }}</span>
                </div>
                <p class="component-kind-about">{{ S.components.kindAbout.features }}</p>
                <span v-if="flagged('features')" class="pref-note flag">{{ S.preferences.fromFlag(FLAGS.features!) }}</span>
              </th>
            </tr>
            <template v-for="x in featureRows" :key="x.id">
              <tr class="component-row" :data-testid="`component:feature:${x.id}`">
                <td class="component-text">
                  <span class="component-name">{{ x.label }}</span>
                  <span v-if="x.description" class="component-about">{{ x.description }}</span>
                  <span v-if="x.status?.workspace && !x.host" class="component-about component-unavailable">{{ S.components.featureOffOnHost }}</span>
                  <span v-if="x.part && (x.part.feature.settings?.workspace && !x.part.feature.settings.workspace.inline || x.part.feature.settings?.you)" class="component-links">
                    <button
                      v-if="x.part.feature.settings?.workspace && !x.part.feature.settings.workspace.inline"
                      type="button"
                      class="link"
                      :data-testid="`open-feature-${x.id}`"
                      @click="sub = { kind: 'workspace', id: x.id }"
                    >{{ x.part.feature.settings.workspace.label }} ›</button>
                    <button
                      v-if="x.part.feature.settings?.you"
                      type="button"
                      class="link"
                      :data-testid="`open-feature-you-${x.id}`"
                      @click="sub = { kind: 'you', id: x.id }"
                    >{{ x.part.feature.settings.you.label }} ›</button>
                  </span>
                </td>
                <td class="component-cell" :data-testid="editable ? 'pref-features' : undefined">
                  <input v-if="editable" v-model="f.features" type="checkbox" :value="x.id" :aria-label="x.label" :data-testid="`pref-feature-${x.id}`">
                  <input v-else type="checkbox" :checked="x.host" disabled :aria-label="x.label">
                </td>
                <td class="component-cell">
                  <input
                    v-if="x.status && workspaceName"
                    type="checkbox"
                    :checked="x.status.workspace"
                    :disabled="!x.status.mayChange || featureBusy !== null"
                    :aria-label="S.components.forLevel(x.label, L.workspace)"
                    :title="x.status.mayChange ? undefined : S.components.workspaceMayNot"
                    :data-testid="`feature-${x.id}`"
                    @change="setFeature(x, checked($event))"
                  >
                  <span v-else class="component-none" :title="workspaceName ? L.notHere : S.components.noWorkspace">–</span>
                </td>
                <td class="component-cell">
                  <input
                    v-if="x.status && workspaceName"
                    type="checkbox"
                    :checked="!hiddenFeatures.includes(x.id)"
                    :disabled="!x.part"
                    :aria-label="S.components.forLevel(x.label, L.you)"
                    :title="x.part ? undefined : S.components.shownWhenOn"
                    :data-testid="`feature-shown-${x.id}`"
                    @change="toggleShown(x.id, checked($event))"
                  >
                  <span v-else class="component-none" :title="workspaceName ? L.notHere : S.components.noWorkspace">–</span>
                </td>
              </tr>
              <tr v-if="x.status?.workspace && inlineMounts.get(x.id)" class="component-more">
                <td colspan="4">
                  <FeatureMount class="feature-inline" :mount="inlineMounts.get(x.id)!" :testid="`feature-inline-${x.id}`" />
                </td>
              </tr>
            </template>
            <tr v-if="featureError || (workspaceName && features.some((x) => !x.mayChange)) || !workspaceName" class="component-more">
              <td colspan="4">
                <p v-if="!workspaceName" class="muted components-note">{{ S.components.noWorkspace }}</p>
                <p v-else-if="features.some((x) => !x.mayChange)" class="muted components-note">{{ S.components.workspaceMayNot }}</p>
                <div v-if="featureError" class="components-error" role="alert">{{ featureError }}</div>
              </td>
            </tr>
          </tbody>

          <template v-if="components">
            <!-- Languages: loaded on the host; whether documents' code runs at all, its owner's switch for the kind. -->
            <tbody data-kind="engines" data-testid="components-run">
              <tr class="component-kind-row">
                <th colspan="4" scope="rowgroup">
                  <div class="component-kind-head">
                    <h4>{{ S.components.kinds.engines }}</h4>
                    <span class="component-kind-state">{{ S.components.onOf(components.engines.filter((e) => e.on).length, components.engines.length) }}</span>
                  </div>
                  <p class="component-kind-about">{{ S.components.kindAbout.engines }}</p>
                  <div v-if="editable" class="component-switches">
                    <label class="pref-check"><input v-model="f.runCode" type="checkbox" data-testid="pref-run"> {{ S.preferences.run }}
                      <span :class="['pref-status', shownEnvironment ? (shownEnvironment.available ? 'ok' : 'no') : '']" data-testid="pref-environments">
                        {{ shownEnvironment ? (shownEnvironment.available ? S.preferences.runsIn(shownEnvironment.label) : shownEnvironment.message) : S.preferences.noEnvironment }}
                      </span>
                      <span v-if="flagged('runCode')" class="pref-hint flag">{{ S.preferences.fromFlag(FLAGS.runCode!) }}</span>
                    </label>
                  </div>
                </th>
              </tr>
              <tr v-for="e in components.engines" :key="e.id" class="component-row">
                <td class="component-text">
                  <span class="component-name">{{ e.label }}</span>
                  <span class="component-about">{{ e.description }}</span>
                </td>
                <td class="component-cell"><input type="checkbox" :checked="e.on" disabled :aria-label="e.label"></td>
                <td class="component-cell"><span class="component-none" :title="L.notHere">–</span></td>
                <td class="component-cell"><span class="component-none" :title="L.notHere">–</span></td>
              </tr>
            </tbody>

            <!-- Environments: the one in use on the host; its owner's choice of one, where there is one to make. -->
            <tbody data-kind="environments" data-testid="components-environments">
              <tr class="component-kind-row">
                <th colspan="4" scope="rowgroup">
                  <div class="component-kind-head">
                    <h4>{{ S.components.kinds.environments }}</h4>
                    <span class="component-kind-state">{{ S.components.inUse(inUse ? envName(inUse.label) : null) }}</span>
                  </div>
                  <p class="component-kind-about">{{ S.components.kindAbout.environments }}</p>
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
                  <p v-if="!components.environments.length" class="muted components-note">{{ S.components.noEnvironment }}</p>
                </th>
              </tr>
              <tr v-for="e in components.environments" :key="e.id" class="component-row" :data-testid="`environment:${e.id}`">
                <td class="component-text">
                  <span class="component-name">{{ envName(e.label) }}<span v-if="!e.sandboxed" class="component-warn">{{ S.components.notSandboxed }}</span></span>
                  <span class="component-about">{{ e.description }}</span>
                  <span v-if="e.on && !e.available" class="component-about component-unavailable">{{ S.components.unavailable(e.message) }}</span>
                </td>
                <td class="component-cell"><input type="checkbox" :checked="e.on" disabled :aria-label="envName(e.label)"></td>
                <td class="component-cell"><span class="component-none" :title="L.notHere">–</span></td>
                <td class="component-cell"><span class="component-none" :title="L.notHere">–</span></td>
              </tr>
            </tbody>
          </template>

          <!-- Tools: downloaded to the host's computer, for every workspace on it. -->
          <tbody v-if="tools?.tools.length" data-kind="tools" data-testid="components-tools">
            <tr class="component-kind-row">
              <th colspan="4" scope="rowgroup">
                <div class="component-kind-head">
                  <h4>{{ S.components.kinds.tools }}</h4>
                  <span class="component-kind-state">{{ S.components.downloadedOf(tools.tools.filter((t) => t.state === 'ready' || t.state === 'adding').length, tools.tools.length) }}</span>
                </div>
                <p class="component-kind-about">{{ S.components.kindAbout.tools }}</p>
                <ErrorBanner v-if="toolError" :error="toolError" inline />
                <p v-if="!tools.allowInstalls" class="muted components-note">{{ S.components.toolsOff }}</p>
              </th>
            </tr>
            <tr v-for="t in tools.tools" :key="t.id" class="component-row" :data-testid="`tool:${t.id}`">
              <td class="component-text">
                <span class="component-name">{{ t.label }}</span>
                <span class="component-about">{{ t.description }}</span>
                <span class="component-about" role="status" :data-testid="`tool-status:${t.id}`">{{ toolStatus(t) }}</span>
                <span v-if="t.unavailable" class="component-about component-unavailable">{{ t.unavailable }}</span>
                <span v-else-if="t.note" class="component-about">{{ t.note }}</span>
                <span v-if="t.error && !toolBusy(t)" class="component-about component-unavailable">{{ S.components.failed(t.error) }}</span>
              </td>
              <td class="component-cell">
                <template v-if="tools.allowInstalls">
                  <button
                    v-if="t.state === 'absent' || t.state === 'downloading'"
                    type="button"
                    class="component-action"
                    :disabled="toolBusy(t) || !!t.unavailable"
                    :title="S.components.downloadTitle(t.label, megabytes(t.downloadBytes))"
                    :data-testid="`tool-download:${t.id}`"
                    @click="toolAction(t, 'download')"
                  >{{ S.components.download }}</button>
                  <button
                    v-else
                    type="button"
                    class="component-action"
                    :disabled="toolBusy(t)"
                    :title="S.components.removeTitle(t.label)"
                    :data-testid="`tool-remove:${t.id}`"
                    @click="toolAction(t, 'remove')"
                  >{{ S.components.remove }}</button>
                </template>
                <input v-else type="checkbox" :checked="t.state === 'ready'" disabled :aria-label="t.label">
              </td>
              <td class="component-cell"><span class="component-none" :title="L.notHere">–</span></td>
              <td class="component-cell"><span class="component-none" :title="L.notHere">–</span></td>
            </tr>
          </tbody>

          <!-- Syncs (0059): each one's settings are the open workspace's, in a subpanel. -->
          <tbody v-if="syncs.length" data-kind="syncs" data-testid="components-syncs">
            <tr class="component-kind-row">
              <th colspan="4" scope="rowgroup">
                <div class="component-kind-head">
                  <h4>{{ S.components.kinds.syncs }}</h4>
                </div>
                <p class="component-kind-about">{{ S.components.kindAbout.syncs }}</p>
              </th>
            </tr>
            <tr v-for="x in syncs" :key="x.id" class="component-row" :data-testid="`component-sync:${x.id}`">
              <td class="component-text">
                <span class="component-name">{{ x.label }}</span>
                <span class="component-about">{{ x.description }}</span>
                <span class="component-about">{{ x.targets.length ? S.components.syncTargets(x.targets.map((t) => t.url)) : S.components.syncNone }}</span>
              </td>
              <td class="component-cell"><span class="component-none" :title="L.notHere">–</span></td>
              <td class="component-cell">
                <button
                  type="button"
                  class="component-action"
                  :disabled="!workspaceName"
                  :title="workspaceName ? S.components.syncFor(workspaceName) : S.components.syncNoWorkspace"
                  :data-testid="`sync-settings:${x.id}`"
                  @click="sub = { kind: 'sync', id: x.id }"
                >{{ S.components.syncSettings }}</button>
              </td>
              <td class="component-cell"><span class="component-none" :title="L.notHere">–</span></td>
            </tr>
          </tbody>
        </table>

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
