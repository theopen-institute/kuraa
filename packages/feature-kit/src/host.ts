// A feature's host half: what it brings to every host that loads it, and what it
// does for each workspace where it is on. The host imports no feature: whoever
// starts it passes them (the command line, the desktop app, `pnpm dev`: the
// standard list in @kuraa/features), as run components are.
import type { Node } from 'prosemirror-model';
import type { DocumentType, ParsedDocument, SourceMap } from '@kuraa/kernel';
import { FEATURE_API_VERSION, type Anchor, type FeatureSettings, type Json, type Person } from './index.js';

export * from './index.js';

export interface HostFeature {
  apiVersion: number;
  /** Its id (FEATURE_ID): 'annotations'. */
  id: string;
  /** What people call it: 'Annotations'. */
  label: string;
  /** A sentence on what it does (Settings). */
  description?: string;
  /**
   * On in a workspace whose .kuraa/features.json says nothing of it (0087):
   * what the app is not the same without (its navigation, Preview, Search).
   * A workspace turns it off with `"on": false`.
   */
  onByDefault?: boolean;
  /**
   * Document types for its files (its companions, its codebook), usually
   * with a `merge` of their own. Registered on every host that loads the
   * feature, on or off, so that turning it off does not change how a device
   * merges.
   */
  types?: DocumentType[];
  /**
   * The suffixes of its companion folders (COMPANION_SUFFIX): beside each
   * document, named after it, a folder of each person's own file
   * (`p01.md.annotations/@<id>.jsonld`). The core moves them with their
   * documents (a deletion takes only the deleter's own), keeps them in their
   * document's space, folds them under it in the file list and leaves them out
   * of search.
   */
  companions?: string[];
  /** Files of its own besides companions (a codebook), by the workspace's settings: the only others it may write. */
  files?(settings: FeatureSettings): string[];
  /**
   * Names of files it may write wherever they are in the workspace (0088: a
   * manuscript's `_quarto.yml`), besides those `files` declares; `*` stands for
   * any characters but `/` (0090: `_quarto-*.yml`). Never while one is open in
   * a room: it is then the room's (a write is refused, 409).
   */
  names?: string[];
  /** What it keeps in each document's room, live, written to a companion with the document. */
  room?: FeatureRoom;
  /** A line for an automatic commit that changed one of its files ("2 marks added"); null to say nothing. */
  describe?(change: { path: string; before: string | null; after: string | null }): string | null;
  /** Opened for each workspace where it is on; closed when it goes off, or the host stops. */
  open?(ctx: FeatureContext): FeatureSession;
}

/**
 * State kept in each document's room, shared live by everyone in it: a map of
 * JSON values by key for each person, whose anchors move with everyone's typing.
 * Each person's is seeded from their own file by their own device, changed only
 * from their devices, and written to their file by their device, when it saves
 * the room (the device that leads it with the document, in the same commit).
 */
export interface FeatureRoom {
  /** The suffix of the companion folder it is kept in: one of `companions`. */
  companion: string;
  /** Its files' extension: `.jsonld`. */
  extension: string;
  /** What a person's map starts with, from their own file as it is (null: there is none). */
  seed(input: RoomSeedInput): { [key: string]: Json };
  /**
   * A person's own file's text: the file as it is (`companion`), with the
   * entries they changed here set (`entries`) and those they took away removed
   * (`removed`); every other entry as the file says. Null for none (it is
   * removed). Called at each save of the room, only where they changed something.
   */
  write(input: RoomWriteInput): string | null;
}

export interface RoomSeedInput {
  /** The document's path. */
  path: string;
  type: DocumentType;
  /** The document, as the session starts with it, and its text. */
  doc: Node;
  text: string;
  parsed: ParsedDocument;
  /** Whose map it is: this host's person. */
  person: string;
  /** Their own file's text, if there is one. */
  companion: string | null;
  /** Places in the document's text and in the document, both ways. */
  sourceMap: SourceMap;
  /** An anchor at a document position, in the session being started (assoc: which side it keeps to when text is typed there; -1 the left, else the right). */
  anchorAt(pos: number, assoc?: -1 | 1): Anchor;
  settings: FeatureSettings;
}

export interface RoomWriteInput {
  path: string;
  type: DocumentType;
  /** The document as written, its text and parse. */
  doc: Node;
  text: string;
  parsed: ParsedDocument;
  /** Whose file it is: this host's person. */
  person: string;
  /**
   * The entries of their map they set here (from their own clients and
   * devices, or seeded from their file), as the room has them now. Only these:
   * what anyone else put in their map is never written into their file.
   */
  entries: { [key: string]: Json };
  /** The keys of entries they took away here. */
  removed: string[];
  /** Their own file's text as it is now (null: none): what is not in `entries` or `removed` stays as it says. */
  companion: string | null;
  sourceMap: SourceMap;
  /** Where an anchor is in `doc` now, or null if what it was at is gone. */
  positionOf(anchor: Anchor): number | null;
  settings: FeatureSettings;
}

