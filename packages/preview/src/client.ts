// Preview's client half (0089): a document's panel, Export, opened by its keys
// (⇧⌘R), which render the document again while it is open; and by Export… on
// the document's ⋯ menu, its one item there, which renders it too and puts the
// focus on its formats to export as (PDF, Word, HTML, EPUB) (0100, 0114).
// Offered for documents laid out as text (not line-by-line source files).
import { createApp } from 'vue';
import { defineClientFeature } from '@kuraa/feature-kit/client';
import PreviewPanel from './PreviewPanel.vue';
import { KEYS, S } from './strings.js';
import { askExport } from './exporting.js';

export const previewClient = defineClientFeature({
  id: 'preview',
  helpGroup: S.helpGroup,
  uses: ['renders', 'tools'],
  commands: [{
    id: 'export',
    label: S.exportMenu,
    about: 'document',
    help: false,
    run(ctx) {
      askExport();
      ctx.openPanel('preview');
    },
  }],
  panels: [{
    id: 'preview',
    label: S.title,
    about: 'document',
    keys: KEYS.open,
    toggle: false,
    mount(element, ctx) {
      const app = createApp(PreviewPanel, { ctx });
      app.mount(element);
      return () => app.unmount();
    },
  }],
  documentMenu: (ctx) => (ctx.type.editor?.layout ? [] : [{ command: 'export', testid: 'menu-export' }]),
});
