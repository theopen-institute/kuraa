// The manuscript's client half (0088, 0090): the Manuscript, a navigation view,
// with New chapter in ＋; Make a manuscript on a folder's menu, and Add to (each
// manuscript by name, where there are several) and Remove from its manuscript
// on a document's: a document is in one at most. Its setting for the
// workspace: whether manuscripts keep their files (move them into their home
// folders). What it knows of the workspace's manuscripts is asked as it comes
// into use (activate), and again whenever the host says a book changed.
import { createApp } from 'vue';
import { defineClientFeature, type FeatureClientContext, type FeatureMenuItem } from '@kuraa/feature-kit/client';
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
    const inIt = books.containing(path);
    if (inIt) return [{ label: one ? S.removeFrom : S.removeFromNamed(Books.titleOf(inIt)), testid: 'context:manuscript-remove', run: () => void books.change('remove', { path, file: inIt.file }) }];
    return books.addable(path).map((m) => ({ label: one ? S.addTo : S.addToNamed(Books.titleOf(m)), testid: one ? 'context:manuscript-add' : `context:manuscript-add:${m.file}`, run: () => void books.change('add', { path, file: m.file }) }));
  },
  settings: { workspace: { label: S.label, inline: true, mount: mountSettings } },
});

/** Its setting for the workspace, under its switch in Settings: whether manuscripts keep their files. */
function mountSettings(root: HTMLElement, ctx: FeatureClientContext): () => void {
  const label = document.createElement('label');
  label.className = 'manuscript-setting';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.dataset.testid = 'manuscript-manage-files';
  box.checked = ctx.status().settings.manageFiles === true;
  box.disabled = !ctx.status().mayChange;
  const text = document.createElement('span');
  const name = document.createElement('span');
  name.className = 'manuscript-setting-name';
  name.textContent = S.manageFiles;
  const about = document.createElement('span');
  about.className = 'manuscript-setting-about';
  about.textContent = S.manageFilesAbout;
  text.append(name, about);
  label.append(box, text);
  box.onchange = async () => {
    box.disabled = true;
    try {
      await ctx.saveSettings({ ...ctx.status().settings, manageFiles: box.checked });
      ctx.notify(box.checked ? S.manageFilesOn : S.manageFilesOff);
      // Turned on: every manuscript's files where it keeps them, now.
      if (box.checked) await booksFor(ctx).tidy(undefined, true);
    } catch (e) {
      box.checked = !box.checked;
      ctx.notify(ctx.explain(e).text, 'warn');
    } finally {
      box.disabled = !ctx.status().mayChange;
    }
  };
  const style = document.createElement('style');
  style.textContent = `.manuscript-setting { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1px 8px; align-items: start; cursor: pointer; }
.manuscript-setting > input { margin: 3px 0 0; }
.manuscript-setting > span { display: grid; gap: 1px; min-width: 0; }
.manuscript-setting-about { color: var(--muted); font-size: 12px; }`;
  root.append(style, label);
  return () => {
    style.remove();
    label.remove();
  };
}
