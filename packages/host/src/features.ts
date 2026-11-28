// Features (docs/decisions/0082-annotations.md): what people do that touches
// documents, the host and the interface at once, kept out of the core. The host
// imports none: whoever starts it passes their host halves (HostOptions.features),
// and this is all the host does with them:
//
// - loads them, checked against the contract (@kuraa/feature-kit/host);
// - registers their file types, on or off, so merging does not depend on it;
// - keeps which are on for the workspace, and each one's settings, in
//   .kuraa/features.json (committed), with the host's own choice (`on`);
// - keeps companions with their documents: .kuraa/companions.json records
//   their suffixes, so every host moves and deletes them with their documents,
//   keeps them in their document's space, folds them in the file list and
//   leaves them out of search, whether or not it has the feature;
// - seeds each room's state from its companions, and writes it back to them
//   when the room's document is written, by the device that leads the room;
// - tells features what happened, after it happened (they cannot refuse it);
// - routes /api/features/<id>/… to them, and lets them write only their own files.
import { constants } from 'node:fs';
import { open, readdir, rm, rmdir } from 'node:fs/promises';
import { isUtf8 } from 'node:buffer';
import { dirname } from 'node:path';
import { HookBus, sourceMapOf, type DocumentType, type HookEvent, type ParsedDocument } from '@kuraa/kernel';
import {
  COMPANION_SUFFIX, COMPANIONS_FILE, FEATURE_API_VERSION, FEATURE_ID, FEATURES_FILE, OWN_NAME, companionFolder, documentOf, ownFile, ownerOf,
  type FeatureContext, type FeatureEvent, type FeatureEvents, type FeatureRequest, type FeatureResponse, type FeatureSession,
  type ConvertedFile, type FeatureSettings, type FeatureStatus, type HostFeature, type Json, type NewFile, type Person,
} from '@kuraa/feature-kit/host';
import type { FeatureSeed, FeatureView } from '@kuraa/session/server';
import type { Node } from 'prosemirror-model';
import { HttpError, NotAllowed } from './errors.js';

/** What the host gives this module: as little of itself as it needs. */
export interface FeaturePort {
  log(message: string): void;
  serial<T>(fn: () => Promise<T>): Promise<T>;
  requireWritable(): Promise<void>;
  resolvePath(path: string): string;
  writeAtomic(abs: string, text: string): Promise<void>;
  commitPaths(paths: string[], message: string, coAuthors?: Person[]): Promise<string | null>;
  commitIntoSpace(id: string, paths: string[], message: string): Promise<string | null>;
  spaceOf(path: string): string | null;
  /** Whether this host's person may change a path (0066); true where no policy says. */
  canWrite(path: string): Promise<boolean>;
  /** The workspace's files this device holds. */
  list(): Promise<string[]>;
  /** Tell the clients of rooms: those of `path`, or every one. */
  tell(feature: string, message: Json, path: string | null): void;
  /** Whether a document's room is open here (its companions are then the room's to write). */
  roomOpen(path: string): boolean;
  /** This host's person: their identity ID, whose own files it writes; null until there is one. */
  person(): Promise<string | null>;
  /** A file converted into Markdown by a renderer that converts its kind (0116). */
  convert(name: string, bytes: Uint8Array): Promise<ConvertedFile>;
  /** New files, all or none, committed together (0116). */
  create(files: NewFile[], o: { message: string; by?: Person | null }): Promise<{ created: string[]; skipped: { path: string; why: string }[] }>;
}

/** A file's name against a name a feature writes, where `*` is any characters but `/` (0090). */
export function nameMatches(pattern: string, name: string): boolean {
  if (!pattern.includes('*')) return pattern === name;
  const re = new RegExp(`^${pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')}$`);
  return re.test(name);
}

