// A feature's client half: what it adds to the editor and the interface. Framework
// free, as editor modules are (decision 0016): it contributes ProseMirror plugins,
// items the client draws (in the margin, beside a selection, in menus), and panels
// and settings it draws itself into an element the client gives it.
//
// The shell passes client halves to the client by id (mountApp's `features`), as
// it passes editor modules; the client uses one only where the host has the
// feature loaded, and it is on for the workspace, and the person has not hidden it.
import type { DocumentType, FileIcon, SourceMap } from '@kuraa/kernel';
import type { EditorUi, HelpItem } from '@kuraa/editor-kit';
import type { Node, Schema } from 'prosemirror-model';
import type { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { FEATURE_API_VERSION, type Anchor, type FeatureSettings, type FeatureStatus, type Json, type Person } from './index.js';

export * from './index.js';

export interface ClientFeature {
  apiVersion: number;
  /** The id of its host half. */
  id: string;
  /** For each open document: the live one, and past versions (read only). */
  editor?(ctx: FeatureEditorContext): FeatureEditor;
  /** Panels beside the document, its own or the workspace's. */
  panels?: FeaturePanel[];
  /** Items for the open document's ⋯ menu, in a group of their own. */
  documentMenu?(ctx: FeatureDocumentContext): FeatureMenuItem[];
  /** Items for a file's right-click menu in the file list. */
  fileMenu?(path: string, ctx: FeatureClientContext): FeatureMenuItem[];
  /** Its parts of Settings: the workspace's (its settings, while it is on there) and yours. */
  settings?: { workspace?: FeatureSettingsPanel; you?: FeatureSettingsPanel };
  /** Lines for the Markdown and shortcuts sheet: what it adds to typing and keys. */
  help?: HelpItem[];
}

/** What the client gives a feature wherever it is used. */
export interface FeatureClientContext {
  /** The feature as the host says it stands for the open workspace (its settings among it). */
  status(): FeatureStatus;
  /** You, as the app knows you. */
  person(): Person;
  /** Its own routes on the host (/api/features/<id>/<path>). Rejects with the host's message. */
  request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', path: string, body?: Json): Promise<Json>;
  /** Change its settings for the workspace (committed, for everyone in it). Rejects, saying why, where this person may not. */
  saveSettings(settings: FeatureSettings): Promise<void>;
  /** Say something in passing, as the client shows its notices. */
  notify(text: string, kind?: 'info' | 'warn'): void;
  /** Dialogs in the client's style. */
  ui: EditorUi;
  /** Open one of its panels. */
  openPanel(id: string): void;
  /** Open a file, at a range of its text (offsets in the file's text), if given. */
  openFile(path: string, at?: { from: number; to: number }): void;
  /** Be told what its host half tells (FeatureContext.tell): with the path it was about, if any. Returns how to stop. */
  onMessage(fn: (message: Json, path: string | null) => void): () => void;
  /** Open a file at a match (0089): a line, where on it, and the words, found again in an open document as it has been typed since. */
  openMatch(path: string, target: MatchTarget): void;
  /** The host's own calls a component may make (0089): the core's routes, not the feature's. */
  host: CoreHost;
  /** An error in plain words, and what was actually said, as the client says errors everywhere. */
  explain(error: unknown): { text: string; details: string | null };
  /** Keys, as key bindings write them ('Mod-Shift-f'), as this system shows them (⇧⌘F, Ctrl+Shift+F). */
  keyLabel(keys: string): string;
}

/** A match to open a file at (0089). */
export interface MatchTarget {
  /** 1-based line of the file (or of the open document's text) the match was on. */
  line: number;
  /** Where the match starts in that line. */
  at: number;
  query: string;
  caseSensitive: boolean;
}

/** A format a document renders to (the host's renders, 0041). */
export type RenderFormat = 'html' | 'docx' | 'pdf';

/** A document's latest render in one format. */
export interface RenderState {
  path: string;
  format: RenderFormat;
  state: 'rendering' | 'done' | 'failed';
  message: string;
  progress: string | null;
  log: string;
  by: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** The latest output, and what it was made from (0081): the files that differed from the commit, and how many more. */
  output: { at: string; size: number; madeFrom?: { uncommitted: readonly unknown[]; more?: number } } | null;
  /** A tool the document needs that this computer lacks, and people may download. */
  needs?: { tool: string; label: string; downloadBytes: number } | null;
}

export interface RenderInfo {
  /** Formats the document can be rendered to here; none if it cannot be. */
  formats: RenderFormat[];
  /** Why it cannot be rendered now, if it cannot. */
  unavailable: string | null;
  renders: RenderState[];
}

/** Where a phrase was found (the host's search, 0042). */
export interface SearchMatch { line: number; column: number; text: string; at: number }
export interface SearchFile { path: string; type: string | null; title?: string | null; live: boolean; matches: SearchMatch[] }
export interface SearchResult { files: SearchFile[]; truncated: boolean }

/** A tool (TeX, say) as far as a component follows it (0045). */
export interface ToolState {
  id: string;
  label: string;
  state: 'absent' | 'downloading' | 'ready' | 'adding' | 'removing';
  progress: string | null;
  error: string | null;
}

/** The host's calls offered to components (0089). Each rejects as the client's own calls do. */
export interface CoreHost {
  /** Search the workspace's text files, and open documents as they are now. */
  search(query: string, caseSensitive: boolean): Promise<SearchResult>;
  /** A document's renders: what it can be rendered to, and how its latest ones stand. */
  renders(path: string): Promise<RenderInfo>;
  /** Render a document (as you, for the record); a render that cannot start says why, as a failed one. */
  render(path: string, format: RenderFormat): Promise<RenderState>;
  /** A document's latest output in a format. */
  renderOutput(path: string, format: RenderFormat): Promise<Blob>;
  /** The files a document's latest output was made from, as they were, in a zip (0081). */
  renderMadeFrom(path: string, format: RenderFormat): Promise<Blob>;
  /** The tools this computer has or may download. */
  tools(): Promise<{ tools: ToolState[] }>;
  /** Download a tool; follow it with tools(). */
  downloadTool(id: string): Promise<void>;
  /** Be told when the host says a tool changed (downloaded, removed). Returns how to stop. */
  onToolsChanged(fn: () => void): () => void;
}

/**
 * A live document's state for the feature (its room's), shared with everyone in
 * it: your own entries, which you change and your devices write to your file;
 * everyone else's in the room, which you see. Theirs are theirs (0082).
 */
export interface FeatureState {
  /** You: your identity ID. */
  readonly me: string;
  /** Your entries. */
  entries(): { [key: string]: Json };
  /** Everyone else's in the room, by person (people with no device in the room: their files, `companions`). */
  others(): { [person: string]: { [key: string]: Json } };
  /** Set or remove your entries, as one change. */
  update(changes: { set?: { [key: string]: Json }; remove?: string[] }): void;
  /** Be told when anything in it changes (yours or anyone's, here or elsewhere in the room). Returns how to stop. */
  observe(fn: () => void): () => void;
  /** An anchor at a position of the live document (assoc: the side it keeps to when text is typed there; -1 the left, else the right). */
  anchorAt(pos: number, assoc?: -1 | 1): Anchor;
  /** Where an anchor is now, or null if what it was at is gone. */
  positionOf(anchor: Anchor): number | null;
}

export interface FeatureEditorContext extends FeatureClientContext {
  path: string;
  type: DocumentType;
  schema: Schema;
  /**
   * A past version, or a document this person may not change: the document is
   * shown, not changed. What is theirs to say about it (their own annotations)
   * they may, where `state` is given.
   */
  readOnly: boolean;
  /**
   * The live document's state for the feature; null for a past version, or
   * where nothing you do here would be kept (you have no identity yet, or the
   * room keeps none of yours: a device of yours with the feature is not in it).
   */
  state: FeatureState | null;
  /**
   * Everyone's own files beside the document by a suffix, with their text: as
   * they are (for people with no device in the room) or, for a past version,
   * as they were then.
   */
  companions(suffix: string): Promise<{ person: string; text: string }[]>;
  /** Places in a document and in its text, for the document as it is in `doc` (with its text, from the type). */
  sourceMap(doc: Node): SourceMap;
  /** Ask the client to draw again what it draws for the feature (the margin, the selection's actions). */
  redraw(): void;
}

/** What a feature does in one open document. */
export interface FeatureEditor {
  /** ProseMirror plugins: decorations, keys. After the format's, before the client's generic ones. */
  plugins?(): Plugin[];
  /** Marks for the margin beside the text, each at a place in the document. */
  margin?(view: EditorView): MarginItem[];
  /** What can be done with the selected text, offered beside it while there is a selection. */
  selectionActions?(view: EditorView): FeatureMenuItem[];
  destroy?(): void;
}

/** A mark in the margin, beside the line its place is on. The client keeps marks clear of each other. */
export interface MarginItem {
  /** Stable while it stays, so it is drawn once. */
  key: string;
  /** Its place in the document. */
  pos: number;
  /** What it says: a few characters, or for a tag a short name. */
  label: string;
  /** What it says when pointed at. */
  title?: string;
  color?: string;
  /**
   * How it is drawn: a mark (a few characters: the default), or a tag (a short
   * name, as a code's, as wide as it needs up to the room beside the text, cut
   * short there, its title saying it in full).
   */
  kind?: 'mark' | 'tag';
  /** Drawn as pointed at: what it is about is pointed at in the text, say. */
  active?: boolean;
  /** Pointed at, and then no longer: to show what it is about. */
  hover?(on: boolean): void;
  /** Clicked: given the mark as drawn, to open something beside it. */
  run?(element: HTMLElement): void;
}

export interface FeatureMenuItem {
  label: string;
  run(): void;
  /** Its keys, as key bindings write them ('Mod-Alt-m'): shown beside it, not bound by the client. */
  keys?: string;
  testid?: string;
}

export interface FeatureDocumentContext extends FeatureClientContext {
  path: string;
  type: DocumentType;
  /** The Source view is shown, not the rich one. */
  source: boolean;
}

/** A panel the feature draws: beside the open document, or about the workspace. */
export interface FeaturePanel {
  id: string;
  label: string;
  /** About the open document (closed when none is open), or the workspace. */
  about: 'document' | 'workspace';
  /** Keys that open it, as key bindings write them; the client binds them while the feature is on. */
  keys?: string;
  /**
   * Whether its keys close it while it is open (the default). False: asked for
   * again while open, it is asked again (onAsk), as ⇧⌘R renders again (0089).
   */
  toggle?: boolean;
  /**
   * A document's panel drawn over the document's top left, all of it the
   * panel's own (no heading of the client's), not in the place beside it: it
   * stays open beside any other panel. Over the rich view only (0089).
   */
  over?: boolean;
  /** Its icon, drawn as a file's is: a workspace's panel with one is offered as a button where navigation is (Search's). */
  icon?: FileIcon;
  /** Draw it into `element`; returns how to take it down. */
  mount(element: HTMLElement, ctx: FeaturePanelContext): () => void;
}

export interface FeaturePanelContext extends FeatureClientContext {
  /** The open document's path, if one is open (it changes: onDocument says when). */
  path(): string | null;
  /** The open document's live view, while it is open and ready. */
  view(): EditorView | null;
  /** The open document's state for the feature, while it is open. */
  state(): FeatureState | null;
  /** Be told when the open document changes: another is opened, it is edited, its state changes. Returns how to stop. */
  onDocument(fn: () => void): () => void;
  /**
   * The open document as the client follows it, while one is open: when it was
   * last written to its file, and how many edits made here have not reached
   * the host yet (0089).
   */
  document(): { path: string; writtenAt: string | null; unsynced: number } | null;
  /** Be told each time the panel is asked for (its keys, a menu, openPanel): once as it opens by being asked, and again while open where it does not toggle. Returns how to stop. */
  onAsk(fn: () => void): () => void;
  close(): void;
}

/** A part of Settings the feature draws. */
export interface FeatureSettingsPanel {
  /** Its heading. */
  label: string;
  /**
   * Drawn in the list of features, under the feature's own checkbox, while it is on (a few switches, seen at once),
   * not in a subpanel of its own.
   */
  inline?: boolean;
  mount(element: HTMLElement, ctx: FeatureClientContext): () => void;
}

export function defineClientFeature(feature: Omit<ClientFeature, 'apiVersion'>): ClientFeature {
  return { apiVersion: FEATURE_API_VERSION, ...feature };
}
