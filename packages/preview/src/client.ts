// Preview's client half (0089): a document's panel, opened by its keys (⇧⌘R)
// or the document's ⋯ menu, each of which renders the document again while it
// is open; and Export… on that menu, which opens it at its formats to export as
// (PDF, Word, HTML, EPUB) rather than rendering for the page (0100). Offered for
// documents laid out as text (not line-by-line source files).
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
  documentMenu: (ctx) => (ctx.type.editor?.layout ? [] : [{ command: 'panel:preview', testid: 'menu-preview' }, { command: 'export', testid: 'menu-export' }]),
});
