// The open document's words, as the status item and the panel both show them
// (0094): counted a moment after each change (not at every keystroke in a long
// document), and noted for today's count.
import { onBeforeUnmount, ref } from 'vue';
import type { FeaturePanelContext } from '@kuraa/feature-kit/client';
import { liveWords, targetOf } from './count.js';
import { note } from './session.js';

export function useLiveWords(ctx: FeaturePanelContext) {
  const words = ref<number | null>(null);
  const target = ref<number | null>(null);
  const hasHeader = ref(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let shown: string | null = null;
  const count = () => {
    const view = ctx.view();
    const path = ctx.path();
    if (!view || !path) {
      words.value = null;
      return;
    }
    const n = liveWords(view.state.doc);
    words.value = n;
    note(path, n);
    const header = ctx.header();
    hasHeader.value = !!header;
    target.value = targetOf(header?.get('target-words'));
  };
  const soon = () => {
    // Another document: at once; the same one, a moment after typing.
    if (ctx.path() !== shown) {
      shown = ctx.path();
      clearTimeout(timer);
      count();
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(count, 250);
  };
  const stop = ctx.onDocument(soon);
  // The view may not be ready as this is drawn: asked again shortly.
  const first = setTimeout(count, 50);
  count();
  onBeforeUnmount(() => {
    stop();
    clearTimeout(timer);
    clearTimeout(first);
  });
  return { words, target, hasHeader, recount: count };
}