/** Check features handed to the host against the contract: refused, saying why, as run components are. */
export function checkFeatures(list: unknown[]): HostFeature[] {
  const seen = new Set<string>();
  const suffixes = new Map<string, string>();
  return list.map((entry) => {
    const f = entry as Partial<HostFeature> | null;
    const from = typeof f?.id === 'string' ? `the feature "${f.id}"` : 'a feature';
    if (!f || typeof f !== 'object' || typeof f.apiVersion !== 'number') throw new Error(`${from} is not a Kuraa feature: it should be made with defineFeature().`);
    if (f.apiVersion !== FEATURE_API_VERSION) throw new Error(`${from} was written for version ${f.apiVersion} of the feature API; this host speaks version ${FEATURE_API_VERSION}.`);
    if (typeof f.id !== 'string' || !FEATURE_ID.test(f.id)) throw new Error(`${from} needs an id of lower-case letters, digits and dashes, starting with a letter.`);
    if (f.names !== undefined && (!Array.isArray(f.names) || f.names.some((n) => typeof n !== 'string' || !n || n.includes('/') || n.startsWith('@') || n === '.' || n === '..'))) throw new Error(`${from}: the names of files it writes are plain file names (no folders, not @ files).`);
    if (seen.has(f.id)) throw new Error(`Two features are called "${f.id}".`);
    seen.add(f.id);
    if (typeof f.label !== 'string' || !f.label) throw new Error(`${from} needs a label.`);
    for (const s of f.companions ?? []) {
      if (typeof s !== 'string' || !COMPANION_SUFFIX.test(s)) throw new Error(`${from}: "${s}" is not a companion suffix (a dot, then letters, digits, dots and dashes).`);
      const other = suffixes.get(s);
      if (other) throw new Error(`${from}: the companion suffix "${s}" is the feature "${other}"'s already.`);
      suffixes.set(s, f.id);
    }
    if (f.room) {
      if (!(f.companions ?? []).includes(f.room.companion)) throw new Error(`${from}: its room is kept in "${f.room.companion}", which is not one of its companions.`);
      if (typeof f.room.extension !== 'string' || !/^\.[A-Za-z0-9][A-Za-z0-9._-]{0,20}$/.test(f.room.extension)) throw new Error(`${from}: its room's files need an extension (".json").`);
      if (typeof f.room.seed !== 'function' || typeof f.room.write !== 'function') throw new Error(`${from}: its room needs seed() and write().`);
    }
    return f as HostFeature;
  });
}

/**
 * What this host's person did in a room (0082): by feature, the keys of their
 * map whose values they last set (or took away) here, from their own clients,
 * their own devices' edits, or seeded from their file. Their file is written
 * with these alone: what anyone else put in their map (a device that may change
 * the document passing a sync on, or a session's state when joining) is shown,
 * never signed as theirs.
 */
export type Mine = Map<string, Set<string>>;

/** One entry of .kuraa/features.json. */
type Entry = { on?: boolean } & FeatureSettings;

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** JSON with its keys in order, two spaces: every device writes the same bytes. */
function stable(v: unknown): string {
  const sort = (x: unknown): unknown => (Array.isArray(x) ? x.map(sort) : isObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, sort(x[k])])) : x);
  return `${JSON.stringify(sort(v), null, 2)}\n`;
}

