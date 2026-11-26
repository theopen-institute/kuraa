// Word counts' client half (0094): the open document's words along its foot (a
// status panel), and the Words panel for its target and a day's.
import { createApp } from 'vue';
import { defineClientFeature } from '@kuraa/feature-kit/client';
import WordsPanel from './WordsPanel.vue';
import WordsStatus from './WordsStatus.vue';
import { S } from './strings.js';

export const wordsClient = defineClientFeature({
  id: 'words',
  panels: [
    {
      id: 'count',
      label: S.panel,
      about: 'document',
      status: true,
      mount(element, ctx) {
        const app = createApp(WordsStatus, { ctx });
        app.mount(element);
        return () => app.unmount();
      },
    },
    {
      id: 'words',
      label: S.panel,
      about: 'document',
      mount(element, ctx) {
        const app = createApp(WordsPanel, { ctx });
        app.mount(element);
        return () => app.unmount();
      },
    },
  ],
  documentMenu: (ctx) => [{ label: `${S.panel}…`, testid: 'menu-words', run: () => ctx.openPanel('words') }],
});
