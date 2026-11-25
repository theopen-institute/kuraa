<script setup lang="ts">
// A feature's panel beside the document (0082), drawn by the feature into the
// panel's body. The panel's head (its name, and closing it) is the client's,
// as every side panel's is. What the panel is told of the open document (it
// changed, another was opened) goes to whoever the feature asked to be told.
import { computed, watch } from 'vue';
import type { FeaturePanel, FeaturePanelContext, FeatureState } from '@kuraa/feature-kit/client';
import type { EditorView } from 'prosemirror-view';
import type { ActiveFeature } from './features.js';
import { S } from './strings.js';
import FeatureMount from './FeatureMount.vue';

const props = defineProps<{
  active: ActiveFeature;
  panel: FeaturePanel;
  /** The open document, if any. */
  path: string | null;
  /** Goes up whenever the open document, or the feature's state in it, changes. */
  documentTick: number;
  view: () => EditorView | null;
  state: () => FeatureState | null;
}>();
const emit = defineEmits<{ close: [] }>();

const listeners = new Set<() => void>();
watch(() => [props.path, props.documentTick], () => {
  for (const fn of [...listeners]) {
    try {
      fn();
    } catch (e) {
      console.error(`[kuraa] the feature ${props.active.feature.id}'s panel failed on a change`, e);
    }
  }
});

// A new context (and drawing) only for another panel: the document changing is told, not redrawn.
const mount = computed(() => {
  const { active, panel } = props;
  const ctx: FeaturePanelContext = {
    ...active.ctx,
    path: () => props.path,
    view: () => props.view(),
    state: () => props.state(),
    onDocument: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    close: () => emit('close'),
  };
  return (el: HTMLElement) => {
    const down = panel.mount(el, ctx);
    return () => {
      listeners.clear();
      down();
    };
  };
});
</script>

<template>
  <aside class="pane pane-right side-panel feature-panel" :aria-label="panel.label" :data-testid="`feature-panel-${active.feature.id}-${panel.id}`" @keydown.esc="emit('close')">
    <div class="pane-header">
      <span>{{ panel.label }}</span>
      <div class="pane-header-actions">
        <button type="button" :title="S.features.closePanel(panel.label)" :aria-label="S.features.closePanel(panel.label)" @click="emit('close')">×</button>
      </div>
    </div>
    <FeatureMount :key="`${active.feature.id}:${panel.id}`" class="feature-panel-body" :mount="mount" />
  </aside>
</template>