/** What happened, after it happened: a feature's handlers cannot refuse or hold it up. */
export interface FeatureEvents {
  /** A document's room started a session here. */
  open: { path: string };
  /** A document's text was written from its room. */
  save: { path: string; text: string };
  /** A commit was made here, of these paths. */
  commit: { commit: string; paths: string[] };
  /** Work from elsewhere was brought in (another device, the online copy): these files changed. */
  merge: { from: string | null; to: string; paths: string[] };
  /** A file or folder was renamed or moved here (companions moved with it). */
  rename: { from: string; to: string; folder: boolean };
  /** A file or folder was deleted here (companions with it). */
  delete: { path: string; folder: boolean };
  /** The workspace's settings for the feature changed (here or in a merge). */
  settings: { settings: FeatureSettings };
}

export type FeatureEvent = keyof FeatureEvents;

/** Someone named on a commit: as git names them. */
export interface CommitPerson {
  name: string;
  email: string;
}

/** A commit of the workspace's history (FeatureHistory.log). */
export interface HistoryCommit {
  id: string;
  /** When its author made it, where they made it: ISO 8601 with its offset (2026-01-10T10:00:00+02:00). */
  date: string;
  author: CommitPerson;
  /** Those it names as co-authors (`Co-authored-by:`): an automatic save names whoever changed its documents since the last. */
  coAuthors: CommitPerson[];
  /** It brought two lines of work together. */
  merge: boolean;
}

/** A file a commit changed, against its first parent: where it was (null: added) and where it is (null: deleted); a rename has both. */
export interface FileChange {
  from: string | null;
  to: string | null;
}

/** A file at a commit, for FeatureHistory.read: `before`, in the commit's first parent instead. */
export interface FileAt {
  commit: string;
  path: string;
  before?: boolean;
}

/** The workspace's history, read only (FeatureContext.history, 0125). */
export interface FeatureHistory {
  /** The commits on the branch checked out, newest first: from a moment on (ISO 8601), merges left out where `merges` is false. */
  log(o?: { since?: string; merges?: boolean }): Promise<HistoryCommit[]>;
  /** What each commit changed against its first parent, renames followed, by commit id. */
  changes(commits: string[]): Promise<{ [commit: string]: FileChange[] }>;
  /** Files as they were, all asked at once, in the order asked: their text, or null where there was none or it was not text. */
  read(files: FileAt[]): Promise<(string | null)[]>;
}

/** A document changed in its room here since its last commit (FeatureContext.edited). */
export interface EditedDocument {
  path: string;
  /** Its text at its last commit; null where it was not there. */
  before: string | null;
  /** Its text as its room has it now. */
  after: string;
  /** Who changed it since. */
  people: CommitPerson[];
}

/** What a feature keeps on this device (FeatureContext.store): JSON by name. */
export interface FeatureStore {
  /** What it kept under a name (STORE_NAME), or null. */
  get(name: string): Promise<Json | null>;
  /** Keep a value under a name, or forget it (null). */
  set(name: string, value: Json | null): Promise<void>;
}

/** A name a feature keeps something under in its store. */
export const STORE_NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

/** How FeatureContext.read reads a file. */
export interface ReadOptions {
  /** Not read where larger than this many bytes (null is returned). */
  maxBytes?: number;
}

/** A file converted into Markdown (FeatureContext.convert), or why not. */
export type ConvertedFile =
  | { ok: true; markdown: string; media: { name: string; bytes: Uint8Array }[] }
  | { ok: false; message: string };

/** A new file (FeatureContext.create): a workspace path, and its text or its bytes. */
export interface NewFile {
  path: string;
  text?: string;
  bytes?: Uint8Array;
}

