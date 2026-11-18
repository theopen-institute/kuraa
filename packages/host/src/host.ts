// The host: relay, bridge, committer and git peer for one workspace.
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, watch, type FSWatcher } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { TypeRegistry, hashText, type DocumentType, type ParsedDocument } from '@kuraa/kernel';
import { standardTypes } from '@kuraa/formats';
import { Relay, decodeDoc, encodeSeed, patchState, type PresenceUser, type RoomMessage, type RoomSeed } from '@kuraa/session/server';
import { mergeLines } from '@kuraa/kernel';
import { Git } from './git.js';
import { initWorkspace } from './workspace.js';
import { Runner, type RunOptions } from './runner.js';
import { loadRunComponents } from './components.js';
import { createRequestHandler } from './http.js';
import { conflictsIn, mergeCommits, type MergeOutcome } from './merging.js';
import { AUTOSAVE_TRAILER, describeEdit } from './messages.js';
import type { Peers, PeerOptions } from './peers/peers.js';

export interface HostTimings {
  /** Serialize this long after the last update. */
  flushMs: number;
  /** Commit after this long without updates. */
  idleCommitMs: number;
  /** Commit at least this often during continuous editing. */
  maxCommitMs: number;
  /** Drop an empty room after this long. */
  dropMs: number;
}

export interface HostOptions {
  dir: string;
  /** What the workspace is called to people (default: its folder's name). */
  label?: string;
  token: string;
  host?: string;
  port?: number;
  /** Directory of a built web client to serve at `/`. */
  staticDir?: string;
  /** Remote to fetch from and push to. Defaults to `origin` when it exists. */
  upstream?: string;
  identity?: { name: string; email: string };
  /** Document types this host has. Clients must load the same ones. Default: `standardTypes` from @kuraa/formats. */
  types?: DocumentType[];
  /**
   * Which of those are on, by id (--format). Default: all. A file whose type is
   * off opens as the next type that claims it (markdown files as Text files).
   */
  formats?: string[];
  /**
   * Running code chunks: the run components (engines and environments), which
   * engines are on, and where code runs (see runner.ts). Off by default.
   */
  run?: RunOptions;
  /** If the folder is not a git repository, make it one (committing what is in it) instead of failing. */
  init?: boolean;
  /**
   * Be one of the workspace's devices (--peer): sync git and live rooms with
   * the devices paired with this repository (docs/decisions/0028-peers.md).
   * The first device to do so makes the repository a shared workspace.
   */
  peers?: PeerOptions | boolean;
  /**
   * Let people using the app make invitations and subscription links for this
   * workspace (an operator's choice: --allow-invites; a hub allows it for its
   * workspaces). Making one starts syncing with devices if it is not on, with
   * these options.
   */
  invites?: { peers?: PeerOptions; onPeersOn?: () => void | Promise<void> };
  timings?: Partial<HostTimings>;
  log?: (msg: string) => void;
}

export const DEFAULT_TIMINGS: HostTimings = { flushMs: 2000, idleCommitMs: 30_000, maxCommitMs: 300_000, dropMs: 60_000 };

interface RoomRecord {
  key: string;
  path: string;
  branch: string;
  type: DocumentType;
  room: string;
  /**
   * The git blob the room started from (its seed): rooms anywhere that started
   * from the same blob, with the same type version, start from the same state.
   */
  generation: string;
  baseCommit: string | null;
  /** The file text as last written or seen, parsed. */
  previous: ParsedDocument;
  lastHash: string;
  /** Latest encoded room state; seeds the room when it is reopened. */
  state: Uint8Array | null;
  /** The text of the blob the room starts from, until it has a state. */
  seedText: string | null;
  /** Client edits not yet serialized to the file. */
  dirty: boolean;
  /** Flushed but not committed. */
  uncommitted: boolean;
  contributors: Map<string, PresenceUser>;
  editingSince: number | null;
  lastFlushAt: string | null;
  lastCommitAt: string | null;
  lastCommit: string | null;
  needsOutsideCheck: boolean;
  timers: { flush?: NodeJS.Timeout; commit?: NodeJS.Timeout; max?: NodeJS.Timeout; drop?: NodeJS.Timeout };
}

interface CacheEntry {
  key: string;
  path: string;
  branch: string;
  typeId: string;
  typeVersion: number;
  generation: string;
  baseCommit: string | null;
  lastHash: string;
  text: string;
  state: string;
  lastCommit: string | null;
  lastCommitAt: string | null;
}

export class Host {
  /** The document types that are on. */
  readonly registry = new TypeRegistry();
  /** Every document type this host has, on or off. */
  private readonly allTypes: DocumentType[];
  readonly git: Git;
  readonly dir: string;
  readonly token: string;
  readonly timings: HostTimings;
  readonly workspace: string;
  private readonly records = new Map<string, RoomRecord>();
  private readonly byRoom = new Map<string, RoomRecord>();
  private relay!: Relay;
  runner!: Runner;
  private watcher: FSWatcher | null = null;
  private cacheDir = '';
  private queue: Promise<unknown> = Promise.resolve();
  private watchTimers = new Map<string, NodeJS.Timeout>();
  /** Titles read from files, by path, with the file's size and time when read. */
  private titleCache = new Map<string, { stamp: string; title: string | null }>();
  /** Conflicts counted in files, likewise. */
  private conflictCache = new Map<string, { stamp: string; count: number }>();
  /** Told when a branch moves (a commit, a merge): the peer layer tells other devices. */
  private readonly refsListeners = new Set<() => void>();
  /** The workspace's other devices, when this host is one of them (see peers/). */
  peers: Peers | null = null;
  private closed = false;
  address: AddressInfo | null = null;

