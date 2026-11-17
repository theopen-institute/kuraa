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
  /**
   * ProseMirror plugins for documents of this type: input rules, key bindings,
   * behaviour. They come before the client's generic ones (undo/redo and
   * ProseMirror's base keymap), so their key bindings win.
   */
  plugins?(ctx: EditorContext): Plugin[];
  /** Node views the format draws itself. They take precedence over the views its hints describe. */
  nodeViews?(ctx: EditorContext): Record<string, NodeViewConstructor>;
}