/** What the host gives a feature for one workspace. */
export interface FeatureContext {
  readonly id: string;
  /** Its settings for the workspace, as they are now. */
  settings(): FeatureSettings;
  /**
   * A workspace file's text, if this device holds it and it is text (UTF-8,
   * not through a link); null otherwise. `maxBytes`: null for a file larger
   * than this, which is then not read.
   */
  read(path: string, o?: ReadOptions): Promise<string | null>;
  /**
   * A document's text as its room here has it now (0124), what was typed a
   * moment ago, before it is written to its file; null where it has no room
   * here (read its file).
   */
  live(path: string): Promise<string | null>;
  /**
   * Write one of its own files (this host's person's own file beside a
   * document that exists, or one it declared), whole, or remove it (null):
   * checked against who may change it, committed (credited to `by`), kept in
   * its document's space. Rejects, in words for people, what it may not write.
   */
  write(path: string, text: string | null, o?: { by?: Person | null }): Promise<void>;
  /**
   * Move one of the files it declared to another it declares, as it is, in one
   * commit, so that its history follows it (a file kept somewhere new). Refused
   * where nothing is there to move, something is already where it would go, the
   * two are in different spaces (it would be read by others), or either may not
   * be changed.
   */
  move(from: string, to: string): Promise<void>;
  /** The workspace's files this device holds. */
  list(): Promise<string[]>;
  /**
   * The type of a file, as this host opens it (among the formats it has on),
   * or undefined: what it is, asked of its type rather than guessed from its
   * name (0123): whether it has words (`prose`), header fields (`header`), or
   * is Markdown a book is made of (`markdown`).
   */
  typeOf(path: string): DocumentType | undefined;
  /**
   * A file (by its name, for its kind: report.docx) converted into Markdown by
   * whatever here converts its kind (0116: pandoc for Word, OpenDocument, RTF,
   * EPUB, HTML), given nothing of the workspace: pandoc's Markdown and the
   * media it held, by the names the Markdown gives them; or why not.
   */
  convert(name: string, bytes: Uint8Array): Promise<ConvertedFile>;
  /**
   * New files, all or none, committed together (0116: importing): documents,
   * folders' orders, images and other files, `text` or `bytes`. Each must be
   * new (nothing is overwritten) and somewhere this host's person may write;
   * an image is kept without its details (0108), one whose details could not
   * be found left out, as `skipped` says. Rejects, in words for people, what
   * it may not add.
   */
  create(files: NewFile[], o: { message: string; by?: Person | null }): Promise<{ created: string[]; skipped: { path: string; why: string }[] }>;
  /**
   * The workspace's history as this device holds it, read only (0125): its
   * commits on the branch checked out, what each changed, and files as they
   * were. The spaces' histories are not in it.
   */
  history: FeatureHistory;
  /**
   * The documents open in rooms here, on the branch checked out, that people
   * have changed since their last commit (0125): each as it was at that commit
   * (null: not there) and as its room has it now, and who changed it.
   */
  edited(): Promise<EditedDocument[]>;
  /**
   * What it keeps on this device for this workspace (0125): a cache, say, of
   * what it worked out from the history. Never synced, never committed; gone
   * when the workspace's folder goes. Its own, apart from every other feature's.
   */
  store: FeatureStore;
  /** You: this host's person's identity ID; null until there is one (then nothing of yours can be written). */
  me(): string | null;
  /** A person's own file beside a document (by default yours, by this feature's first suffix and its room's extension, or `.json`). */
  companionOf(doc: string, o?: { person?: string; suffix?: string; extension?: string }): string;
  /** Everyone's own files beside a document that this device holds, with their text. */
  companions(doc: string, suffix?: string): Promise<{ person: string; path: string; text: string }[]>;
  /** The document a companion file of this feature belongs to, or null. */
  documentOf(path: string): string | null;
  /**
   * The document any file is kept beside (0124), or null: any feature's
   * companion (0082) or a document's own files (0109). Such files are shown,
   * counted and searched with their document, not on their own.
   */
  belongsTo(path: string): string | null;
  /** Be told after something happens. Returns how to stop. */
  on<E extends FeatureEvent>(event: E, fn: (payload: FeatureEvents[E]) => void | Promise<void>): () => void;
  /** Tell its client halves: those with `path` open, or every one with any document open. */
  tell(message: Json, path?: string): void;
  log(message: string): void;
}

/** A request to one of its routes: /api/features/<id>/<path>. */
export interface FeatureRequest {
  method: FeatureRoute['method'];
  /** What follows /api/features/<id>/. */
  path: string;
  query: URLSearchParams;
  /** The JSON body, if any. */
  body: Json | undefined;
  /** Who asked, as the client says (absent if it says nothing). */
  person: Person | null;
}

export interface FeatureResponse {
  status?: number;
  body?: Json;
}

export interface FeatureRoute {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  /** What follows /api/features/<id>/: exact. */
  path: string;
  handle(req: FeatureRequest): FeatureResponse | Promise<FeatureResponse>;
}

/**
 * A folder compiled into one document to render (FeatureSession.compileFolder,
 * 0126): its text, pandoc's Markdown; the workspace's folders where what it
 * refers to is found (its documents' images, say); and workspace files to put
 * beside it by a name its text gives them (a Word template, a cover: 0106).
 */
export interface CompiledFolder {
  text: string;
  folders: string[];
  files: { name: string; path: string }[];
}

/** A feature opened for one workspace. */
export interface FeatureSession {
  routes?: FeatureRoute[];
  /**
   * A folder ('' the top level) joined into one document, to render it in a
   * format (`html`, `docx`, `pdf`, `epub`), as `request` asks (what that holds
   * is the feature's to say: 0126). The core renders a folder (a path ending
   * in `/`) by asking the first feature on that has this, and keeps its
   * outputs as for a document. A string says why there is nothing to render.
   */
  compileFolder?(folder: string, request: Json, format: string): Promise<CompiledFolder | string>;
  close?(): void | Promise<void>;
}

export function defineFeature(feature: Omit<HostFeature, 'apiVersion'>): HostFeature {
  return { apiVersion: FEATURE_API_VERSION, ...feature };
}
