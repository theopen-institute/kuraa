// What the client knows of the workspace's manuscripts (0088, 0090), asked of
// the host when the feature comes into use, again when the host says a book
// changed, and after each change made here: shared by the Manuscript view, ＋
// and the file menu's items, which must be ready before a right-click.
import type { FeatureClientContext, Json, NavigationContext } from '@kuraa/feature-kit/client';
import { isBookDocument, pathsOf, placeIn, type Entry } from './book.js';
import { movesFor } from './places.js';

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

  /** The manuscript a document is in (one at most: 0090). */
  containing(path: string): ClientManuscript | undefined {
    return this.list.find((m) => pathsOf(m).includes(path));
  }

  /** The manuscripts a document could be added to: none, if it is in one; else those whose project has it. */
  addable(path: string): ClientManuscript[] {
    if (!isBookDocument(path) || this.containing(path)) return [];
    return this.list.filter((m) => path.startsWith(m.folder));
  }

  /** The workspace has manuscripts keep their files where they say (its setting, 0090). */
  managesFiles(): boolean {
    try {
      return this.ctx.status().settings.manageFiles === true;
    } catch {
      return false;
    }
  }

  /**
   * Where the workspace has manuscripts keep their files: the files of the
   * manuscripts named (by file; all, if none is) moved where they belong, each
   * as the file tree moves it; then known again. What cannot be moved (a file
   * there already, someone may not) is said once, and left.
   */
  async tidy(files?: string[], on = this.managesFiles()): Promise<void> {
    if (!on) return;
    let moved = false;
    let failed: string | null = null;
    for (const m of this.list.filter((x) => !files || files.includes(x.file))) {
      for (const [from, to] of movesFor(m)) {
        try {
          await this.ctx.moveFile(from, to);
          moved = true;
        } catch (e) {
          failed ??= `${from}: ${this.ctx.explain(e).text}`;
        }
      }
    }
    if (failed) this.ctx.notify(failed, 'warn');
    if (moved) await this.load();
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
    let answer: Json = null;
    try {
      answer = await this.ctx.request('POST', route, body);
    } catch (e) {
      this.ctx.notify(this.ctx.explain(e).text, 'warn');
    }
    await this.load();
    // Its files where it keeps them, where the workspace has manuscripts do so.
    const file = (answer as { file?: unknown } | null)?.file ?? (body as { file?: unknown } | null)?.file;
    if (answer !== null && typeof file === 'string') await this.tidy([file]);
    return answer;
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
