// The file tree's client half (0087): a navigation view, drawn wherever the
// layout in use gives it room; and its keys on the Markdown and shortcuts sheet.
import { createApp } from 'vue';
import { defineClientFeature } from '@kuraa/feature-kit/client';
import FilesView from './FilesView.vue';
import { S } from './strings.js';

const h = S.help;

export const filesClient = defineClientFeature({
  id: 'files',
  views: [{
    id: 'files',
    label: S.label,
    mount(element, ctx) {
      const app = createApp(FilesView, { ctx });
      app.mount(element);
      return () => app.unmount();
    },
  }],
  help: [
    { group: S.helpGroup, does: h.move, keys: ['ArrowUp', 'ArrowDown'] },
    { group: S.helpGroup, does: h.folder, keys: ['ArrowRight', 'ArrowLeft'] },
    { group: S.helpGroup, does: h.open, keys: ['Enter'] },
    { group: S.helpGroup, does: h.rename, keys: ['F2'] },
    { group: S.helpGroup, does: h.remove, keys: ['Delete'] },
    { group: S.helpGroup, does: h.menu, keys: ['Shift-F10'], note: h.menuNote },
  ],
});
