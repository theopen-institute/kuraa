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
  /**
   * What it does, by name (0091): each command's label and keys said once, for
   * its menus (an item `{ command: id }`), the keys the core binds, and the
   * shortcuts sheet. Each panel is a command too, made by the core
   * (`panel:<id>`, opening it; its keys, if it has them).
   */
  commands?: FeatureCommand[];
  /** The heading its commands (and its panels' keys) are listed under on the shortcuts sheet: its label, if not said. */
  helpGroup?: string;
  /** Items for the open document's ⋯ menu, in a group of their own. */
  documentMenu?(ctx: FeatureDocumentContext): FeatureMenuEntry[];
  /**
   * A line for the foot of the open document's ⋯ menu, below when it was
   * saved (0094: its word count), made as the menu opens; null for none. With
   * `run`, it is chosen as an item is (clicked, or Enter): the menu closes,
   * then it runs (the Words panel opens).
   */
  documentFooter?(ctx: FeatureDocumentContext): { text: string; testid?: string; title?: string; run?(): void } | null;
  /** Items for a file's right-click menu, or a folder's (its path ending in `/`). */
  fileMenu?(path: string, ctx: FeatureClientContext): FeatureMenuEntry[];
  /**
   * A mark it puts on a file or a folder (its path ending in `/`) wherever
   * navigation shows them (0093: a manuscript's folder, a document left out of
   * it), or null. Asked again when it says its marks changed (`marksChanged`).
   */
  marks?(path: string, ctx: FeatureClientContext): FileMark | null;
  /** Its parts of Settings: the workspace's (its settings, while it is on there) and yours. */
  settings?: { workspace?: FeatureSettingsPanel; you?: FeatureSettingsPanel };
  /**
   * Lines for the Markdown and shortcuts sheet that are not commands: what it
   * adds to typing, and keys its own parts handle (a tree's arrows). Its
   * commands' and panels' keys are listed from them, not here.
   */
  help?: HelpItem[];
  /**
   * Called once it is in use for the open workspace (on there, and not hidden),
   * to start what it keeps while it is (what it knows of the workspace, for its
   * menus, say). Returns how to stop: when it goes out of use, or another
   * workspace is opened.
   */
  activate?(ctx: FeatureClientContext): (() => void) | void;
  /** The host's services it uses (CoreHost, 0091): only these are given it. */
  uses?: CoreService[];
  /** Where navigation goes in the window (0087): one layout is used at a time. */
  layout?: FeatureLayout;
  /** Ways of seeing the workspace's files (0087), drawn wherever the layout in use gives them room. */
  views?: NavigationView[];
  /**
   * Views of a folder drawn in the main area, where a document is (0096: a
   * corkboard, an outline): offered on a folder's menu, shown in place of the
   * open document until a document is opened.
   */
  folderViews?: FolderView[];
}

/**
 * A layout (0087): it puts navigation somewhere in the window (a sidebar, a
 * bar), with the workspace, its connection, the core's menus and the views
 * that are on. It is given the window's navigation area, to the left of the
 * document, as wide as it draws itself.
 */
export interface FeatureLayout {
  id: string;
  label: string;
  /**
   * It offers the workspaces and Settings itself (through workspaceMenu): while
   * a layout that does is in use, the core's own menu at the upper left is not
   * drawn.
   */
  navigation: boolean;
  mount(element: HTMLElement, ctx: LayoutContext): () => void;
}

/** How the open document (or, with none open, the host) is connected, in words, and who else is here. */
export interface ConnectionInfo {
  state: 'connected' | 'connecting' | 'disconnected' | 'unauthorized';
  /** In a word or two: "Connected". */
  label: string;
  /** All of it, in lines, for a tooltip: the connection and who else is here, then how the workspace syncs. */
  title: string;
  /** How the workspace syncs beyond this computer, a line each. */
  syncing: string[];
  /** Who has the open document open, by name, you marked as you. */
  peers: string[];
}

