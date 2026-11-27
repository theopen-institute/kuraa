// Compile's client half (0093): Compile… on every folder's menu, opening its
// panel for that folder, where what goes in the book and which folders'
// names are headings are chosen. Its marks in the file tree: what is left out,
// faded; a folder with a title or format kept for it, a book; a folder with no
// heading, a struck H. What it knows of the workspace is asked as it comes into
// use, and again whenever its host half says it changed.
import { createApp } from 'vue';
import { defineClientFeature, type FeatureMenuItem, type FileMark } from '@kuraa/feature-kit/client';
import CompilePanel from './CompilePanel.vue';
import { excludedBy, isBookDocument } from './settings.js';
import { forget, known, load, settingsOf, target } from './store.js';
import { S } from './strings.js';

/** An H, struck through: a folder whose name is no heading in Compile. */
const NO_HEADING = { paths: ['M4.5 3.5v9', 'M11.5 3.5v9', 'M4.5 8h7', 'M2.5 13.5l11-11'] };
/** A book, open: a folder compiled as one. */
const BOOK = { paths: ['M8 4.5c-1.6-1.2-3.6-1.5-6-1.2v9c2.4-.3 4.4 0 6 1.2 1.6-1.2 3.6-1.5 6-1.2v-9c-2.4-.3-4.4 0-6 1.2z', 'M8 4.5v9'] };

export const compileClient = defineClientFeature({
  id: 'compile',
  uses: ['renders'],
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
    if (!path.endsWith('/')) return [];
    return [{
      label: S.compileMenu,
      testid: 'context:compile',
      run: () => {
        target.value = path.replace(/\/+$/, '');
        ctx.openPanel('compile');
      },
    }];
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
