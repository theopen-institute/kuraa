// Compile's client half (0093): Compile… on every folder's menu, opening its
// panel for that folder, and No heading in Compile (or Heading in Compile);
// Leave out of Compile (or Put back in) on a document's or folder's. Its marks
// in the file tree: what is left out, faded; a folder with a title or format
// kept for it, a book; a folder with no heading, a struck H. What it knows of the workspace is
// asked as it comes into use, and again whenever its host half says it changed.
import { createApp } from 'vue';
import { defineClientFeature, type FeatureMenuItem, type FileMark } from '@kuraa/feature-kit/client';
import CompilePanel from './CompilePanel.vue';
import { excludedBy, isBookDocument } from './settings.js';
import { forget, known, load, settingsOf, target } from './store.js';
import { S } from './strings.js';

/** A book, open: a folder compiled as one. */
/** An H, struck through: a folder whose name is no heading in Compile. */
const NO_HEADING = { paths: ['M4.5 3.5v9', 'M11.5 3.5v9', 'M4.5 8h7', 'M2.5 13.5l11-11'] };
const BOOK = { paths: ['M8 4.5c-1.6-1.2-3.6-1.5-6-1.2v9c2.4-.3 4.4 0 6 1.2 1.6-1.2 3.6-1.5 6-1.2v-9c-2.4-.3-4.4 0-6 1.2z', 'M8 4.5v9'] };

export const compileClient = defineClientFeature({
  id: 'compile',
  activate(ctx) {
    forget();
    void load(ctx);
    const stop = ctx.onMessage(() => void load(ctx));
    return () => {
      stop();
      forget();
    };
  },
  panels: [{
    id: 'compile',
    label: S.label,
    about: 'workspace',
    mount(element, ctx) {
      const app = createApp(CompilePanel, { ctx });
      app.mount(element);
      return () => app.unmount();
    },
  }],
  fileMenu(path, ctx): FeatureMenuItem[] {
    const isFolder = path.endsWith('/');
    const bare = path.replace(/\/+$/, '');
    if (!isFolder && !isBookDocument(path)) return [];
    const by = excludedBy(known.value, bare);
    const items: FeatureMenuItem[] = [];
    if (isFolder) {
      items.push({
        label: S.compileMenu,
        testid: 'context:compile',
        run: () => {
          target.value = bare;
          ctx.openPanel('compile');
        },
      });
      // Its name a heading where it is compiled inside another, or not.
      const headed = settingsOf(bare)?.heading !== false;
      items.push({ label: headed ? S.noHeading : S.heading, testid: headed ? 'context:compile-no-heading' : 'context:compile-heading', run: () => void setHeading(ctx, bare, !headed) });
    }
    // Left out with a folder it is in: put back with that folder.
    if (by === bare) items.push({ label: S.include, testid: 'context:compile-include', run: () => void change(ctx, bare, true) });
    else if (!by) items.push({ label: S.exclude, testid: 'context:compile-exclude', run: () => void change(ctx, bare, false) });
    return items;
  },
  marks(path): FileMark | null {
    const bare = path.replace(/\/+$/, '');
    const isFolder = path.endsWith('/');
    if ((isFolder || isBookDocument(path)) && excludedBy(known.value, bare)) return { label: S.leftOut, muted: true, testid: `mark:left-out:${bare}` };
    const s = isFolder ? settingsOf(bare) : undefined;
    if (s && (s.title || s.format)) return { label: S.compiledAs(s.title || bare.split('/').pop()!), icon: BOOK, testid: `mark:compiled:${bare}` };
    if (s && !s.heading) return { label: S.noHeadingMark, icon: NO_HEADING, testid: `mark:no-heading:${bare}` };
    return null;
  },
});

async function setHeading(ctx: Parameters<NonNullable<typeof compileClient.activate>>[0], folder: string, heading: boolean): Promise<void> {
  try {
    await ctx.request('POST', 'heading', { folder, heading });
  } catch (e) {
    ctx.notify(ctx.explain(e).text, 'warn');
  }
  await load(ctx);
}

async function change(ctx: Parameters<NonNullable<typeof compileClient.activate>>[0], path: string, include: boolean): Promise<void> {
  try {
    await ctx.request('POST', 'include', { path, include });
  } catch (e) {
    ctx.notify(ctx.explain(e).text, 'warn');
  }
  await load(ctx);
}