/** What the client gives a layout. Everything here is the core's: the layout only places it. */
export interface LayoutContext extends FeatureClientContext {
  /**
   * The open workspace's name (with none open: what to call the list of
   * workspaces), and whether there is a menu of workspaces (workspaceMenu) to
   * offer: none on a host of one folder alone.
   */
  workspace(): { name: string; open: boolean; menu: boolean };
  connection(): ConnectionInfo;
  /** Be told when the workspace, its connection, the views or the panels' buttons change. Returns how to stop. */
  onChange(fn: () => void): () => void;
  /** The core's menu of workspaces (switch, add, sync, Settings), under an element. */
  workspaceMenu(at: HTMLElement): void;
  /** The core's ＋ menu (New file, New folder…, and what the views add), under an element; pressed again, it closes. */
  newMenu(at: HTMLElement): void;
  /** Whether ＋'s menu is open (for its button's aria-expanded). */
  newMenuOpen(): boolean;
  /** A new document, at once (0097: ＋): opened with the cursor in its title, no file until something is written in it. */
  newDocument(): void;
  /** The workspace's panels with an icon (Search), to offer as buttons. */
  panelButtons(): { feature: string; id: string; label: string; keys?: string; icon: FileIcon }[];
  askPanel(feature: string, id: string): void;
  /** The navigation views that are on, from every feature, each to draw where the layout chooses. */
  views(): { key: string; label: string; mount(element: HTMLElement): () => void }[];
  /** Move a file or folder into a folder ('' for the top), as a drop on the layout. */
  move(path: string, folder: string): void;
}

/** A file as navigation sees it (the core's list: companions folded under their documents, app folders left out by views). */
export interface NavigationFile {
  path: string;
  /** Its type's id; null for a file the app does not open. */
  type: string | null;
  /** A document's title (null: it has none yet); absent for other files. */
  title?: string | null;
  /** Conflicts a merge kept in it, to choose between: absent if none. */
  conflicts?: number;
  /** Why the app does not open it, if it does not. */
  cannotOpen?: string;
  /** Who reads it, in words, if not everyone (0066); who may change it, if not anyone (0069). */
  readers?: string;
  writers?: string;
}

/**
 * A navigation view (0087): one way of seeing the workspace's files (a tree, a
 * manuscript). It shows them; what is done to them is the core's.
 */
export interface NavigationView {
  id: string;
  label: string;
  mount(element: HTMLElement, ctx: NavigationContext): () => void;
  /** What it adds to the ＋ menu, after the core's New file and New folder (a manuscript's New chapter). */
  newItems?(ctx: NavigationContext): FeatureMenuEntry[];
}

/** What the client gives a navigation view. */
export interface NavigationContext extends FeatureClientContext {
  /** The open workspace's name. */
  workspaceName(): string;
  files(): NavigationFile[];
  /** Folders with permissions of their own (0069), by path ending in `/`: who reads, who may change, in words. */
  folders(): { path: string; readers?: string; writers?: string }[];
  /** The open file. */
  selected(): string | null;
  /** Be told when the files, the folders or the open file change. Returns how to stop. */
  onChange(fn: () => void): () => void;
  /**
   * Be told of a place to show: a file or folder just made or moved there
   * (its folder should be open), or a folder renamed (`from` its old path).
   * Returns how to stop.
   */
  onReveal(fn: (path: string, from?: string) => void): () => void;
  open(path: string): void;
  /** Open a file at its first conflict. */
  openConflicts(path: string): void;
  /** The pointer rests on a file (null: it left): it is got ready ahead, to open sooner. */
  prefetch(path: string | null, now?: boolean): void;
  /** Nothing open: a blank page, a new document with no file until something is written in it (0097: the space below the files clicked). */
  blank(): void;
  /** A new document, in a folder (none: the top level), opened with the cursor in its title: its path once made, or null if it was not. */
  newFile(folder?: string): Promise<string | null>;
  /** A new folder, its name asked for, in a folder (none: the top level). */
  newFolder(parent?: string): void;
  /** Rename a file (its title and name, for a document) or a folder (`path` ending in `/`). */
  rename(path: string): void;
  /** Delete a file, once the person says so. */
  remove(path: string): void;
  /** Move a file or folder into a folder ('' for the top). */
  move(path: string, folder: string): void;
  /**
   * A folder's order (0093), as people arranged it: the names of its files and
   * folders ('' for the top level); null where it has none (shown by name).
   * What it does not name follows what it does.
   */
  order(folder: string): string[] | null;
  /**
   * Put a file or folder in a folder ('' for the top) at a place: moved there
   * if it is elsewhere, and the folder's order made `names` (the names of all
   * in it, as they are to be shown, its own among them). Whether it was done
   * (what went wrong is said).
   */
  place(path: string, folder: string, names: string[]): Promise<boolean>;
  /** A folder's order forgotten: shown by name again. */
  sortByName(folder: string): void;
  /** Features' marks on a file or a folder (`path` ending in `/`), as they are now (0093). */
  marks(path: string): FileMark[];
  /** The core's menu for a file, a folder (`path` ending in `/`) or the top level (''), at a point. */
  fileMenu(path: string, at: { x: number; y: number }): void;
  /**
   * Show a folder ('' the top level) in the main area, in a folder view
   * (0096: `feature:view`, as `'corkboard:outline'`; none: the one last
   * shown, else the first there is). Whether it was: false where no
   * component gives a folder view.
   */
  showFolder(folder: string, view?: string): boolean;
  /** The folder shown in the main area, if one is (0096), for navigation to mark it. */
  shownFolder(): string | null;
  /** A file's icon, as its type defines it (0023). */
  icon(file: NavigationFile): FileIcon | undefined;
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
  /**
   * The host's own services (0089, 0091): the core's routes, not the feature's.
   * Only those the feature says it uses (`uses`) are given it.
   */
  host: CoreHost;
  /** An error in plain words, and what was actually said, as the client says errors everywhere. */
  explain(error: unknown): { text: string; details: string | null };
  /** Keys, as key bindings write them ('Mod-Shift-f'), as this system shows them (⇧⌘F, Ctrl+Shift+F). */
  keyLabel(keys: string): string;
  /**
   * Move or rename a file (or folder), as the file tree's rename does: what is
   * kept beside it goes with it, it is committed, and anyone with it open
   * follows it (0090: a manuscript that keeps its files in place). Rejects,
   * saying why, where it cannot be (someone may not, a file is there already).
   */
  moveFile(from: string, to: string): Promise<void>;
  /** Its marks on files changed (0093): navigation asks for them again. */
  marksChanged(): void;
}

