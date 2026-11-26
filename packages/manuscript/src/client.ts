// The manuscript's client half (0088): the Manuscript, a navigation view; Make
// a manuscript on a folder's menu, and Add to and Remove from manuscript on a
// document's. What it knows of the workspace's manuscripts is asked as it comes
// into use (activate), and again whenever the host says a book changed.
import { createApp } from 'vue';
import { defineClientFeature, type FeatureMenuItem } from '@kuraa/feature-kit/client';
import ManuscriptView from './ManuscriptView.vue';
import { Books, booksFor } from './store.js';
import { S } from './strings.js';

export const manuscriptClient = defineClientFeature({
  id: 'manuscript',
  activate(ctx) {
    const books = booksFor(ctx);
    books.use(ctx);
    void books.load();
    return ctx.onMessage(() => void books.load());
  },
  views: [{
    id: 'manuscript',
    label: S.label,
    mount(element, ctx) {
      const app = createApp(ManuscriptView, { ctx });
      app.mount(element);
      return () => app.unmount();
    },
  }],
  fileMenu(path, ctx): FeatureMenuItem[] {
    const books = booksFor(ctx);
    if (path.endsWith('/')) {
      if (books.list.some((m) => m.folder === path)) return [];
      return [{
        label: S.make,
        testid: 'context:manuscript-make',
        run: async () => {
          const r = (await books.change('make', { folder: path })) as { file?: string } | null;
          if (r?.file) ctx.notify(S.made(r.file));
        },
      }];
    }
    if (!Books.document(path) || !books.bookOf(path)) return [];
    return books.listed(path)
      ? [{ label: S.removeFrom, testid: 'context:manuscript-remove', run: () => void books.change('remove', { path }) }]
      : [{ label: S.addTo, testid: 'context:manuscript-add', run: () => void books.change('add', { path }) }];
  },
});
