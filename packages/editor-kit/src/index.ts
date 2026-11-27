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
  /** Say something in passing (an image that could not be added), as the client shows its notices. */
  notify?(text: string, kind?: 'info' | 'warn'): void;
  /**
   * The spell checker, where the page can ask it (the desktop app's): for a
   * menu of the format's own, which takes the place of the one with spelling
   * suggestions (a table's). Absent in a browser, which does not say.
   */
  spelling?: Spelling;
}

/** A spell checker the page can ask. */
export interface Spelling {
  /** A misspelled word's suggestions (perhaps none); null if it is spelled right. */
  suggest(word: string): string[] | null;
  /** Take a word as spelled right from now on (the computer's dictionary). */
  learn(word: string): void;
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
  /** The document's path in the workspace (`chapters/one.md`), where it has one. */
  path?: string;
  /** The workspace's files, as the document reaches them: absent where there is no host to ask. */
  files?: WorkspaceFiles;
}

/**
 * The workspace's files, for what a document refers to: its bibliography, its
 * images. Paths are relative to the workspace, with `/` between folders.
 */
export interface WorkspaceFiles {
  /** A file's text; null if there is none (or it cannot be read). */
  text(path: string): Promise<string | null>;
  /** An address an `<img>` can show a workspace image at (made for this page, not shared); null if there is none. */
  imageUrl(path: string): Promise<string | null>;
  /**
   * Keep an image in the workspace, in the `images/` folder next to the
   * document, under a safe name not yet taken. Resolves to its path relative to
   * the document (`images/plot.png`); rejects with a message to show.
   */
  uploadImage(file: Blob, name: string): Promise<string>;
  /** Who made a commit and when (an ISO date), for labels; null if it is not known. */
  commit(hash: string): Promise<{ author: string; date: string } | null>;
}

/**
 * Commands a format offers the client by name, for its menu and for links
 * elsewhere in the app (a file's conflict count opens it at the first conflict).
 * Each is an ordinary ProseMirror command; a format offers those it has.
 */
export interface FormatCommands {
  /** Put a small table at the cursor. */
  insertTable?: Command;
  /** Move to the next conflict a merge kept in the document, wrapping round to the first. */
  nextConflict?: Command;
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
   * client edits it in Document settings; the format keeps it out of the page
   * (only the Source view shows it as text).
   */
  header?: HeaderSpec;
  /** Commands the client may offer by name (FormatCommands). */
  commands?(ctx: EditorContext): FormatCommands;
  /**
   * What people can type and press in documents of this type, for the client's
   * Markdown and shortcuts sheet. Listed from the same data that makes the key
   * bindings, where that is practical, so the sheet says what the keys do.
   */
  help?: HelpItem[];
}

/**
 * One line of the Markdown and shortcuts sheet: one thing, with what to type for
 * it and the keys for it side by side (either, or both).
 */
export interface HelpItem {
  /** The heading it is listed under: 'Text', 'Paragraphs', 'Editing'. Lines with the same heading are listed together. */
  group: string;
  /** What it is, in a word or two: 'Bold', 'Block quote'. */
  does: string;
  /** What to type for it, shown as written: '# ', '**bold**'. */
  type?: string;
  /** Whether the typed cue takes effect with Enter (``` then Enter), shown after it. */
  enter?: boolean;
  /** The keys for it, as key bindings write them ('Mod-b', 'Mod-Alt-1'); the client shows them for the system. */
  keys?: string[];
  /** A word more, shown quietly after what it is: 'or paste or drop one'. */
  note?: string;
}

/**
 * Transactions that change the document's text on purpose rather than by typing
 * in the page (the Source view, Document settings) carry this meta, set to true,
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

// Paths a document writes (its bibliography, its images, its links) are relative to the
// document. The workspace's files are named from the workspace's top.

/**
 * A path written in the document at `docPath`, as a workspace path; null if it
 * is an address (https:, data:), absolute, or leads outside the workspace.
 */
export function workspacePath(docPath: string, written: string): string | null {
  let p = written.trim();
  if (!p || /^[a-z][a-z0-9+.-]*:/i.test(p) || p.startsWith('/') || p.startsWith('\\') || p.startsWith('~')) return null;
  try {
    p = decodeURI(p);
  } catch { /* as written */ }
  p = p.split(/[?#]/)[0]!;
  const parts = docPath.split('/').slice(0, -1);
  for (const part of p.split(/[\\/]+/)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.length ? parts.join('/') : null;
}
