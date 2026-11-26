// The manuscript's client half (0091): on a folder's menu, Make a manuscript
// (or, on one, No longer a manuscript); on a document or folder in one, Leave
// out of the manuscript (or Put back in). Its marks in the file tree: a book by
// a manuscript's folder, and what is left out faded. What it knows of the
// workspace's manuscripts is asked as it comes into use, and again whenever its
// host half says one changed.
import { defineClientFeature, type FeatureClientContext, type FeatureMenuItem, type FileMark } from '@kuraa/feature-kit/client';
import { excludedBy, isBookDocument, titleOf, within, type Manuscript } from './manuscript.js';
import { S } from './strings.js';

/** A book, open: a manuscript's folder. */
const BOOK = { paths: ['M8 4.5c-1.6-1.2-3.6-1.5-6-1.2v9c2.4-.3 4.4 0 6 1.2 1.6-1.2 3.6-1.5 6-1.2v-9c-2.4-.3-4.4 0-6 1.2z', 'M8 4.5v9'] };

/** What is known of the workspace's manuscripts: one workspace is open at a time. */
let known: Manuscript[] = [];
let asked = 0;

async function load(ctx: FeatureClientContext): Promise<void> {
  const n = ++asked;
  try {
    const r = (await ctx.request('GET', 'manuscripts')) as unknown as { manuscripts: Manuscript[] };
    if (n !== asked) return;
    known = r.manuscripts;
    ctx.marksChanged();
  } catch {
    // Off, or the host away: what was known stays.
  }
}

async function change(ctx: FeatureClientContext, route: 'make' | 'unmake' | 'include', body: { [key: string]: string | boolean }, said?: string): Promise<void> {
  try {
    await ctx.request('POST', route, body);
    if (said) ctx.notify(said);
  } catch (e) {
    ctx.notify(ctx.explain(e).text, 'warn');
  }
  await load(ctx);
}

const containing = (path: string) => known.find((m) => within(m, path.replace(/\/$/, '')));

export const manuscriptClient = defineClientFeature({
  id: 'manuscript',
  activate(ctx) {
    known = [];
    void load(ctx);
    const stop = ctx.onMessage(() => void load(ctx));
    return () => {
      stop();
      known = [];
      asked++;
    };
  },
  fileMenu(path, ctx): FeatureMenuItem[] {
    const isFolder = path.endsWith('/');
    const own = isFolder ? known.find((m) => m.folder === path) : undefined;
    if (own) return [{ label: S.unmake, testid: 'context:manuscript-unmake', run: () => void change(ctx, 'unmake', { folder: path }, S.unmade(titleOf(own))) }];
    const m = containing(path);
    if (!m) return isFolder ? [{ label: S.make, testid: 'context:manuscript-make', run: () => void change(ctx, 'make', { folder: path }, S.made(path.replace(/\/$/, ''))) }] : [];
    if (!isFolder && !isBookDocument(path)) return [];
    const bare = path.replace(/\/$/, '');
    const by = excludedBy(m, bare);
    // Left out with a folder it is in: put back with that folder.
    if (by && by !== bare) return [];
    return by
      ? [{ label: S.include, testid: 'context:manuscript-include', run: () => void change(ctx, 'include', { path: bare, include: true }) }]
      : [{ label: S.exclude, testid: 'context:manuscript-exclude', run: () => void change(ctx, 'include', { path: bare, include: false }) }];
  },
  marks(path): FileMark | null {
    const own = path.endsWith('/') ? known.find((m) => m.folder === path) : undefined;
    if (own) return { label: S.isManuscript(titleOf(own)), icon: BOOK, testid: `mark:manuscript:${path}` };
    const m = containing(path);
    if (!m) return null;
    const bare = path.replace(/\/$/, '');
    if (!path.endsWith('/') && !isBookDocument(path)) return null;
    return excludedBy(m, bare) ? { label: S.leftOut, muted: true, testid: `mark:left-out:${bare}` } : null;
  },
});
