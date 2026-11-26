// The manuscript's client half (0088, 0090): the Manuscript, a navigation view,
// with New chapter in ＋; Make a manuscript on a folder's menu, and Add to and
// Remove from a manuscript on a document's (each manuscript by name, where
// there are several: a document may be in any of them). What it knows of the
// workspace's manuscripts is asked as it comes into use (activate), and again
// whenever the host says a book changed.
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
    newItems(ctx) {
      const books = booksFor(ctx);
      const m = books.chosen();
      return m ? [{ label: S.newChapterIn(Books.titleOf(m)), testid: 'context:new-chapter', run: () => void books.newChapter(ctx) }] : [];
    },
  }],
  fileMenu(path, ctx): FeatureMenuItem[] {
    const books = booksFor(ctx);
    if (path.endsWith('/')) {
      return [{
        label: S.make,
        testid: 'context:manuscript-make',
        run: async () => {
          const file = await books.make({ folder: path });
          if (file) ctx.notify(S.made(path.replace(/\/$/, '')));
        },
      }];
    }
    // One manuscript: plain words; several: each by its name.
    const one = books.list.length === 1;
    return [
      ...books.addable(path).map((m) => ({ label: one ? S.addTo : S.addToNamed(Books.titleOf(m)), testid: one ? 'context:manuscript-add' : `context:manuscript-add:${m.file}`, run: () => void books.change('add', { path, file: m.file }) })),
      ...books.containing(path).map((m) => ({ label: one ? S.removeFrom : S.removeFromNamed(Books.titleOf(m)), testid: one ? 'context:manuscript-remove' : `context:manuscript-remove:${m.file}`, run: () => void books.change('remove', { path, file: m.file }) })),
    ];
  },
});
