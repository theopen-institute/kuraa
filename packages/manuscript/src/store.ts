// What the client knows of the workspace's manuscripts (0088, 0090), asked of
// the host when the feature comes into use, again when the host says a book
// changed, and after each change made here: shared by the Manuscript view, ＋
// and the file menu's items, which must be ready before a right-click.
import type { FeatureClientContext, Json, NavigationContext } from '@kuraa/feature-kit/client';
import { isBookDocument, pathsOf, placeIn, type Entry } from './book.js';

export interface ClientManuscript {
  file: string;
  /** Its project's folder: its chapters are in it ('' for any of the workspace's). */
  folder: string;
  profile: string | null;
  title: string | null;
  /** Where its new chapters go. */
  home: string | null;
  chapters: Entry[];
  appendices: string[];
}

const CHOSEN_KEY = 'kuraa:manuscript';

export class Books {
  list: ClientManuscript[] = [];
  known = false;
  /** The manuscript shown (its file), as this browser last chose. */
  chosenFile: string | null = null;
  private readonly listeners = new Set<() => void>();
  private asked = 0;

  constructor(private ctx: FeatureClientContext) {
    try { this.chosenFile = localStorage.getItem(CHOSEN_KEY); } catch { /* storage unavailable */ }
  }

  /** In use for a workspace (again, or another): asked of it from now on. */
  use(ctx: FeatureClientContext): void {
    this.ctx = ctx;
  }

  async load(): Promise<void> {
    const n = ++this.asked;
    try {
      const r = (await this.ctx.request('GET', 'manuscripts')) as unknown as { manuscripts: ClientManuscript[] };
      if (n !== this.asked) return;
      this.list = r.manuscripts;
      this.known = true;
      this.tell();
    } catch {
      // Off, or the host away: what was known stays.
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private tell() {
    for (const fn of [...this.listeners]) {
      try {
        fn();
      } catch (e) {
        console.error('[kuraa] the manuscript view failed on a change', e);
      }
    }
  }

  /** The manuscript shown: the one chosen, else the first. */
  chosen(): ClientManuscript | null {
    return this.list.find((m) => m.file === this.chosenFile) ?? this.list[0] ?? null;
  }

  choose(file: string): void {
    this.chosenFile = file;
    try { localStorage.setItem(CHOSEN_KEY, file); } catch { /* storage unavailable: for this page only */ }
    this.tell();
  }

  /** The manuscripts a document is in. */
  containing(path: string): ClientManuscript[] {
    return this.list.filter((m) => pathsOf(m).includes(path));
  }

  /** The manuscripts a document could be added to: those whose project has it, and that do not list it yet. */
  addable(path: string): ClientManuscript[] {
    return isBookDocument(path) ? this.list.filter((m) => path.startsWith(m.folder) && !pathsOf(m).includes(path)) : [];
  }

  /** What a manuscript is called. */
  static titleOf(m: ClientManuscript): string {
    return m.title || m.profile || m.folder || m.file;
  }

  /** Ask the host for a change; then know again. Shown at once where `optimistic` says how. */
  async change(route: 'order' | 'add' | 'remove' | 'make' | 'home', body: Json, optimistic?: (list: ClientManuscript[]) => ClientManuscript[]): Promise<Json> {
    if (optimistic) {
      this.list = optimistic(this.list);
      this.tell();
    }
    try {
      return await this.ctx.request('POST', route, body);
    } catch (e) {
      this.ctx.notify(this.ctx.explain(e).text, 'warn');
      return null;
    } finally {
      await this.load();
    }
  }

  /** A new manuscript, by its title, or of a folder; shown once made. */
  async make(body: { title?: string; folder?: string }): Promise<string | null> {
    const r = (await this.change('make', body)) as { file?: string } | null;
    if (r?.file) this.choose(r.file);
    return r?.file ?? null;
  }

  /**
   * New chapter (0090): a document made in the shown manuscript's home folder,
   * put after the chapter open (where it is in it), else at its end, and opened
   * with the cursor in its title.
   */
  async newChapter(ctx: NavigationContext): Promise<void> {
    const m = this.chosen();
    if (!m) return;
    const open = ctx.selected();
    const after = open && placeIn(m, open) ? open : null;
    const path = await ctx.newFile((m.home ?? m.folder).replace(/\/$/, ''));
    if (path) await this.change('add', { path, file: m.file, after });
  }
}

/** The page's store: one workspace is open at a time, and the feature's activation points it at it. */
let store: Books | null = null;
export function booksFor(ctx: FeatureClientContext): Books {
  if (!store) store = new Books(ctx);
  return store;
}
