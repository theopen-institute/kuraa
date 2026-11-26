// The Outline's client half (0089): an `over` panel, opened and closed by its
// keys (⌥⌘O) or the document's ⋯ menu, over the rich view of any document
// whose format lays it out as text (not a line-by-line source file).
import { createApp } from 'vue';
import { defineClientFeature } from '@kuraa/feature-kit/client';
import OutlinePanel from './OutlinePanel.vue';
import { KEYS, S } from './strings.js';

export const outlineClient = defineClientFeature({
  id: 'outline',
  panels: [{
    id: 'outline',
    label: S.title,
    about: 'document',
    keys: KEYS.open,
    over: true,
    mount(element, ctx) {
      const app = createApp(OutlinePanel, { ctx });
      app.mount(element);
      return () => app.unmount();
    },
  }],
  documentMenu: (ctx) => (ctx.type.editor?.layout || ctx.source ? [] : [{ label: S.title, keys: KEYS.open, testid: 'menu-outline', run: () => ctx.openPanel('outline') }]),
  help: [{ group: S.helpGroup, does: S.title, keys: [KEYS.open] }],
});
