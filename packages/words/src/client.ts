// Word counts' client half (0094): at the foot of the document's ⋯ menu,
// below when it was saved, its words and your total today (net, every
// document), counted as the menu opens; clicking it opens the Words
// panel, for the targets and the days before. Today's words come from the
// history: asked as it comes into use, every minute, and as the menu opens.
import { createApp } from 'vue';
import { defineClientFeature } from '@kuraa/feature-kit/client';
import WordsPanel from './WordsPanel.vue';
import { liveWords } from './count.js';
import { day, follow, load, yours } from './session.js';
import { S } from './strings.js';

export const wordsClient = defineClientFeature({
  id: 'words',
  activate: (ctx) => follow(ctx),
  panels: [{
    id: 'words',
    label: S.panel,
    about: 'document',
    mount(element, ctx) {
      const app = createApp(WordsPanel, { ctx });
      app.mount(element);
      return () => app.unmount();
    },
  }],
  documentFooter(ctx) {
    const view = ctx.view();
    if (!view) return null;
    // Asked again, for the next time the menu opens.
    void load(ctx);
    return { text: S.footer(liveWords(view.state.doc), yours(ctx, day()).net), testid: 'words-footer', title: S.footerTitle, run: () => ctx.openPanel('words') };
  },
});