/** A file's text, if it is a plain file (never through a link) holding UTF-8; else null. */
async function readPlain(abs: string): Promise<string | null> {
  let fh;
  try {
    fh = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch {
    return null;
  }
  try {
    if (!(await fh.stat()).isFile()) return null;
    const bytes = await fh.readFile();
    return isUtf8(bytes) ? bytes.toString('utf8') : null;
  } finally {
    await fh.close();
  }
}

export class HostFeatures {
  /** Every feature loaded, by id, on or off. */
  readonly loaded = new Map<string, HostFeature>();
  /** What .kuraa/features.json says, by id. */
  private entries: Record<string, Entry> = {};
  /** The companion suffixes .kuraa/companions.json records. */
  private recorded: string[] = [];
  /** Features open for the workspace, by id: each one's session, and what it listens to (told after things happen). */
  private readonly open = new Map<string, { session: FeatureSession; bus: HookBus }>();
  private closed = false;
  /** This host's person (refresh): whose own files are written here. */
  private me: string | null = null;

  constructor(
    private readonly port: FeaturePort,
    features: HostFeature[] = [],
    /** Which of them the host has on (its operator's choice), by id; all if absent. */
    private readonly hostOn?: string[],
  ) {
    for (const f of checkFeatures(features)) this.loaded.set(f.id, f);
    for (const id of hostOn ?? []) if (!this.loaded.has(id)) port.log(`no feature "${id}" is loaded: passed over`);
  }

  /** Every loaded feature's file types (registered on or off: merging must not depend on it). */
  types(): DocumentType[] {
    return [...this.loaded.values()].flatMap((f) => f.types ?? []);
  }

  /** On for the host: loaded, and its operator has it on. */
  onForHost(id: string): boolean {
    return this.loaded.has(id) && (!this.hostOn || this.hostOn.includes(id));
  }

  /** On for the workspace, here: the host has it on, and the workspace too. */
  isOn(id: string): boolean {
    return this.onForHost(id) && this.onForWorkspace(id);
  }

  /** The workspace has it on: its entry says so, or says nothing of a feature on by default (0087). */
  private onForWorkspace(id: string): boolean {
    const said = this.entries[id]?.on;
    return typeof said === 'boolean' ? said : this.loaded.get(id)?.onByDefault === true;
  }

  /** Its settings for the workspace: its entry in .kuraa/features.json, without `on`. */
  settings(id: string): FeatureSettings {
    const { on: _on, ...rest } = this.entries[id] ?? {};
    return rest as FeatureSettings;
  }

  // ---------------------------------------------------------------------------
  // The workspace's choices

  /**
   * Read .kuraa/features.json and .kuraa/companions.json, and open or close
   * features to match. Again after a merge or a change. Called inside the
   * host's queue too (after a merge), so nothing a feature does is waited for
   * here: its handlers and its closing may themselves write, through the queue.
   */
  async refresh(): Promise<void> {
    if (this.closed) return;
    const before = this.entries;
    this.entries = await this.readEntries();
    this.recorded = await this.readRecorded();
    this.me = await this.port.person().catch(() => null);
    for (const f of this.loaded.values()) {
      const on = this.isOn(f.id);
      if (on && !this.open.has(f.id)) this.openFeature(f);
      else if (!on && this.open.has(f.id)) void this.closeFeature(f.id);
      const settingsOf = (e: Entry | undefined) => stable(this.settingsOf(e ?? {}));
      if (on && settingsOf(before[f.id]) !== settingsOf(this.entries[f.id])) void this.emitTo(f.id, 'settings', { settings: this.settings(f.id) });
    }
  }

  private async readEntries(): Promise<Record<string, Entry>> {
    const text = await readPlain(this.port.resolvePath(FEATURES_FILE));
    if (text === null) return {};
    try {
      const v = JSON.parse(text) as unknown;
      if (!isObject(v)) return {};
      return Object.fromEntries(Object.entries(v).filter(([id, e]) => FEATURE_ID.test(id) && isObject(e))) as Record<string, Entry>;
    } catch {
      this.port.log(`${FEATURES_FILE} is not valid JSON: every feature is off until it is`);
      return {};
    }
  }

  private async readRecorded(): Promise<string[]> {
    const text = await readPlain(this.port.resolvePath(COMPANIONS_FILE));
    if (text === null) return [];
    try {
      const v = JSON.parse(text) as { suffixes?: unknown };
      return Array.isArray(v.suffixes) ? v.suffixes.filter((s): s is string => typeof s === 'string' && COMPANION_SUFFIX.test(s)) : [];
    } catch {
      return [];
    }
  }

  /**
   * Turn a feature on or off for the workspace, or change its settings: written
   * to .kuraa/features.json and committed (with its companions' suffixes
   * recorded, once on), for everyone in the workspace. Who may change that file may.
   */
  async setWorkspace(id: string, change: { on?: boolean; settings?: FeatureSettings }, by: Person | null): Promise<FeatureStatus> {
    const f = this.loaded.get(id);
    if (!f) throw new HttpError(404, `No feature "${id}" here`);
    if (!(await this.port.canWrite(FEATURES_FILE))) throw new NotAllowed(`Only someone who may change ${FEATURES_FILE} turns features on and off for this workspace`);
    await this.port.serial(async () => {
      await this.port.requireWritable();
      const entries = await this.readEntries();
      const was = entries[id] ?? {};
      const settings = change.settings !== undefined ? change.settings : this.settingsOf(was);
      if (!isObject(settings)) throw new HttpError(400, 'Settings are an object');
      if ('on' in settings) throw new HttpError(400, '“on” is not a setting');
      const byDefault = f.onByDefault === true;
      const on = change.on ?? (typeof was.on === 'boolean' ? was.on : byDefault);
      // Said only where it differs from the feature's default (0087): a feature on by default is turned off with `"on": false`.
      const next: Entry = { ...settings, ...(on !== byDefault ? { on } : {}) };
      if (Object.keys(next).length) entries[id] = next;
      else delete entries[id];
      const paths = [FEATURES_FILE];
      await this.port.writeAtomic(this.port.resolvePath(FEATURES_FILE), stable(entries));
      const suffixes = [...new Set([...(await this.readRecorded()), ...(on ? f.companions ?? [] : [])])].sort();
      if (stable({ suffixes }) !== stable({ suffixes: this.recorded })) {
        await this.port.writeAtomic(this.port.resolvePath(COMPANIONS_FILE), stable({ suffixes }));
        paths.push(COMPANIONS_FILE);
      }
      const what = change.on === undefined ? `Change the settings of ${f.label}` : `${change.on ? 'Turn on' : 'Turn off'} ${f.label}`;
      await this.port.commitPaths(paths, what, by && by.email ? [by] : []);
    });
    await this.refresh();
    return (await this.status()).find((s) => s.id === id)!;
  }

  private settingsOf(e: Entry): FeatureSettings {
    const { on: _on, ...rest } = e;
    return rest as FeatureSettings;
  }

  /** How each loaded feature stands for the workspace. */
  async status(): Promise<FeatureStatus[]> {
    await this.whoAmI();
    const mayChange = await this.port.canWrite(FEATURES_FILE).catch(() => false);
    return [...this.loaded.values()].map((f) => ({
      id: f.id,
      label: f.label,
      description: f.description ?? '',
      on: this.isOn(f.id),
      host: this.onForHost(f.id),
      workspace: this.onForWorkspace(f.id),
      settings: this.settings(f.id),
      mayChange,
      companions: f.companions ?? [],
      me: this.me,
    }));
  }

  // ---------------------------------------------------------------------------
  // Companions

  /** Every companion suffix: those the workspace records, and the loaded features'. */
  suffixes(): string[] {
    return [...new Set([...this.recorded, ...[...this.loaded.values()].flatMap((f) => f.companions ?? [])])];
  }

  /** The document a companion file belongs to, if the path is one (a person's own file in a companion folder); else null. */
  documentOf(path: string): string | null {
    return documentOf(path, this.suffixes());
  }

  /** A document's companion folders, by every suffix (whether or not each is there). */
  foldersOf(doc: string): string[] {
    if (this.documentOf(doc)) return [];
    return this.suffixes().map((s) => companionFolder(doc, s));
  }

  /** The files in a document's companion folders on the disk: everyone's own files. */
  async filesOf(doc: string): Promise<string[]> {
    const out: string[] = [];
    for (const folder of this.foldersOf(doc)) {
      const names = await readdir(this.port.resolvePath(folder)).catch(() => [] as string[]);
      for (const n of names.sort()) if (OWN_NAME.test(n)) out.push(`${folder}/${n}`);
    }
    return out;
  }

  /** This host's person's own files beside a document (theirs to delete with it). */
  async ownFilesOf(doc: string): Promise<string[]> {
    await this.whoAmI();
    return this.me ? (await this.filesOf(doc)).filter((p) => ownerOf(p) === this.me) : [];
  }

  /** Remove a file, and its folder if that leaves it empty. */
  async removeOwn(path: string): Promise<void> {
    const abs = this.port.resolvePath(path);
    await rm(abs, { force: true });
    await rmdir(dirname(abs)).catch(() => undefined);
  }

  /** This host's person, as last read. */
  person(): string | null {
    return this.me;
  }

  /** Read this host's person again: their identity may have been made (or recovered) since. */
  private async whoAmI(): Promise<string | null> {
    this.me = await this.port.person().catch(() => this.me);
    return this.me;
  }

  // ---------------------------------------------------------------------------
  // Rooms

  /** Whether features matter to this workspace at all: any loaded, or companions recorded. */
  inUse(): boolean {
    return this.loaded.size > 0 || this.recorded.length > 0;
  }

  /** Whether any feature on keeps state in rooms. */
  keepsRoomState(): boolean {
    return this.roomFeatures().length > 0;
  }

  /** Features on, with state kept in rooms. */
  private roomFeatures(): HostFeature[] {
    return [...this.loaded.values()].filter((f) => f.room && this.isOn(f.id));
  }

  /**
   * What this host's person's maps start with in a room, for each feature on
   * (or those named), from their own files (or the text kept for them while
   * saving was held up). The files are read first; the seed is made from the
   * document as it is when it is called, with nothing between, so anchors land
   * where they should. Undefined if no feature on keeps state in rooms, or
   * this host's person has no identity. Reads only.
   */
  async seedFor(path: string, kept?: Record<string, string | null>, only?: string[]): Promise<((type: DocumentType, doc: Node, parsed: ParsedDocument) => { person: string; seed: FeatureSeed }) | undefined> {
    const person = await this.whoAmI();
    const features = this.roomFeatures().filter((f) => !only || only.includes(f.id));
    if (!person || !features.length || this.documentOf(path)) return undefined;
    const companions = new Map<string, string | null>();
    for (const f of features) {
      const c = ownFile(path, f.room!.companion, person, f.room!.extension);
      companions.set(f.id, kept && c in kept ? kept[c]! : await readPlain(this.port.resolvePath(c)));
    }
    return (type, doc, parsed) => {
      const sourceMap = sourceMapOf(type, doc, parsed);
      return {
        person,
        seed: ({ anchorAt }) => {
          const out: { [id: string]: { [key: string]: Json } } = {};
          for (const f of features) {
            try {
              out[f.id] = f.room!.seed({ path, type, doc, text: parsed.text, parsed, person, companion: companions.get(f.id) ?? null, sourceMap, anchorAt, settings: this.settings(f.id) });
            } catch (e) {
              this.port.log(`${f.id}: could not read ${ownFile(path, f.room!.companion, person, f.room!.extension)} into the room (${(e as Error).message}); it is left as it is`);
            }
          }
          return out;
        },
      };
    };
  }

  /** The features on for which this host's person's map in a room is not seeded yet: to seed now (turned on, or this device came, while it was open). */
  unseeded(view: FeatureView): string[] {
    const me = this.me;
    return me ? this.roomFeatures().filter((f) => !view.seeded(f.id, me)).map((f) => f.id) : [];
  }

  /**
   * This host's person's own files' text from a room's state, as they are to be
   * written (null: none), for the features their map was seeded for. Nothing is
   * written here.
   */
  companionTexts(path: string, type: DocumentType, doc: Node, parsed: ParsedDocument, view: FeatureView, current: ReadonlyMap<string, string | null>, mine: Mine): Map<string, { feature: HostFeature; text: string | null }> {
    const out = new Map<string, { feature: HostFeature; text: string | null }>();
    const person = this.me;
    if (!person || this.documentOf(path)) return out;
    const sourceMap = sourceMapOf(type, doc, parsed);
    for (const f of this.roomFeatures()) {
      // Only what this person did here goes into their file: nothing of theirs changed here, nothing written.
      const keys = mine.get(f.id);
      if (!keys?.size) continue;
      const c = ownFile(path, f.room!.companion, person, f.room!.extension);
      const all = view.entries(f.id, person);
      const entries: { [key: string]: Json } = {};
      const removed: string[] = [];
      for (const k of keys) {
        if (k in all) entries[k] = all[k]!;
        else removed.push(k);
      }
      try {
        const text = f.room!.write({ path, type, doc, text: parsed.text, parsed, person, entries, removed, companion: current.get(c) ?? null, sourceMap, positionOf: (a) => view.positionOf(a), settings: this.settings(f.id) });
        out.set(c, { feature: f, text });
      } catch (e) {
        this.port.log(`${f.id}: could not write ${c} from the room (${(e as Error).message}); it is left as it was`);
      }
    }
    return out;
  }

  /**
   * Write this host's person's own files from a room (call inside serial(), with
   * the document as it was read with the room's state). A new file beside a
   * document in a space goes into that space at once, never onto the
   * workspace's own branch. Returns the files written or removed.
   */
  async writeRoom(path: string, type: DocumentType, doc: Node, parsed: ParsedDocument, view: FeatureView, mine: Mine): Promise<string[]> {
    const written: string[] = [];
    const person = this.me;
    if (!person) return written;
    // The files as they are, read first; then written from the room, with nothing between.
    const current = new Map<string, string | null>();
    for (const f of this.roomFeatures()) {
      if (!mine.get(f.id)?.size || this.documentOf(path)) continue;
      const c = ownFile(path, f.room!.companion, person, f.room!.extension);
      current.set(c, await readPlain(this.port.resolvePath(c)));
    }
    for (const [c, { text }] of this.companionTexts(path, type, doc, parsed, view, current, mine)) {
      const before = current.get(c) ?? null;
      if (text === before) continue;
      if (text === null) await this.removeOwn(c);
      else {
        await this.port.writeAtomic(this.port.resolvePath(c), text);
        const space = this.port.spaceOf(path);
        if (before === null && space && this.port.spaceOf(c) !== space) await this.port.commitIntoSpace(space, [c], `Add ${c} with its document`);
      }
      written.push(c);
    }
    return written;
  }

  /** What the features whose files these are are called: for a commit that says nothing else of them. */
  labelsOf(paths: string[]): string[] {
    return [...new Set(paths.map((p) => [...this.loaded.values()].find((f) => documentOf(p, f.companions ?? []) !== null)?.label ?? p))];
  }

  /** Lines for an automatic commit that changed companions: what their features say of each. */
  describe(changes: { path: string; before: string | null; after: string | null }[]): string[] {
    const lines: string[] = [];
    for (const ch of changes) {
      // Its companions, or the files it writes by their name (0093: a manuscript's).
      const name = ch.path.slice(ch.path.lastIndexOf('/') + 1);
      const f = [...this.loaded.values()].find((x) => documentOf(ch.path, x.companions ?? []) !== null || (x.names ?? []).some((n) => nameMatches(n, name)));
      if (!f?.describe) continue;
      try {
        const line = f.describe(ch);
        if (line) lines.push(line);
      } catch { /* says nothing */ }
    }
    return lines;
  }

  // ---------------------------------------------------------------------------
  // Opening features for the workspace

  private openFeature(f: HostFeature): void {
    const bus = new HookBus();
    const ctx = this.contextFor(f, bus);
    let session: FeatureSession = {};
    try {
      session = f.open?.(ctx) ?? {};
    } catch (e) {
      this.port.log(`${f.id}: could not open (${(e as Error).message})`);
    }
    this.open.set(f.id, { session, bus });
  }

  private async closeFeature(id: string): Promise<void> {
    const o = this.open.get(id);
    if (!o) return;
    this.open.delete(id);
    try {
      await o.session.close?.();
    } catch (e) {
      this.port.log(`${id}: did not close cleanly (${(e as Error).message})`);
    }
  }

  private contextFor(f: HostFeature, bus: HookBus): FeatureContext {
    // Its own: this host's person's own files beside documents, and the files it declares.
    const own = (path: string) => {
      const doc = documentOf(path, f.companions ?? []);
      if (doc !== null) return this.me && ownerOf(path) === this.me ? { doc } : null;
      if ((f.files?.(this.settings(f.id)) ?? []).includes(path)) return { doc: null };
      // A file by its name, wherever it is (0088).
      const name = path.slice(path.lastIndexOf('/') + 1);
      return (f.names ?? []).some((n) => nameMatches(n, name)) ? { doc: null } : null;
    };
    return {
      id: f.id,
      settings: () => this.settings(f.id),
      read: (path) => readPlain(this.port.resolvePath(path)).catch(() => null),
      write: async (path, text, o) => {
        const mine = own(path);
        if (!mine) throw new HttpError(403, `${f.label} writes only your own files and those it keeps, not ${path}`);
        if (mine.doc !== null && text !== null && (await readPlain(this.port.resolvePath(mine.doc))) === null) throw new HttpError(404, `No document ${mine.doc} for ${path} to be beside`);
        if (mine.doc !== null && this.port.roomOpen(mine.doc)) throw new HttpError(409, `${mine.doc} is open: what is kept beside it is changed in its room`);
        if (mine.doc === null && this.port.roomOpen(path)) throw new HttpError(409, `${path} is open: close it to change it from here`);
        if (!(await this.port.canWrite(path))) throw new NotAllowed(`You may not change ${path}`);
        await this.port.serial(async () => {
          await this.port.requireWritable();
          const abs = this.port.resolvePath(path);
          const before = await readPlain(abs);
          if (before === text) return;
          const by = o?.by && o.by.email ? [o.by] : [];
          const message = this.describe([{ path, before, after: text }])[0] ?? `${text === null ? 'Remove' : before === null ? 'Add' : 'Change'} ${path}`;
          if (text === null) await this.removeOwn(path);
          else await this.port.writeAtomic(abs, text);
          const space = mine.doc !== null ? this.port.spaceOf(mine.doc) : null;
          if (text !== null && before === null && space && this.port.spaceOf(path) !== space) await this.port.commitIntoSpace(space, [path], message);
          else await this.port.commitPaths([path], message, by);
        });
      },
      move: async (from, to) => {
        // Its declared files only: companions move with their documents, never on their own.
        for (const p of [from, to]) {
          if (own(p)?.doc !== null) throw new HttpError(403, `${f.label} moves only the files it keeps, not ${p}`);
        }
        if (this.port.spaceOf(from) !== this.port.spaceOf(to)) throw new HttpError(409, `${from} and ${to} are read by different people: not moved`);
        for (const p of [from, to]) if (!(await this.port.canWrite(p))) throw new NotAllowed(`You may not change ${p}`);
        await this.port.serial(async () => {
          await this.port.requireWritable();
          const text = await readPlain(this.port.resolvePath(from));
          if (text === null) throw new HttpError(404, `No ${from} to move`);
          if ((await readPlain(this.port.resolvePath(to))) !== null) throw new HttpError(409, `${to} is there already: ${from} not moved`);
          await this.port.writeAtomic(this.port.resolvePath(to), text);
          await this.removeOwn(from);
          await this.port.commitPaths([from, to], `Move ${from} to ${to}`);
        });
      },
      list: () => this.port.list(),
      convert: (name, bytes) => this.port.convert(name, bytes),
      // New files only, never one it would overwrite; checked, cleaned and committed by the host (0116).
      create: (files, o) => this.port.create(files, { message: o.message, by: o.by ?? null }),
      me: () => this.me,
      companionOf: (doc, o) => ownFile(doc, o?.suffix ?? f.room?.companion ?? f.companions?.[0] ?? `.${f.id}`, o?.person ?? this.me ?? '', o?.extension ?? f.room?.extension ?? '.json'),
      companions: async (doc, suffix) => {
        const wanted = suffix ?? f.room?.companion ?? f.companions?.[0];
        const out: { person: string; path: string; text: string }[] = [];
        for (const p of await this.filesOf(doc)) {
          if (wanted && !p.startsWith(`${companionFolder(doc, wanted)}/`)) continue;
          if (!(f.companions ?? []).some((s) => p.startsWith(`${companionFolder(doc, s)}/`))) continue;
          const text = await readPlain(this.port.resolvePath(p));
          if (text !== null) out.push({ person: ownerOf(p)!, path: p, text });
        }
        return out;
      },
      documentOf: (path) => documentOf(path, f.companions ?? []),
      on: (event, fn) => bus.on(event as HookEvent, {
        after: async (payload: unknown) => {
          try {
            await fn(payload as never);
          } catch (e) {
            this.port.log(`${f.id}: after ${event}: ${(e as Error).message}`);
          }
        },
      }),
      tell: (message, path) => this.port.tell(f.id, message, path ?? null),
      log: (m) => this.port.log(`${f.id}: ${m}`),
    };
  }

  // ---------------------------------------------------------------------------
  // Events and routes

  /** Tell every feature on that something happened. Never throws: a feature cannot refuse or hold up what happened. */
  async emit<E extends FeatureEvent>(event: E, payload: FeatureEvents[E]): Promise<void> {
    for (const id of [...this.open.keys()]) await this.emitTo(id, event, payload);
  }

  /** Tell one feature. */
  private async emitTo<E extends FeatureEvent>(id: string, event: E, payload: FeatureEvents[E]): Promise<void> {
    await this.open.get(id)?.bus.after(event as HookEvent, payload).catch((e: unknown) => this.port.log(`${id}: after ${event}: ${(e as Error).message}`));
  }

  /** A request to a feature's routes: /api/features/<id>/<rest>. */
  async route(id: string, method: FeatureRequest['method'], rest: string, query: URLSearchParams, body: Json | undefined, person: Person | null): Promise<FeatureResponse> {
    if (!this.loaded.has(id)) throw new HttpError(404, `No feature "${id}" here`);
    if (!this.isOn(id)) throw new HttpError(409, `${this.loaded.get(id)!.label} is off for this workspace`);
    const route = this.open.get(id)?.session.routes?.find((r) => r.method === method && r.path === rest);
    if (!route) throw new HttpError(404, `${this.loaded.get(id)!.label} has no ${method} ${rest}`);
    return route.handle({ method, path: rest, query, body, person });
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const id of [...this.open.keys()]) await this.closeFeature(id);
  }
}
