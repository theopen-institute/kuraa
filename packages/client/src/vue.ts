// Small Vue helpers for the client's components.
import { onBeforeUnmount, onMounted, shallowRef, triggerRef, watch, type Directive, type Ref, type ShallowRef } from 'vue';
import { focusBack, focusPlace, trapFocus } from './focus.js';

/**
 * An object that changes outside Vue and says so through subscribe (the chunk
 * runner), as a ref: reading `.value` in a template or computed re-renders it on
 * every change. The object itself is never proxied.
 */
export function useLive<T extends { subscribe(fn: () => void): () => void }>(source: () => T): ShallowRef<T> {
  const live = shallowRef(source()) as ShallowRef<T>;
  watch(source, (next, _prev, onCleanup) => {
    live.value = next;
    onCleanup(next.subscribe(() => triggerRef(live)));
  }, { immediate: true });
  return live;
}

/** `v-focus`: focus the element when it appears (if the value is not false). */
export const vFocus: Directive<HTMLElement, boolean | undefined> = {
  mounted(el, binding) {
    if (binding.value !== false) el.focus();
  },
};

/**
 * Make the element in `root` a modal dialog while it is mounted (focus.ts): Tab
 * stays inside it, Escape calls `onEscape`, focus moves into it, and goes back
 * where it was when it closes. The element itself carries role="dialog" (or
 * "alertdialog"), aria-modal and a label.
 */
export function useDialog(root: Readonly<Ref<HTMLElement | null>>, onEscape?: () => void): void {
  let release: (() => void) | null = null;
  // Where focus was before the dialog's fields (v-focus) took it, and the caret.
  const previous = focusPlace();
  onMounted(() => {
    if (root.value) release = trapFocus(root.value, { onEscape, previous });
  });
  onBeforeUnmount(() => {
    release?.();
    release = null;
  });
}

/**
 * For a panel beside the document (Search, Preview): not modal, but when it
 * closes with focus inside it, focus goes back where it was before it opened.
 */
export function useReturnFocus(root: Readonly<Ref<HTMLElement | null>>): void {
  const previous = focusPlace();
  onBeforeUnmount(() => {
    if (root.value?.contains(document.activeElement) && previous.el?.isConnected) focusBack(previous);
  });
}
