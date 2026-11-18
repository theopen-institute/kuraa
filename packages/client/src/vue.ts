// Small Vue helpers for the client's components.
import { onScopeDispose, shallowRef, triggerRef, watch, type Directive, type ShallowRef } from 'vue';

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

/** Close on Escape while mounted. */
export function onEscape(fn: () => void): void {
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') fn();
  };
  window.addEventListener('keydown', onKey);
  onScopeDispose(() => window.removeEventListener('keydown', onKey));
}