/** A feature's mark on a file or folder in navigation (0093). */
export interface FileMark {
  /** What it means, in words: shown on pointing, and said to screen readers. */
  label: string;
  /** Drawn beside the name. */
  icon?: FileIcon;
  /** The file shown faded (left out of something). */
  muted?: boolean;
  /** A colour (CSS), drawn as a dot by the name where there is no icon (0094: a document's label). */
  color?: string;
  /** For tests. */
  testid?: string;
}

/** The open document's header fields (0094), as YAML has them. */
export interface DocumentHeader {
  /** A field's value (a string, a number, a list, …), or undefined where it has none. */
  get(key: string): unknown;
  /** Set fields (undefined or null takes one away), as one edit; the rest of the header, its comments among it, as it is. */
  set(fields: { [key: string]: unknown }): void;
}

/** A day's words, by person (0094): net (how many more) and added (written, a rewrite counting too). */
export interface WordsDay {
  /** YYYY-MM-DD. */
  date: string;
  people: { name: string; email: string; net: number; added: number }[];
}

/** A view of a folder in the main area (0096). */
export interface FolderView {
  id: string;
  /** What it is called on a folder's menu ('Corkboard'). */
  label: string;
  /** Draw it into `element` for the folder the context says; returns how to take it down. */
  mount(element: HTMLElement, ctx: FolderViewContext): () => void;
}

/** What a folder view is given: navigation's, and the folder it shows. */
export interface FolderViewContext extends NavigationContext {
  /** The folder shown ('' the top level). */
  folder(): string;
  /** The folder views there are, to switch between (`feature:view`, and what each is called). */
  folderViews(): { key: string; label: string }[];
  /** This view's own key (`feature:view`). */
  viewKey(): string;
}