  constructor(readonly options: HostOptions) {
    this.dir = resolve(options.dir);
    this.token = options.token;
    this.workspace = basename(this.dir);
    this.timings = { ...DEFAULT_TIMINGS, ...options.timings };
    const identity = options.identity;
    this.git = new Git(this.dir, identity ? {
      GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email,
      GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email,
    } : {});
    this.allTypes = options.types ?? standardTypes;
    const known = this.allTypes.map((t) => t.id);
    for (const id of options.formats ?? []) if (!known.includes(id)) throw new Error(`Unknown format "${id}". Known: ${known.join(', ')}.`);
    for (const t of this.allTypes) if (!options.formats || options.formats.includes(t.id)) this.registry.register(t);
  }

  log(msg: string): void {
    this.options.log?.(msg);
  }

  /** Every component, and whether it is on. Set by the host's options (flags); people using the app only see them. */
  async components() {
    const run = await this.runner.catalog();
    return {
      engines: run.engines,
      environments: run.environments,
      formats: this.allTypes.map((t) => ({ id: t.id, label: t.label, description: t.description ?? '', extensions: t.extensions ?? [], on: this.registry.get(t.id) === t })),
    };
  }

  /** Run state-changing work one step at a time. */
  serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async start(): Promise<AddressInfo> {
    if (!(await this.git.isRepo())) {
      if (!this.options.init) throw new Error(`Not a git repository: ${this.dir}`);
      await initWorkspace(this.dir);
      this.log(`initialised a git repository in ${this.dir}`);
    }
    this.cacheDir = join(await this.git.gitDir(), 'kuraa', 'rooms');
    const run = this.options.run;
    this.runner = new Runner({
      root: this.dir,
      stateDir: join(await this.git.gitDir(), 'kuraa'),
      components: await loadRunComponents(run?.components),
      options: run,
      broadcast: (path, message) => this.broadcastPath(path, message),
      broadcastAll: (message) => {
        for (const rec of this.records.values()) this.broadcast(rec, message);
      },
      commit: async (paths, message, by) => {
        await this.serial(() => this.commitPaths(paths, message, by && by.email ? [by] : []));
      },
      log: (m) => this.log(m),
    });
    if (this.runner.enabled) {
      const env = (await this.runner.describe()).environment!;
      this.log(`running code: ${this.runner.turnedOn.join(', ')}, ${env.label}${env.sandboxed ? '' : ' (NOT SANDBOXED)'}`);
    }
    await mkdir(this.cacheDir, { recursive: true });
    await this.ensureIdentity();
    // Pushes from other clones update the working tree, so open rooms see them.
    await this.git.run(['config', 'receive.denyCurrentBranch', 'updateInstead']);

    const handler = createRequestHandler(this);
    this.relay = new Relay({
      authenticate: (token, params) => {
        if (token !== this.token) throw new Error('Invalid token');
        return {
          name: params.get('name') || 'Anonymous',
          email: params.get('email') || '',
          color: params.get('color') || '#888888',
        };
      },
      load: (room) => this.loadRoom(room),
      loaded: (room) => this.peers?.rooms.opened(room),
      changed: (room, user) => this.onClientChange(room, user),
      store: (room, state) => {
        const rec = this.byRoom.get(room);
        if (rec) {
          rec.state = state;
          void this.saveCache(rec);
        }
      },
      empty: (room) => this.onRoomEmpty(room),
      request: handler,
    }, { host: this.options.host ?? '127.0.0.1', port: this.options.port ?? 0 });
    this.address = await this.relay.listen();
    this.startWatcher();
    if (this.options.peers) await this.startPeers(this.options.peers === true ? {} : this.options.peers);
    this.log(`host serving ${this.dir} on http://${this.address.address}:${this.address.port}`);
    return this.address;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.watcher?.close();
    for (const t of this.watchTimers.values()) clearTimeout(t);
    await this.serial(async () => {
      for (const rec of this.records.values()) {
        await this.flushNow(rec);
        await this.commitNow(rec);
        this.clearTimers(rec);
      }
    });
    await this.peers?.close();
    await this.runner.close();
    await this.relay.close();
  }

  private async ensureIdentity(): Promise<void> {
    if (this.options.identity) return;
    const name = (await this.git.run(['config', 'user.name'], { allowFail: true })).stdout.trim();
    const email = (await this.git.run(['config', 'user.email'], { allowFail: true })).stdout.trim();
    if (!name || !email) {
      const n = name || 'Kuraa host';
      const e = email || 'host@kuraa.invalid';
      this.git.setEnv({ GIT_AUTHOR_NAME: n, GIT_AUTHOR_EMAIL: e, GIT_COMMITTER_NAME: n, GIT_COMMITTER_EMAIL: e });
    }
  }

  // -------------------------------------------------------------------------
  // Paths

  /** Resolve a workspace-relative path, refusing anything outside the workspace. */
  resolvePath(path: string): string {
    const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = resolve(this.dir, clean);
    if (abs !== this.dir && !abs.startsWith(this.dir + sep)) throw new HttpError(400, 'Path outside workspace');
    const rel = relative(this.dir, abs).split(sep).join('/');
    if (rel === '.git' || rel.startsWith('.git/')) throw new HttpError(400, 'Path inside .git');
    return abs;
  }

  relPath(path: string): string {
    return relative(this.dir, this.resolvePath(path)).split(sep).join('/');
  }

