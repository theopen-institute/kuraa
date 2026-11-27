<script setup lang="ts">
// A feature's panel (0082), drawn by the feature into the panel's body: beside
// the document, with a head (its name, and closing it) that is the client's, as
// every side panel's is; or, for an `over` panel, over the document's top left,
// all of it the feature's (0089); or, for a `dialog`, in a window over the whole
// page, modal, its frame the client's and all in it the feature's (0092). What the panel is told of the open document
// (it changed, another was opened) goes to whoever the feature asked to be
// told; each time it is asked for, to whoever listens for that (onAsk).
import { computed, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from 'vue';
import type { FeaturePanel, FeaturePanelContext, FeatureState } from '@kuraa/feature-kit/client';
import type { EditorView } from 'prosemirror-view';
import type { HeaderSpec } from '@kuraa/editor-kit';
import { documentHeader } from './header.js';
import type { ActiveFeature } from './features.js';
import { S } from './strings.js';
import { useReturnFocus } from './vue.js';
import { trapFocus } from './focus.js';
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
  /** The open document as the client follows it (when last written, edits not yet at the host). */
  document: { path: string; writtenAt: string | null; unsynced: number } | null;
  /** Goes up each time the panel is asked for (its keys, a menu, openPanel). */
  asks: number;
  /** How the open document's format keeps its header, if it has one (0094). */
  headerSpec?: HeaderSpec | null;
}>();
const emit = defineEmits<{ close: [] }>();

const root = useTemplateRef<HTMLElement>('root');
useReturnFocus(root);

// A dialog (0092): the focus kept in it; Escape and a click outside close it, unless it is held open.
const held = ref(false);
const dialog = useTemplateRef<HTMLElement>('dialog');
const tryClose = () => {
  if (!held.value) emit('close');
};
let release: (() => void) | null = null;
onMounted(() => {
  if (dialog.value) release = trapFocus(dialog.value, { onEscape: tryClose });
});
onBeforeUnmount(() => release?.());

const listeners = new Set<() => void>();
const askers = new Set<() => void>();
const tell = (set: Set<() => void>, what: string) => {
  for (const fn of [...set]) {
    try {
      fn();
    } catch (e) {
      console.error(`[kuraa] the feature ${props.active.feature.id}'s panel failed on ${what}`, e);
    }
  }
};
watch(() => [props.path, props.documentTick, props.document?.writtenAt, props.document?.unsynced], () => tell(listeners, 'a change'));
watch(() => props.asks, () => tell(askers, 'being asked for'));
let first: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(first));

// A new context (and drawing) only for another panel: the document changing is told, not redrawn.
const mount = computed(() => {
  const { active, panel } = props;
  const ctx: FeaturePanelContext = {
    ...active.ctx,
    path: () => props.path,
    view: () => props.view(),
    state: () => props.state(),
    document: () => (props.path && props.document?.path === props.path ? { ...props.document } : null),
    onDocument: (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    onAsk: (fn) => {
      askers.add(fn);
      return () => askers.delete(fn);
    },
    close: () => emit('close'),
    header: () => {
      const view = props.view();
      return view && props.headerSpec ? documentHeader(view, props.headerSpec) : null;
    },
    holdOpen: (hold) => {
      held.value = hold;
    },
  };
  return (el: HTMLElement) => {
    const down = panel.mount(el, ctx);
    // Opened by being asked for: told so once it is drawn.
    clearTimeout(first);
    first = setTimeout(() => tell(askers, 'being asked for'));
    return () => {
      listeners.clear();
      askers.clear();
      down();
    };
  };
});
</script>

<template>
  <FeatureMount v-if="panel.place === 'over'" :key="`${active.feature.id}:${panel.id}`" class="feature-over" :testid="`feature-over-${active.feature.id}-${panel.id}`" :mount="mount" />
  <div v-else-if="panel.place === 'dialog'" class="modal-backdrop" @mousedown.self="tryClose">
    <div ref="dialog" class="modal feature-dialog" role="dialog" aria-modal="true" :aria-label="panel.label" :data-testid="`feature-dialog-${active.feature.id}-${panel.id}`">
      <FeatureMount :key="`${active.feature.id}:${panel.id}`" class="feature-dialog-body" :mount="mount" />
    </div>
  </div>
  <aside v-else ref="root" class="pane pane-right side-panel feature-panel" :aria-label="panel.label" :data-testid="`feature-panel-${active.feature.id}-${panel.id}`" @keydown.esc="emit('close')">
    <div class="pane-header">
      <span>{{ panel.label }}</span>
      <div class="pane-header-actions">
        <button type="button" :title="S.features.closePanel(panel.label)" :aria-label="S.features.closePanel(panel.label)" @click="emit('close')">×</button>
      </div>
    </div>
    <FeatureMount :key="`${active.feature.id}:${panel.id}`" class="feature-panel-body" :mount="mount" />
  </aside>
</template>
