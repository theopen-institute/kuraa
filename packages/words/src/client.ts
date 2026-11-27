// Word counts' client half (0094): in the document's ⋯ menu, its words (of its
// target) and yours today, net and added, counted as the menu opens; choosing
// it opens the Words panel, for the targets and the days before. Today's words
// come from the history: asked as it comes into use, every minute, and as the
// menu opens.
import { createApp } from 'vue';
import { defineClientFeature } from '@kuraa/feature-kit/client';
import WordsPanel from './WordsPanel.vue';
import { liveWords, targetOf } from './count.js';
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
  documentMenu(ctx) {
    const view = ctx.view();
    if (!view) return [{ label: `${S.panel}…`, testid: 'menu-words', run: () => ctx.openPanel('words') }];
    const words = liveWords(view.state.doc);
    const target = targetOf(ctx.header()?.get('target-words'));
    const today = yours(ctx, day());
    // Asked again, for the next time it opens.
    void load(ctx);
    return [{ label: S.menu(words, target, today.net, today.added), testid: 'menu-words', run: () => ctx.openPanel('words') }];
  },
});
