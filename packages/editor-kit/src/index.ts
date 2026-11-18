// The client-side extension point for document formats.
//
// A format's core (schema, parser, serializer) is headless and runs on the host
// too. What a format does in the editor (typing cues, key bindings, commands,
// behaviour like keeping footnotes in order, its own node views) lives in a
// separate editor module, e.g. @kuraa/format-pandoc/editor, which implements
// FormatEditor. The shell passes those modules to the client by type id, and
// the client calls them when it opens a document of that type.
//
// The client keeps only what is generic: the editor shell, code blocks and
// running chunks, plain chips, the source-file layout, where clicks go.
import type { Schema } from 'prosemirror-model';
import type { Command, Plugin, Transaction } from 'prosemirror-state';
import type { NodeViewConstructor } from 'prosemirror-view';

/** Dialogs, drawn by the client in its own style. */
export interface EditorUi {
  /** Ask for a line of text. Null if cancelled. */
  askText(message: string, value?: string, ok?: string): Promise<string | null>;
  /** Ask a yes/no question. */
  askConfirm(message: string, ok?: string, danger?: boolean): Promise<boolean>;
}

export interface EditorContext {
  schema: Schema;
  /** A past version, shown read-only: contribute display only (no keys, no edits). */
  readOnly: boolean;
  /** Undo and redo for the shared document (they are the session's, not ProseMirror's history). */
  history: { undo: Command; redo: Command };
  /**
   * Whether a transaction came from someone else (or undo/redo) rather than this
   * user's own editing. Behaviour that tidies the document after an edit should
   * act only on the user's own edits, so two clients never make the same change.
   */
  isRemote(tr: Transaction): boolean;
  ui: EditorUi;
}

export interface FormatEditor {
  /** What it is called where people turn it on or off (the Components panel): 'Markdown editing'. */
  label?: string;
  /** A sentence on what it does. */
  description?: string;
  /**
   * ProseMirror plugins for documents of this type: input rules, key bindings,
   * behaviour. They come before the client's generic ones (undo/redo and
   * ProseMirror's base keymap), so their key bindings win.
   */
  plugins?(ctx: EditorContext): Plugin[];
  /** Node views the format draws itself. They take precedence over the views its hints describe. */
  nodeViews?(ctx: EditorContext): Record<string, NodeViewConstructor>;
  /**
   * The document's header (YAML metadata at the top), if the format has one. The
   * client edits it in its Header dialog; the format keeps it out of the page
   * (only the Source view shows it as text).
   */
  header?: HeaderSpec;
}

/**
 * Transactions that change the document's text on purpose rather than by typing
 * in the page (the Source view, the Header dialog) carry this meta, set to true,
 * so a format's guards (keeping its header out of reach of typing) let them through.
 */
export const DELIBERATE_EDIT = 'kuraa:deliberate-edit';

export interface HeaderSpec {
  /** The block that holds the header's YAML text. When present, it is the document's first block. */
  node: string;
  /** The fields the format knows, offered when adding one. Others can be added by name. */
  fields: HeaderField[];
  /** Fields every document has: always shown, first if missing, and never left empty or removed ('title'). */
  required?: string[];
}

/** A header field the format knows: how it is called, what it does, and how it is edited. */
export interface HeaderField {
  /** The YAML key: 'title', 'link-citations'. */
  key: string;
  /** What people see: 'Title', 'Link citations'. */
  label: string;
  /** What it does, in a sentence. */
  description?: string;
  /** Where it is listed among the fields to add: 'Title and authors', 'Citations', … */
  group: string;
  /**
   * How its value is edited. text: a line; paragraph: several lines; date: a
   * line, with today's date a click away; list: several lines of text; boolean:
   * on or off; number; yaml: the value as YAML (anything structured). A value
   * that does not fit (a list of authors with affiliations, say) is edited as YAML.
   */
  kind: 'text' | 'paragraph' | 'date' | 'list' | 'boolean' | 'number' | 'yaml';
  /** Usual values, suggested as people type (others are allowed). */
  choices?: string[];
  /** Its value when added. Without one: empty, or true for a boolean. */
  initial?: unknown;
}
