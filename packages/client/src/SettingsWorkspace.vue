<script setup lang="ts">
// Settings › Workspace (decision 0064): the open workspace's own settings, kept
// in the workspace, for everyone in it: its packages; its devices, and inviting
// people (DevicesSection); its groups and permissions (RulesSection); and, where
// the host allows it, taking it off this host's list (its folder stays). Its
// name is the section's heading, renamed there (SettingsWindow, 0061); its online
// copy is the online copy component's, under Host's components (SettingsHost). Each of these is done at once, asking first
// where it should, as it always was: none waits for the window to close.
import { computed, ref, watch } from 'vue';
import type { HostApi, WorkspaceInfo } from './api.js';
import type { ChunkRunner } from './runs.js';
import { S } from './strings.js';
import DevicesSection from './DevicesSection.vue';
import RulesSection from './RulesSection.vue';
import FeatureMount from './FeatureMount.vue';
import SubpanelLink from './SubpanelLink.vue';
import type { FeatureStatus } from '@kuraa/feature-kit/client';
import type { ActiveFeature } from './features.js';

const props = defineProps<{
  api: HostApi;
  workspace: WorkspaceInfo | null;
  /** The open document's runner, if it runs code: through it, the workspace's packages are listed and changed. */
  runner: ChunkRunner | null;
  /** The host lets people take this workspace off its list. */
  canRemove: boolean;
  /** Features (0082): how each the host has stands here, and the client halves on, for their settings. */
  features: FeatureStatus[];
  featureParts: ActiveFeature[];
  /**
   * Turn a feature on or off for the workspace: the app's, so that it goes
   * through, and the app follows it, even if Settings is closed meanwhile.
   */
  turnFeature: (id: string, on: boolean) => Promise<void>;
}>();
const emit = defineEmits<{ remove: []; invite: []; permissions: [path: string]; packages: [runner: ChunkRunner, engine: string] }>();

// Features (0082): which this workspace uses, saved in it for everyone (who may change its settings turns them on and off).
const featureBusy = ref<string | null>(null);
const featureError = ref<string | null>(null);
async function setFeature(f: FeatureStatus, on: boolean) {
  featureBusy.value = f.id;
  featureError.value = null;
  try {
    await props.turnFeature(f.id, on);
  } catch (e) {
    featureError.value = S.features.failed(f.label, (e as Error).message);
  } finally {
    featureBusy.value = null;
  }
}
/** A feature's settings for the workspace, open as a subpanel. */
const featureSub = ref<string | null>(null);
const subPart = computed(() => props.featureParts.find((f) => f.feature.id === featureSub.value && f.feature.settings?.workspace) ?? null);
const subMount = computed(() => {
  const part = subPart.value;
  const panel = part?.feature.settings?.workspace;
  return part && panel ? (el: HTMLElement) => panel.mount(el, part.ctx) : null;
});

// The engine whose packages the workspace's documents use, followed as the runner changes.
const tick = ref(0);
watch(() => props.runner, (r, _prev, onCleanup) => {
  if (r) onCleanup(r.subscribe(() => tick.value++));
}, { immediate: true });
const packageEngine = computed(() => (void tick.value, props.runner?.packageEngine ?? null));
</script>

<template>
  <div data-testid="settings-workspace">
    <template v-if="workspace && subPart && subMount">
      <div class="subpanel-head">
        <button type="button" class="subpanel-back" data-testid="subpanel-back" @click="featureSub = null">{{ S.person.back(S.features.title) }}</button>
        <h4 data-testid="subpanel-title">{{ subPart.feature.settings!.workspace!.label }}</h4>
      </div>
      <section class="settings-part" :data-testid="`feature-settings-${subPart.feature.id}`">
        <FeatureMount :mount="subMount" />
      </section>
    </template>
    <template v-else-if="workspace">
      <section v-if="features.length" class="settings-part" data-testid="workspace-features">
        <fieldset class="pref-group">
          <legend>{{ S.features.title }}</legend>
          <p class="pref-note">{{ S.features.about }}</p>
          <label v-for="f in features" :key="f.id" class="component">
            <input
              type="checkbox"
              :checked="f.workspace"
              :disabled="!f.mayChange || featureBusy !== null"
              :aria-label="f.label"
              :data-testid="`feature-${f.id}`"
              @change="setFeature(f, ($event.target as HTMLInputElement).checked)"
            >
            <span class="component-text">
              <span class="component-name">{{ f.label }}</span>
              <span class="component-about">{{ f.description }}</span>
              <span v-if="!f.host" class="component-about">{{ S.features.offHere }}</span>
            </span>
          </label>
          <p v-if="features.some((f) => !f.mayChange)" class="pref-note">{{ S.features.mayNotChange }}</p>
          <div v-if="featureError" class="components-error" role="alert">{{ featureError }}</div>
        </fieldset>
        <template v-for="p in featureParts" :key="p.feature.id">
          <SubpanelLink v-if="p.feature.settings?.workspace" :title="p.feature.settings.workspace.label" :about="p.status.description" :testid="`open-feature-${p.feature.id}`" @open="featureSub = p.feature.id" />
        </template>
      </section>
      <section v-if="runner && packageEngine" class="settings-part">
        <fieldset class="pref-group">
          <legend>{{ S.sections.packages }}</legend>
          <p class="pref-note">{{ S.sections.packagesAbout }}</p>
          <div class="pref-row">
            <button type="button" data-testid="settings-packages" @click="emit('packages', runner, packageEngine)">{{ S.code.packages }}</button>
          </div>
        </fieldset>
      </section>
      <DevicesSection :api="api" @invite="emit('invite')" />
      <RulesSection :api="api" @permissions="(p) => emit('permissions', p)" />
      <details class="settings-part menu-details">
        <summary>{{ S.common.details }}</summary>
        <span class="menu-facts" data-testid="workspace-details">{{ S.menu.workspaceDetails(workspace.branch, workspace.head?.slice(0, 7) ?? null) }}</span>
      </details>
      <section v-if="canRemove" class="settings-part settings-danger">
        <div class="pref-row">
          <button type="button" class="danger" :title="S.menu.removeWorkspaceTitle" data-testid="menu-remove-workspace" @click="emit('remove')">{{ S.menu.removeWorkspace }}</button>
        </div>
      </section>
    </template>
    <p v-else class="pref-note settings-none">{{ S.sections.noWorkspace }}</p>
  </div>
</template>