  typeFor(path: string): DocumentType | undefined {
    const byName = this.registry.resolve(path);
    if (byName) return byName;
    // A file with no extension may say what it is on its first line (#!/usr/bin/env Rscript).
    const name = path.slice(path.lastIndexOf('/') + 1);
    if (name.includes('.')) return undefined;
    return this.registry.resolve(path, this.head(path));
  }

  /** The first bytes of a workspace file, or '' if it cannot be read. */
  private head(path: string): string {
    let fd: number | undefined;
    try {
      fd = openSync(this.resolvePath(path), 'r');
      const buf = Buffer.alloc(256);
      return buf.subarray(0, readSync(fd, buf, 0, 256, 0)).toString('utf8');
    } catch {
      return '';
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  // -------------------------------------------------------------------------
  // Rooms

  private roomName(rec: Pick<RoomRecord, 'branch' | 'path' | 'type' | 'generation'>): string {
    return [this.workspace, rec.branch, rec.path, `${rec.type.id}@${rec.type.version}`, rec.generation].map(encodeURIComponent).join('|');
  }

  private cacheFile(key: string): string {
    return join(this.cacheDir, createHash('sha1').update(key).digest('hex') + '.json');
  }

  /** The current room for a file, creating or resuming it. */
  async room(path: string): Promise<RoomRecord> {
    return this.serial(() => this.ensureRecord(this.relPath(path)));
  }

  private async ensureRecord(path: string): Promise<RoomRecord> {
    const branch = await this.git.branch();
    const key = `${branch}:${path}`;
    const existing = this.records.get(key);
    if (existing) {
      if (existing.timers.drop) clearTimeout(existing.timers.drop);
      return existing;
    }
    const type = this.typeFor(path);
    if (!type) throw new HttpError(415, `No document type for ${path}`);
    const abs = this.resolvePath(path);
    if (!existsSync(abs)) throw new HttpError(404, `No such file: ${path}`);
    const text = await readFile(abs, 'utf8');
    const head = await this.git.head();

    // Resume the cached generation if it is for the same type version.
    const cached = await this.readCache(key);
    let rec: RoomRecord;
    if (cached && cached.typeId === type.id && cached.typeVersion === type.version) {
      rec = this.newRecord({ key, path, branch, type, generation: cached.generation, baseCommit: cached.baseCommit, previous: type.parse(cached.text), lastHash: cached.lastHash, state: Buffer.from(cached.state, 'base64') });
      rec.lastCommit = cached.lastCommit;
      rec.lastCommitAt = cached.lastCommitAt;
      // Edits in the cached state that never reached the file are unflushed edits.
      rec.dirty = type.serialize(decodeDoc(rec.state!, type.schema), rec.previous) !== cached.text;
      // The file changed while the host was away: an outside change against the cache.
      rec.needsOutsideCheck = hashText(text) !== cached.lastHash;
    } else {
      const previous = type.parse(text);
      rec = this.newRecord({ key, path, branch, type, generation: blobId(text), baseCommit: head, previous, lastHash: hashText(text), state: null });
      rec.seedText = text;
    }
    this.records.set(key, rec);
    this.byRoom.set(rec.room, rec);
    if (rec.needsOutsideCheck) await this.applyOutside(rec, text);
    return rec;
  }

  private newRecord(init: Pick<RoomRecord, 'key' | 'path' | 'branch' | 'type' | 'generation' | 'baseCommit' | 'previous' | 'lastHash' | 'state'>): RoomRecord {
    const rec: RoomRecord = {
      ...init,
      room: '',
      seedText: null,
      dirty: false,
      uncommitted: false,
      contributors: new Map(),
      editingSince: null,
      lastFlushAt: null,
      lastCommitAt: null,
      lastCommit: null,
      needsOutsideCheck: false,
      timers: {},
    };
    rec.room = this.roomName(rec);
    return rec;
  }

  private async loadRoom(room: string): Promise<RoomSeed | null> {
    let rec = this.byRoom.get(room);
    if (!rec) {
      // After a restart a client may reconnect before asking for the room name.
      const parts = room.split('|').map(decodeURIComponent);
      const path = parts[2];
      if (!path) return null;
      try {
        rec = await this.room(path);
      } catch {
        return null;
      }
      if (rec.room !== room) return null;
    }
    if (rec.timers.drop) clearTimeout(rec.timers.drop);
    // Only the host creates room content: from saved state, or a fresh seed.
    if (rec.state) return { state: rec.state };
    rec.state = seedState(rec.type, rec.seedText ?? rec.previous.text);
    // The file changed after the room was named (an outside change): start from the blob, then make that change.
    if (rec.seedText !== null && rec.seedText !== rec.previous.text) rec.state = patchState(rec.state, rec.previous.doc);
    rec.seedText = null;
    void this.saveCache(rec);
    return { state: rec.state };
  }

  private onClientChange(room: string, user: PresenceUser | null): void {
    const rec = this.byRoom.get(room);
    if (!rec) return;
    rec.dirty = true;
    if (user) rec.contributors.set(user.email || user.name, user);
    const t = rec.timers;
    if (t.flush) clearTimeout(t.flush);
    t.flush = setTimeout(() => void this.serial(() => this.flushNow(rec)).catch((e) => this.log(`flush failed: ${e}`)), this.timings.flushMs);
    if (t.commit) clearTimeout(t.commit);
    t.commit = setTimeout(() => void this.commitRoom(rec).catch((e) => this.log(`commit failed: ${e}`)), this.timings.idleCommitMs);
    if (rec.editingSince === null) {
      rec.editingSince = Date.now();
      t.max = setTimeout(() => void this.commitRoom(rec).catch((e) => this.log(`commit failed: ${e}`)), this.timings.maxCommitMs);
    }
  }

  private onRoomEmpty(room: string): void {
    const rec = this.byRoom.get(room);
    if (!rec) return;
    this.peers?.rooms.closed(this.roomKey(rec));
    void this.serial(async () => {
      await this.flushNow(rec);
      await this.commitNow(rec);
    }).catch((e) => this.log(`teardown failed: ${e}`));
    if (rec.timers.drop) clearTimeout(rec.timers.drop);
    rec.timers.drop = setTimeout(() => {
      if (this.relay.clients(rec.room) > 0) return;
      void this.serial(async () => {
        await this.saveCache(rec);
        this.clearTimers(rec);
        this.records.delete(rec.key);
        this.byRoom.delete(rec.room);
      });
    }, this.timings.dropMs);
  }

  private clearTimers(rec: RoomRecord): void {
    for (const t of Object.values(rec.timers)) if (t) clearTimeout(t);
    rec.timers = {};
  }

  /** The room's current document, from the relay or the saved state. */
  private current(rec: RoomRecord) {
    const live = this.relay.read(rec.room, rec.type.schema);
    if (live) return live;
    return rec.state ? decodeDoc(rec.state, rec.type.schema) : rec.previous.doc;
  }

  // -------------------------------------------------------------------------
  // Flush and commit

  private async writeAtomic(abs: string, text: string): Promise<void> {
    const tmp = join(dirname(abs), `.${basename(abs)}.kuraa-tmp-${randomBytes(4).toString('hex')}`);
    await writeFile(tmp, text);
    await rename(tmp, abs);
  }

  /** Serialize the room to its file if the text changed. */
  async flushNow(rec: RoomRecord): Promise<void> {
    if (rec.timers.flush) clearTimeout(rec.timers.flush);
    rec.timers.flush = undefined;
    if (!rec.dirty) return;
    const doc = this.current(rec);
    const text = rec.type.serialize(doc, rec.previous);
    rec.dirty = false;
    const live = this.relay.state(rec.room);
    if (live) rec.state = live;
    if (text !== rec.previous.text) {
      rec.lastHash = hashText(text);
      await this.writeAtomic(this.resolvePath(rec.path), text);
      rec.previous = rec.type.parse(text);
      rec.uncommitted = true;
      rec.lastFlushAt = new Date().toISOString();
      this.broadcast(rec, { type: 'flushed', at: rec.lastFlushAt, hash: rec.lastHash });
    }
    await this.saveCache(rec);
  }

  async commitRoom(rec: RoomRecord, message?: string): Promise<string | null> {
    return this.serial(async () => {
      await this.flushNow(rec);
      return this.commitNow(rec, message);
    });
  }

  /** Commit the room's file, with each contributor since the last commit as co-author. */
  async commitNow(rec: RoomRecord, message?: string): Promise<string | null> {
    // A room shared with other devices is committed by one of them (peers/rooms.ts); a named version, by whoever names it.
    if (message === undefined && this.peers && !this.peers.rooms.commits(rec.room)) return null;
    const t = rec.timers;
    for (const k of ['commit', 'max'] as const) {
      if (t[k]) clearTimeout(t[k]);
      t[k] = undefined;
    }
    rec.editingSince = null;
    // A named version says what it is; otherwise say what changed, and mark it as a save the host made.
    let text = message;
    if (text === undefined) {
      const before = await this.git.run(['show', `HEAD:${rec.path}`], { allowFail: true });
      text = describeEdit(rec.type, rec.path, before.code === 0 ? before.stdout : null, rec.previous.text, [...rec.contributors.values()].map((u) => u.name));
    }
    const committed = await this.commitPaths([rec.path], text, [...rec.contributors.values()], message === undefined ? [AUTOSAVE_TRAILER] : []);
    rec.uncommitted = false;
    if (!committed) return null;
    rec.contributors.clear();
    rec.baseCommit = committed;
    rec.lastCommit = committed;
    rec.lastCommitAt = new Date().toISOString();
    this.broadcast(rec, { type: 'committed', at: rec.lastCommitAt, commit: committed, message: text });
    await this.saveCache(rec);
    return committed;
  }

  /** Stage and commit the given paths. Returns the commit, or null if nothing changed. */
  async commitPaths(paths: string[], message: string, coAuthors: PresenceUser[] = [], extra: string[] = []): Promise<string | null> {
    await this.git.run(['add', '-A', '--', ...paths]);
    const diff = await this.git.run(['diff', '--cached', '--quiet', '--', ...paths], { allowFail: true });
    if (diff.code === 0) return null;
    const trailers = coAuthors
      .filter((u) => u.email)
      .map((u) => `Co-authored-by: ${u.name.replace(/[<>\n]/g, '')} <${u.email.replace(/[<>\n\s]/g, '')}>`);
    const unique = [...new Set([...trailers, ...extra])];
    const full = unique.length ? `${message}\n\n${unique.join('\n')}` : message;
    await this.git.run(['commit', '-q', '-F', '-', '--', ...paths], { input: full });
    const head = await this.git.head();
    this.log(`committed ${head?.slice(0, 7)} ${message}`);
    this.refsChanged();
    return head;
  }

  onRefsChanged(fn: () => void): () => void {
    this.refsListeners.add(fn);
    return () => this.refsListeners.delete(fn);
  }

  refsChanged(): void {
    for (const fn of this.refsListeners) fn();
  }

  /** Flush and commit every open room. */
  async commitAll(message?: string): Promise<void> {
    for (const rec of this.records.values()) {
      await this.flushNow(rec);
      await this.commitNow(rec, message);
    }
  }

  // -------------------------------------------------------------------------
  // Outside changes

  private startWatcher(): void {
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = String(filename).split(sep).join('/');
        if (rel.startsWith('.git/') || rel === '.git' || rel.includes('.kuraa-tmp-')) return;
        const prev = this.watchTimers.get(rel);
        if (prev) clearTimeout(prev);
        this.watchTimers.set(rel, setTimeout(() => {
          this.watchTimers.delete(rel);
          void this.checkPath(rel);
        }, 50));
      });
    } catch (err) {
      this.log(`file watching unavailable: ${err}`);
    }
  }

  async checkPath(path: string): Promise<void> {
    const branch = await this.git.branch();
    const rec = this.records.get(`${branch}:${path}`);
    if (!rec) return;
    await this.serial(() => this.checkOutside(rec));
  }

  /** Re-check every open room against its file, e.g. after a git operation. */
  async checkAll(): Promise<void> {
    for (const rec of [...this.records.values()]) await this.checkOutside(rec);
  }

  private async checkOutside(rec: RoomRecord): Promise<void> {
    const abs = this.resolvePath(rec.path);
    if (!existsSync(abs)) return;
    const text = await readFile(abs, 'utf8');
    if (hashText(text) === rec.lastHash) return;
    await this.applyOutside(rec, text);
  }

  /**
   * Merge an outside version of the file into the room. With no unflushed
   * edits, apply it as a minimal difference. Otherwise merge three ways; on
   * conflict the live session wins and the outside version is saved beside it.
   * Quiet: the change was made in the app (a new title), so no one is told of
   * an outside change.
   */
  private async applyOutside(rec: RoomRecord, text: string, quiet = false): Promise<void> {
    rec.needsOutsideCheck = false;
    const at = new Date().toISOString();
    const theirs = rec.type.parse(text);
    if (!rec.dirty) {
      this.applyDoc(rec, theirs.doc);
      rec.previous = theirs;
      rec.lastHash = hashText(text);
      if (!quiet) this.broadcast(rec, { type: 'outside-change', at, merged: false });
      this.log(`outside change applied to ${rec.path}`);
      await this.saveCache(rec);
      return;
    }
    const base = rec.previous.text;
    const ours = rec.type.serialize(this.current(rec), rec.previous);
    const merged = await this.git.mergeFile(ours, base, text, join(this.cacheDir, '..'));
    rec.previous = theirs;
    rec.lastHash = hashText(text);
    if (!merged.conflict) {
      this.applyDoc(rec, rec.type.parse(merged.text).doc);
      if (!quiet) this.broadcast(rec, { type: 'outside-change', at, merged: true });
      this.log(`outside change merged into ${rec.path}`);
    } else {
      const savedAs = `${rec.path}.outside-${at.replace(/[:.]/g, '-')}`;
      await writeFile(this.resolvePath(savedAs), text);
      this.broadcast(rec, { type: 'conflict', at, savedAs });
      this.log(`outside change to ${rec.path} conflicted; saved as ${savedAs}`);
    }
    // The room now differs from the file: write it back soon.
    rec.dirty = true;
    await this.flushNow(rec);
  }

  private applyDoc(rec: RoomRecord, doc: ReturnType<DocumentType['parse']>['doc']): void {
    if (this.relay.apply(rec.room, doc)) {
      rec.state = this.relay.state(rec.room);
    } else if (rec.state) {
      rec.state = patchState(rec.state, doc);
    }
  }

  /** Send a message to everyone with `path` open, on any branch or generation. */
  broadcastPath(path: string, message: RoomMessage): void {
    for (const rec of this.records.values()) if (rec.path === path) this.broadcast(rec, message);
  }

  private broadcast(rec: RoomRecord, message: RoomMessage): void {
    this.relay.broadcast(rec.room, message);
  }

  // -------------------------------------------------------------------------
  // Cache

  private async readCache(key: string): Promise<CacheEntry | null> {
    try {
      return JSON.parse(await readFile(this.cacheFile(key), 'utf8')) as CacheEntry;
    } catch {
      return null;
    }
  }

  private async saveCache(rec: RoomRecord): Promise<void> {
    if (!rec.state) return;
    const entry: CacheEntry = {
      key: rec.key, path: rec.path, branch: rec.branch, typeId: rec.type.id, typeVersion: rec.type.version,
      generation: rec.generation, baseCommit: rec.baseCommit, lastHash: rec.lastHash, text: rec.previous.text,
      state: Buffer.from(rec.state).toString('base64'), lastCommit: rec.lastCommit, lastCommitAt: rec.lastCommitAt,
    };
    await this.writeAtomic(this.cacheFile(rec.key), JSON.stringify(entry));
  }

  // -------------------------------------------------------------------------
  // Merging

  /** Start syncing with this workspace's devices (at start with --peer, or when the first invitation is made). */
  async startPeers(options: PeerOptions): Promise<Peers> {
    if (this.peers) return this.peers;
    // Loaded only when on: it brings Hyperswarm and its native parts.
    const { Peers } = await import('./peers/peers.js');
    const peers = new Peers(this, options, join(await this.git.gitDir(), 'kuraa'));
    await peers.start();
    this.peers = peers;
    return peers;
  }

  /** The workspace's devices, syncing, for making an invitation from the app; refused unless the operator allows it. */
  async peersForInvites(): Promise<Peers> {
    const allowed = this.options.invites;
    if (!allowed) throw new HttpError(403, 'Making invitations from the app is turned off on this host (start it with --allow-invites)');
    if (this.peers) return this.peers;
    const peers = await this.startPeers(allowed.peers ?? {});
    this.log('syncing with other devices is now on, for an invitation');
    await allowed.onPeersOn?.();
    return peers;
  }

  /** Where merges keep their temporary index. */
  get tmpDir(): string {
    return join(this.cacheDir, '..', 'tmp');
  }

  /**
   * Merge commits as every device does (see merging.ts), reading files with
   * this host's document types.
   */
  merge(x: string, y: string, override?: (path: string) => string | undefined): Promise<MergeOutcome> {
    return mergeCommits(this.git, x, y, { typeFor: (path, head) => this.registry.resolve(path, head), override, tmpDir: this.tmpDir });
  }

  /**
   * Bring a commit into the current branch: a fast-forward, or a merge made as
   * every device makes it. Open rooms are committed first, and take the result
   * as an outside change. Call inside serial().
   */
  async integrate(ref: string, override?: (path: string) => string | undefined): Promise<MergeOutcome> {
    await this.commitAll();
    const theirs = await this.git.out(['rev-parse', '--verify', `${ref}^{commit}`]);
    const head = await this.git.head();
    const outcome = head ? await this.merge(head, theirs, override) : { commit: theirs, kind: 'fast-forward' as const, conflicts: [], copies: [] };
    if (outcome.commit !== head) {
      // Rooms another device commits (shared rooms, peers/rooms.ts) are left to it:
      // only the device that commits a shared room brings changes from git into
      // it, and the others get them through the room, so no change is made twice
      // there. Here, such a room's file is put back as committed for the move, and
      // the room written out again after it. A room with uncommitted edits is
      // handled the same way, its edits being in the room.
      const branch = await this.git.branch();
      const held = [...this.records.values()].filter((r) => r.branch === branch && (r.uncommitted || (this.peers && !this.peers.rooms.commits(r.room))));
      for (const rec of held) {
        const before = await this.git.run(['show', `HEAD:${rec.path}`], { allowFail: true });
        if (before.code === 0) await this.writeAtomic(this.resolvePath(rec.path), before.stdout);
        else await rm(this.resolvePath(rec.path), { force: true });
        const text = before.code === 0 ? before.stdout : '';
        rec.previous = rec.type.parse(text);
        rec.lastHash = hashText(text);
        rec.dirty = true;
        rec.uncommitted = false;
      }
      const r = await this.git.run(['merge', '--ff-only', '-q', outcome.commit], { allowFail: true });
      if (r.code !== 0) throw new Error(`Could not update the files to ${outcome.commit.slice(0, 7)}: ${(r.stderr || r.stdout).trim()}`);
      for (const rec of this.records.values()) if (rec.branch === branch) rec.baseCommit = outcome.commit;
      for (const rec of held) {
        // Uncommitted edits of a room this device commits (none, after commitAll) would merge in as an outside change.
        if (override?.(rec.path) === undefined && !(this.peers && !this.peers.rooms.commits(rec.room))) continue;
        const now = existsSync(this.resolvePath(rec.path)) ? await readFile(this.resolvePath(rec.path), 'utf8') : '';
        rec.previous = rec.type.parse(now);
        rec.lastHash = hashText(now);
        await this.flushNow(rec);
      }
      this.log(`${outcome.kind === 'merge' ? 'merged' : 'moved to'} ${outcome.commit.slice(0, 7)}${outcome.conflicts.length ? ` (conflicts kept in ${outcome.conflicts.map((c) => c.path).join(', ')})` : ''}`);
      await this.checkAll();
      this.refsChanged();
      // The files may have changed: everyone with something open reloads the list.
      for (const rec of this.records.values()) this.broadcast(rec, { type: 'files-changed', at: new Date().toISOString() });
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Rooms, as other devices see them (peers/rooms.ts)

  get sessionRelay(): Relay {
    return this.relay;
  }

  /** A room's key among devices: branch, path and type version (not the seed, which is separate). */
  private roomKey(rec: RoomRecord): string {
    return `${rec.branch}\0${rec.path}\0${rec.type.id}@${rec.type.version}`;
  }

  roomView(name: string): RoomView | undefined {
    const rec = this.byRoom.get(name);
    return rec && { name: rec.room, key: this.roomKey(rec), seed: rec.generation, path: rec.path, branch: rec.branch };
  }

  /** Rooms someone has open here. */
  liveRooms(): RoomView[] {
    return [...this.records.values()].filter((r) => this.relay.isOpen(r.room)).map((r) => this.roomView(r.room)!);
  }

  /** A room's text as it is now. */
  roomText(name: string): string | undefined {
    const rec = this.byRoom.get(name);
    return rec && rec.type.serialize(this.current(rec), rec.previous);
  }

  /** The commit a room's text was last based on (where it started, or its last commit or merge). */
  roomBase(name: string): string | null {
    return this.byRoom.get(name)?.baseCommit ?? null;
  }

  /** Who has edited a room since its last commit. */
  roomContributors(name: string): PresenceUser[] {
    return [...(this.byRoom.get(name)?.contributors.values() ?? [])];
  }

  /** Credit people who edited a room on another device, for the next commit. */
  addContributors(name: string, users: PresenceUser[]): void {
    const rec = this.byRoom.get(name);
    if (!rec) return;
    for (const u of users) if (u && typeof u.name === 'string') rec.contributors.set(u.email || u.name, { name: u.name, email: String(u.email ?? ''), color: String(u.color ?? '') });
  }

  /** Commit a room after the usual wait (this device has become the one that commits it). */
  commitSoon(name: string): void {
    const rec = this.byRoom.get(name);
    if (!rec || (!rec.uncommitted && !rec.dirty)) return;
    if (rec.timers.commit) clearTimeout(rec.timers.commit);
    rec.timers.commit = setTimeout(() => void this.commitRoom(rec).catch((e) => this.log(`commit failed: ${e}`)), this.timings.idleCommitMs);
  }

  /**
   * Take another device's room for a file in place of this one's (it started
   * from another blob, so their histories cannot merge): this room's text is
   * merged three ways into it, from the blob this room started from. People
   * here are moved to the new room.
   */
  async adoptRoom(name: string, seed: string, state: Uint8Array, from: string, theirBase: string | null = null): Promise<void> {
    await this.serial(async () => {
      const rec = this.byRoom.get(name);
      if (!rec || rec.generation === seed) return;
      await this.flushNow(rec);
      const ours = rec.type.serialize(this.current(rec), rec.previous);
      const theirs = rec.type.serialize(decodeDoc(state, rec.type.schema), rec.previous);
      // The base is the file where the two rooms' histories meet: at the merge base of the
      // commits each started from; failing that, the blob this room started from.
      const show = async (rev: string) => {
        const r = await this.git.run(['show', `${rev}:${rec.path}`], { allowFail: true });
        return r.code === 0 ? r.stdout : null;
      };
      const meet = rec.baseCommit && theirBase ? await this.git.run(['merge-base', rec.baseCommit, theirBase], { allowFail: true }) : null;
      const blob = await this.git.run(['cat-file', 'blob', rec.generation], { allowFail: true });
      const base = (meet?.code === 0 ? ((await show(meet.stdout.trim())) ?? '') : null) ?? (blob.code === 0 ? blob.stdout : null) ?? (await show('HEAD')) ?? ours;
      const sides: [{ by: string }, { by: string }] = [{ by: this.peers?.node.name ?? 'this device' }, { by: from }];
      const merged = rec.type.merge ? rec.type.merge(base, ours, theirs, sides) : mergeLines(base, ours, theirs, sides);
      const next = merged.text === theirs ? state : patchState(state, rec.type.parse(merged.text).doc);
      const old = rec.room;
      this.byRoom.delete(old);
      rec.generation = seed;
      rec.room = this.roomName(rec);
      rec.state = next;
      rec.seedText = null;
      rec.dirty = true;
      this.byRoom.set(rec.room, rec);
      this.log(`took ${from}'s room for ${rec.path}${merged.conflicts ? ` (${merged.conflicts} conflict${merged.conflicts === 1 ? '' : 's'} kept)` : ''}`);
      this.relay.broadcast(old, { type: 'reseeded', at: new Date().toISOString(), room: rec.room });
      this.relay.closeRoom(old);
      await this.flushNow(rec);
      await this.saveCache(rec);
    });
  }

  /** The ordinary git remote Sync fetches from, merges and pushes to: --upstream, else the workspace's, else origin. */
  async gitUpstream(): Promise<string | null> {
    const urls = await this.git.run(['config', '--get-regexp', '^remote\\..*\\.url$'], { allowFail: true });
    const remotes = urls.stdout.split('\n').map((l) => /^remote\.(.+)\.url (.*)$/.exec(l.trim())).filter((m) => m && !m[2]!.startsWith('kuraa://')).map((m) => m![1]!);
    if (this.options.upstream) return this.options.upstream;
    const chosen = (await this.git.run(['config', '--get', 'kuraa.upstream'], { allowFail: true })).stdout.trim();
    if (chosen && remotes.includes(chosen)) return chosen;
    if (chosen && this.peers) return null;
    return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
  }

  /** Fetch from an ordinary remote, bring its branch in (never stopping on a conflict), and push. Call inside serial(). */
  async syncRemote(remote: string): Promise<{ ok: boolean; message: string; head?: string | null }> {
    await this.commitAll();
    const branch = await this.git.branch();
    await this.git.run(['fetch', remote]);
    const hasRemoteBranch = (await this.git.run(['rev-parse', '--verify', '-q', `${remote}/${branch}`], { allowFail: true })).code === 0;
    let kept = '';
    if (hasRemoteBranch) {
      // Never stops on a conflict: both versions stay in the document, to choose between there.
      const outcome = await this.integrate(`${remote}/${branch}`);
      kept = describeOutcome(outcome);
    }
    await this.git.run(['push', remote, `HEAD:${branch}`]);
    return { ok: true, message: `Synced with ${remote}/${branch}${kept}`, head: await this.git.head() };
  }

  /** Sync: with the paired devices that are connected, and with an ordinary upstream remote if there is one. */
  async syncNow(): Promise<{ ok: boolean; message: string; head?: string | null }> {
    const remote = await this.gitUpstream();
    const said: string[] = [];
    if (this.peers) said.push(await this.peers.syncAll());
    if (remote) {
      const r = await this.serial(() => this.syncRemote(remote));
      if (!this.peers) return r;
      said.push(r.message);
    }
    if (!said.length) return { ok: false, message: 'No upstream remote is configured' };
    return { ok: true, message: said.join('. '), head: await this.git.head() };
  }

  /** How many conflicts a file keeps: from its open room if it has one, else from the file (read again only when it changed). */
  async conflictsOf(path: string, branch: string): Promise<number> {
    const type = this.typeFor(path);
    if (!type) return 0;
    const rec = this.records.get(`${branch}:${path}`);
    if (rec) return conflictsIn(type.serialize(this.current(rec), rec.previous), type);
    try {
      const s = await stat(this.resolvePath(path));
      const stamp = `${s.mtimeMs}:${s.size}:${type.id}`;
      const hit = this.conflictCache.get(path);
      if (hit?.stamp === stamp) return hit.count;
      const count = conflictsIn(await readFile(this.resolvePath(path), 'utf8'), type);
      this.conflictCache.set(path, { stamp, count });
      return count;
    } catch {
      return 0;
    }
  }

  // -------------------------------------------------------------------------
  // Titles

  /**
   * A document's title: from its open room if it has one (the live text), else
   * from the file, read again only when it has changed. Null for types without
   * titles, and documents without one.
   */
  async titleOf(path: string, branch: string): Promise<string | null> {
    const type = this.typeFor(path);
    if (!type?.title) return null;
    const rec = this.records.get(`${branch}:${path}`);
    if (rec) return type.title.read(type.serialize(this.current(rec), rec.previous));
    const abs = this.resolvePath(path);
    try {
      const s = await stat(abs);
      const stamp = `${s.mtimeMs}:${s.size}:${type.id}`;
      const hit = this.titleCache.get(path);
      if (hit?.stamp === stamp) return hit.title;
      const title = type.title.read(await readFile(abs, 'utf8'));
      this.titleCache.set(path, { stamp, title });
      return title;
    } catch {
      return null;
    }
  }

  /**
   * Check that a document can take this title: it has titles, the title is not
   * empty, and its header can be edited. Throws an HttpError (400) if not.
   */
  async checkTitle(path: string, title: string): Promise<void> {
    const type = this.typeFor(path);
    if (!type?.title) throw new HttpError(400, `${path} is not a document with a title`);
    try {
      type.title.write(await readFile(this.resolvePath(path), 'utf8'), title);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
  }

  /**
   * Give a document a new title, on disk and in its open room, if it has one;
   * people editing it see the change, as anyone's edit. Call inside serial().
   */
  async setTitle(path: string, title: string): Promise<void> {
    const type = this.typeFor(path);
    if (!type?.title) throw new HttpError(400, `${path} is not a document with a title`);
    const rec = this.records.get(`${await this.git.branch()}:${path}`);
    if (rec) await this.flushNow(rec);
    const abs = this.resolvePath(path);
    const text = await readFile(abs, 'utf8');
    let next: string;
    try {
      next = type.title.write(text, title);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    if (next === text) return;
    await this.writeAtomic(abs, next);
    if (rec) await this.applyOutside(rec, next, true);
  }

  /** Close a file's room and forget its cache (after rename or delete). */
  async dropRoom(path: string): Promise<void> {
    const branch = await this.git.branch();
    const key = `${branch}:${path}`;
    const rec = this.records.get(key);
    if (rec) {
      await this.flushNow(rec);
      await this.commitNow(rec);
      this.clearTimers(rec);
      this.relay.closeRoom(rec.room);
      this.records.delete(key);
      this.byRoom.delete(rec.room);
    }
    await rm(this.cacheFile(key), { force: true });
  }

  /** Close the rooms of every open file under a folder (before the folder moves). */
  async dropRoomsUnder(folder: string): Promise<void> {
    const prefix = `${folder.replace(/\/+$/, '')}/`;
    const paths = [...new Set([...this.records.values()].map((r) => r.path).filter((p) => p.startsWith(prefix)))];
    for (const p of paths) await this.dropRoom(p);
  }

  /** Public view of a room for the HTTP API. */
  describe(rec: RoomRecord) {
    return {
      room: rec.room,
      path: rec.path,
      branch: rec.branch,
      type: rec.type.id,
      generation: rec.generation,
      baseCommit: rec.baseCommit,
      lastFlushAt: rec.lastFlushAt,
      lastCommitAt: rec.lastCommitAt,
      lastCommit: rec.lastCommit,
      dirty: rec.dirty,
      uncommitted: rec.uncommitted,
    };
  }

  openRooms(): RoomRecord[] {
    return [...this.records.values()];
  }
}

/** What a merge kept, for a message: "; 1 conflict kept in notes.md, …". Empty if it kept none. */
export function describeOutcome(outcome: MergeOutcome): string {
  let kept = '';
  const n = outcome.conflicts.reduce((sum, c) => sum + c.count, 0);
  if (n) kept = `; ${n} conflict${n === 1 ? '' : 's'} kept in ${outcome.conflicts.map((c) => c.path).join(', ')}, to choose between in the document`;
  if (outcome.copies.length) kept += `; the other version of ${outcome.copies.length === 1 ? 'a file' : 'some files'} saved as ${outcome.copies.join(', ')}`;
  return kept;
}

/** A text's git blob id, as `git hash-object` gives it. */
export function blobId(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** The starting state of a room for a file's text: the same on every device for the same text and type version. */
export function seedState(type: DocumentType, text: string): Uint8Array {
  const id = createHash('sha1').update(`${blobId(text)}\0${type.id}@${type.version}`).digest().readUInt32BE(0);
  return encodeSeed(type.parse(text).doc, id || 1);
}

/** A room as other devices know it. */
export interface RoomView {
  /** Its name here (for the relay). */
  name: string;
  /** Branch, path and type version: the same on every device. */
  key: string;
  /** The blob it started from. */
  seed: string;
  path: string;
  branch: string;
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
