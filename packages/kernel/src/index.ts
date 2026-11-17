// The kernel knows nothing about any file format. It holds registries for
// document types, commands and lifecycle hooks, and runs without a DOM or Node.
import type { Node, Schema } from 'prosemirror-model';

export interface ParsedDocument {
  text: string;
  doc: Node;
  /** Source range of each top-level block, including its trailing blank lines. */
  blocks: { from: number; to: number }[];
}

/**
 * How the client should present a node. Format packages stay headless, so they
 * describe views as data and the client supplies the implementation.
 * See docs/decisions/0002-declarative-node-views.md.
 */
export type NodeViewHint =
  | {
      kind: 'code'; language?: string; languageAttr?: string; header?: { attr: string; prefix?: string; suffix?: string };
      /** Wrap long lines (the default), or keep each line on one line and scroll sideways. */
      wrap?: boolean;
      /**
       * The block can be run, like a knitr chunk. Its engine is the first word of
       * `header.attr` if there is one, else `engineAttr`; whether that engine can
       * run is up to the host.
       */
      run?: { engineAttr: string };
    }
  | {
      kind: 'atom'; attr: string; className?: string; display?: 'inline' | 'block';
      /** Shown around the value, e.g. `$` … `$` for inline math. */
      prefix?: string;
      suffix?: string;
    };

/**
 * How the client lays out a whole document. Without one, a document is rich
 * text. `lines` is a source file: the document is a sequence of `line` nodes,
 * one per line of the file, whose `eolAttr` attribute holds the line's
 * terminator; the client shows it monospaced with line numbers and highlights
 * it as `language`, or as whatever `languageOf` says for the file's path and
 * first line. Language names are those the client's registry knows.
 */
export type LayoutHint = {
  kind: 'lines';
  line: string;
  eolAttr: string;
  language?: string;
  languageOf?(path: string, head: string): string | undefined;
};

/**
 * What the client needs to know to show a type, as data. What the type *does*
 * in the editor (cues, keys, behaviour, its own views) lives in its editor
 * module; see @kuraa/editor-kit.
 */
export interface EditorContribution {
  nodeViews?: Record<string, NodeViewHint>;
  layout?: LayoutHint;
}

export interface DocumentType {
  /** 'pandoc-markdown', 'rmarkdown' */
  id: string;
  /** Bump on any schema change; part of the room key. */
  version: number;
  label: string;
  /** Higher wins when several types match the same file. */
  priority?: number;
  match(path: string, head: string): boolean;
  /** Extensions for new files of this type, the usual one first: ['.md'], ['.R']. */
  extensions?: string[];
  schema: Schema;
  /** Must not throw on any UTF-8 input. Unrecognised syntax becomes raw nodes. */
  parse(text: string): ParsedDocument;
  /**
   * With `previous`, top-level blocks equal to a previous block are written
   * back from the previous source text, byte for byte.
   */
  serialize(doc: Node, previous?: ParsedDocument): string;
  /** Client only. */
  editor?: EditorContribution;
}

export class TypeRegistry {
  private readonly types = new Map<string, DocumentType>();

  register(type: DocumentType): void {
    if (this.types.has(type.id)) throw new Error(`Document type already registered: ${type.id}`);
    this.types.set(type.id, type);
  }

  get(id: string): DocumentType | undefined {
    return this.types.get(id);
  }

  all(): DocumentType[] {
    return [...this.types.values()];
  }

  /** The best type for a file, or undefined if none claims it. */
  resolve(path: string, head = ''): DocumentType | undefined {
    let best: DocumentType | undefined;
    for (const t of this.types.values()) {
      if (!t.match(path, head)) continue;
      if (!best || (t.priority ?? 0) > (best.priority ?? 0)) best = t;
    }
    return best;
  }
}

export interface Command<C = unknown> {
  id: string;
  title: string;
  run: (ctx: C) => boolean | Promise<boolean>;
}

export class CommandRegistry<C = unknown> {
  private readonly commands = new Map<string, Command<C>>();
  register(cmd: Command<C>): () => void {
    this.commands.set(cmd.id, cmd);
    return () => this.commands.delete(cmd.id);
  }
  get(id: string): Command<C> | undefined {
    return this.commands.get(id);
  }
  all(): Command<C>[] {
    return [...this.commands.values()];
  }
  async run(id: string, ctx: C): Promise<boolean> {
    const cmd = this.commands.get(id);
    return cmd ? await cmd.run(ctx) : false;
  }
}

export type HookEvent =
  | 'open' | 'change' | 'save' | 'commit' | 'pull' | 'merge' | 'rename' | 'delete';

export interface HookHandler<P> {
  order?: number;
  /** Before-hooks may return a modified payload, or `false` to veto. */
  before?: (payload: P) => P | false | void | Promise<P | false | void>;
  after?: (payload: P) => void | Promise<void>;
}

export class HookBus {
  private readonly handlers = new Map<HookEvent, HookHandler<unknown>[]>();

  on<P>(event: HookEvent, handler: HookHandler<P>): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as HookHandler<unknown>);
    list.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    this.handlers.set(event, list);
    return () => {
      const l = this.handlers.get(event);
      if (l) this.handlers.set(event, l.filter((h) => h !== handler));
    };
  }

  /** Runs before-hooks in order. Returns the final payload, or null if vetoed. */
  async before<P>(event: HookEvent, payload: P): Promise<P | null> {
    let current = payload;
    for (const h of this.handlers.get(event) ?? []) {
      if (!h.before) continue;
      const result = await h.before(current);
      if (result === false) return null;
      if (result !== undefined) current = result as P;
    }
    return current;
  }

  async after<P>(event: HookEvent, payload: P): Promise<void> {
    for (const h of this.handlers.get(event) ?? []) await h.after?.(payload);
  }
}

/** Equality of top-level block source text, used by serializers. */
export function sliceBlock(parsed: ParsedDocument, index: number): string {
  const b = parsed.blocks[index];
  return b ? parsed.text.slice(b.from, b.to) : '';
}

/** A stable short hash (FNV-1a, 32 bit) usable in any runtime. */
export function hashText(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + ':' + text.length.toString(36);
}
