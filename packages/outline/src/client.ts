// The Outline's client half (0089): an `over` panel, opened and closed by its
// keys (⌥⌘O) or the document's ⋯ menu, over the rich view of any document
// whose format lays it out as text (not a line-by-line source file).
import { createApp } from 'vue';
import { defineClientFeature } from '@kuraa/feature-kit/client';
import OutlinePanel from './OutlinePanel.vue';
import { KEYS, S } from './strings.js';

export const outlineClient = defineClientFeature({
  id: 'outline',
  helpGroup: S.helpGroup,
  panels: [{
    id: 'outline',
    label: S.title,
    about: 'document',
    keys: KEYS.open,
    place: 'over',
    mount(element, ctx) {
      const app = createApp(OutlinePanel, { ctx });
      app.mount(element);
      return () => app.unmount();
    },
  }],
  documentMenu: (ctx) => (ctx.type.editor?.layout || ctx.source ? [] : [{ command: 'panel:outline', testid: 'menu-outline' }]),
});