/** A folder or document a folder's book could have (0093). */
export interface BookContent {
  kind: 'folder' | 'document';
  path: string;
  /** A document's title (its filename, without one), a folder's name. */
  title: string;
  /** How deep it is in the folder compiled: 1 in the folder itself. */
  depth: number;
  /** A document's words, as its file has them (0094). */
  words?: number;
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

/**
 * The host's own services offered to components (0089, 0091), each a group of
 * the core's calls: what a component may ask of the host besides its own
 * routes. A feature says which it uses (`ClientFeature.uses`); one it did not
 * say it uses is not given it (using it throws, saying so). Each call rejects
 * as the client's own calls do.
 */
export interface CoreHost {
  search: SearchService;
  renders: RenderService;
  tools: ToolService;
  code: CodeService;
  history: HistoryService;
  documents: DocumentService;
}

/** A service of the host's (CoreHost), by name. */
export type CoreService = keyof CoreHost;

/** Documents, whether open or not (0096). */
export interface DocumentService {
  /**
   * Set fields of a document's header (its front matter), as one change;
   * undefined, null or '' takes one away; the rest of it, comments and all, as
   * it is. Where it is open, everyone in it sees the change at once.
   */
  setHeader(path: string, fields: { [key: string]: unknown }): Promise<void>;
}

/** The workspace's history, read (0094). */
export interface HistoryService {
  /**
   * Words written each day from `since` (YYYY-MM-DD), by person, newest day
   * first: every commit on the branch but merges, each credited in full to
   * everyone credited on it, on its own day; and what is typed here and not
   * committed yet, today.
   */
  wordsByDay(since: string): Promise<WordsDay[]>;
}

/** Searching the workspace (0042). */
export interface SearchService {
  /** Search the workspace's text files, and open documents as they are now. */
  run(query: string, caseSensitive: boolean): Promise<SearchResult>;
}

/** Rendering documents (0041), and what their outputs were made from (0081). */
export interface RenderService {
  /** A document's renders, or a folder's (its path ending in `/`, the top level `/`: 0093): what it can be rendered to, and how its latest ones stand. */
  info(path: string): Promise<RenderInfo>;
  /**
   * Render a document (as you, for the record); a render that cannot start says
   * why, as a failed one. A folder (its path ending in `/`, the top level `/`)
   * is compiled (0093): its folders and documents in the file tree's order,
   * but those `exclude` names (paths; a folder's, all in it), joined under
   * `title`, how deep each is its heading's level; the folders `noHeading`
   * names (paths) with no heading, nor a level, of their own.
   */
  render(path: string, format: RenderFormat, compile?: { exclude?: string[]; noHeading?: string[]; title?: string }): Promise<RenderState>;
  /** A document's latest output in a format. */
  output(path: string, format: RenderFormat): Promise<Blob>;
  /** The files a document's latest output was made from, as they were, in a zip (0081). */
  madeFrom(path: string, format: RenderFormat): Promise<Blob>;
  /**
   * What a folder's book could have (its path ending in `/`, the top level
   * `/`: 0093): its folders and documents, nothing left out, in the file
   * tree's order, each at how deep it is (1: in the folder itself).
   */
  bookContents(folder: string): Promise<BookContent[]>;
}

/**
 * The open document's code session (0011, 0092), where its type runs code: the
 * session on the host that runs its chunks, as this client follows it. Running
 * a chunk from the document is the core's (its node views); a component offers
 * the rest: running everything, stopping, starting again, the packages.
 */
export interface CodeService {
  /** The open document's session, or null (none open, or its type runs no code). */
  session(): CodeSession | null;
  /** Be told when the open document's session is another (a document opened, closed). Returns how to stop. */
  onSession(fn: () => void): () => void;
}

export interface CodeSession {
  /** How it stands now (read anew when onChange says). */
  status(): CodeSessionStatus;
  /** Be told when how it stands changes. Returns how to stop. */
  onChange(fn: () => void): () => void;
  /** Run every chunk, top to bottom. */
  runAll(): Promise<void>;
  /** Interrupt, and drop queued runs. */
  interrupt(): Promise<unknown>;
  /** A fresh session: everything defined so far is gone. */
  restart(): Promise<unknown>;
  /** The workspace's packages for an engine (0014). */
  listPackages(engine: string): Promise<PackageInfo[]>;
  installPackages(engine: string, refs: string[]): Promise<PackageResult>;
  removePackages(engine: string, names: string[]): Promise<PackageResult>;
}

export interface CodeSessionStatus {
  /** The language, as people call it: 'R'. */
  engine: string;
  /** The session's state: 'none', 'starting', 'ready', 'busy', 'stopped', 'failed'. */
  state: string;
  /** What it says as it starts, if anything. */
  message: string | null;
  /** Where code runs (0019), if the host says. */
  environment: { label: string; sandboxed: boolean; available: boolean; message?: string } | null;
  /** Why code cannot run now (Podman missing, say), or null. */
  unavailable: string | null;
  /** Something is running or queued. */
  busy: boolean;
  /** The document has chunks this host can run. */
  runnable: boolean;
  /** The engine whose packages the workspace keeps (null: none). */
  packageEngine: string | null;
  /** The engines, by id and label. */
  engines: { id: string; label: string }[];
  /** Whether people may install packages here (the host's choice). */
  allowInstalls: boolean;
  /** The latest the host said of packages being changed: for an engine, what it says, and when. */
  packageNews: { engine: string; message: string; at: number } | null;
}

/** A package as the workspace has it (0014). */
export interface PackageInfo {
  name: string;
  version: string;
  /** In the workspace's own library, or the environment's. */
  source: 'workspace' | 'environment';
}

export interface PackageResult {
  ok: boolean;
  message: string;
  log?: string;
}

/** The tools this computer has or may download (0045). */
export interface ToolService {
  list(): Promise<{ tools: ToolState[] }>;
  /** Download a tool; follow it with list(). */
  download(id: string): Promise<void>;
  /** Be told when the host says a tool changed (downloaded, removed). Returns how to stop. */
  onChanged(fn: () => void): () => void;
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
  selectionActions?(view: EditorView): FeatureMenuEntry[];
  /**
   * How this document does the feature's `editor` commands (0091), by id: true
   * if it did. Their keys are bound in the editor, while it has the focus.
   */
  commands?: { [id: string]: (view: EditorView) => boolean };
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
  /** Its keys, as key bindings write them ('Mod-Alt-m'): shown beside it, not bound by the client (a command's are). */
  keys?: string;
  testid?: string;
  /** Shown, but not to be chosen now (0092). */
  disabled?: boolean;
  /** What it says when pointed at. */
  title?: string;
}

/**
 * A line of words in a menu, not to be chosen (0092): how something stands
 * ("R ready · in a Podman container"). In the document's ⋯ menu; other menus
 * leave it out.
 */
export interface FeatureMenuNote {
  note: string;
  title?: string;
  testid?: string;
  /** Classes for its look (its feature styles them). */
  className?: string;
}

/** A menu item that is one of the feature's commands (0091): its label (unless given), its keys and what it does are the command's. */
export interface FeatureCommandItem {
  /** The command's id: one of the feature's `commands`, or `panel:<id>` for one of its panels. */
  command: string;
  label?: string;
  testid?: string;
}

/** What a feature puts in a menu: an item of its own, or one of its commands. */
export type FeatureMenuEntry = FeatureMenuItem | FeatureCommandItem | FeatureMenuNote;

/**
 * Something a feature does, by name (0091). Its keys are bound by the core,
 * once: keys another command or the app already has are refused (said in the
 * console, and by the tests of the standard features), never bound twice.
 */
export interface FeatureCommand {
  /** Its id within the feature ('comment'); `panel:` is the core's, for panels. */
  id: string;
  /** What it is called in menus: 'Comment'. */
  label: string;
  /** Its keys, as key bindings write them ('Mod-Alt-m'). */
  keys?: string;
  /**
   * Where it is done:
   * - `workspace` (the default): anywhere on the page, by `run`.
   * - `document`: while a live document is open, by `run`.
   * - `editor`: in the open document, its keys bound in the editor while it has
   *   the focus, done by the document's FeatureEditor (`commands[id]`).
   */
  about?: 'workspace' | 'document' | 'editor';
  run?(ctx: FeatureClientContext): void;
  /** What the shortcuts sheet says it does, where it has keys: its label, if not said; false: not listed. */
  help?: string | false;
  /** A word more on the sheet, shown quietly after it. */
  note?: string;
}

export interface FeatureDocumentContext extends FeatureClientContext {
  path: string;
  type: DocumentType;
  /** The Source view is shown, not the rich one. */
  source: boolean;
  /** The open document's live view, while it is ready (0094: its words, counted as the menu opens). */
  view(): EditorView | null;
  /** The open document's header, as panels have it (0094). */
  header(): DocumentHeader | null;
}

/** Where a panel is drawn (FeaturePanel.place). */
export type PanelPlace = 'side' | 'over' | 'dialog';

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
   * Where it is drawn (0091), the core arranging each place:
   *
   * - `side` (the default): beside the document, one panel at a time, under a
   *   heading of the client's (its label, and closing it).
   * - `over`: a document's panel over the document's top left, all of it the
   *   panel's own (no heading of the client's); it stays open beside any other
   *   panel. Over the rich view only (0089).
   * - `dialog`: over the whole page, modal (0092): the client draws the window
   *   (its backdrop, keeping the focus in it, Escape and a click outside closing
   *   it, unless held open: holdOpen); all inside it is the panel's own. Over
   *   any other window (Settings), which stays beneath it.
   *
   * A place added later (a bar below the document, say) is a value added here;
   * a client that does not know a panel's place draws it beside the document.
   */
  place?: PanelPlace;
  /** Its icon, drawn as a file's is: a workspace's panel with one is offered as a button where navigation is (Search's). */
  icon?: FileIcon;
  /** What the shortcuts sheet says its keys do: its label, if not said; false: not listed (0091). */
  help?: string | false;
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
  /**
   * The open document's header (its front matter: 0094), where its format has
   * one and it is open and ready; null otherwise. Changing it is an edit like
   * any other, everyone in the document sees it, and it can be undone.
   */
  header(): DocumentHeader | null;
  close(): void;
  /** A dialog's (0092): while held, Escape and a click outside do not close it (something it started is under way). */
  holdOpen(hold: boolean): void;
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
