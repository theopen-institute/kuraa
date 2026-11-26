// What the client knows of the workspace's manuscripts (0088), asked of the
// host when the feature comes into use, again when the host says a book
// changed, and after each change made here: shared by the Manuscript view and
// the file menu's items, which must be ready before a right-click.
import type { FeatureClientContext, Json } from '@kuraa/feature-kit/client';
import { isBookDocument, pathsOf, type Entry } from './book.js';

export interface ClientManuscript {
  folder: string;
  file: string;
  title: string | null;
  chapters: Entry[];
  appendices: string[];
}

export class Books {
  list: ClientManuscript[] = [];
  known = false;
  private readonly listeners = new Set<() => void>();
  private asked = 0;

  constructor(private readonly ctx: FeatureClientContext) {}

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

  /** The manuscript a path is in: the nearest folder up that has one. */
  bookOf(path: string): ClientManuscript | undefined {
    return this.list.filter((m) => path.startsWith(m.folder)).sort((a, b) => b.folder.length - a.folder.length)[0];
  }

  /** Ask the host for a change (the order, a document added or taken out, a folder made a manuscript); then know again. */
  async change(route: 'order' | 'add' | 'remove' | 'make', body: Json, optimistic?: (list: ClientManuscript[]) => ClientManuscript[]): Promise<Json> {
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

  /** Whether a document is listed in its manuscript. */
  listed(path: string): boolean {
    const m = this.bookOf(path);
    return !!m && pathsOf(m).includes(path);
  }

  /** Whether a path is a document a manuscript could have. */
  static document(path: string): boolean {
    return isBookDocument(path);
  }
}

/** The store of each feature context in use (the same `request` is in every context made from it). */
const stores = new WeakMap<object, Books>();
export function booksFor(ctx: FeatureClientContext): Books {
  let b = stores.get(ctx.request);
  if (!b) {
    b = new Books(ctx);
    stores.set(ctx.request, b);
  }
  return b;
}
