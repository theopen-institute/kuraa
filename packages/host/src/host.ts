// The host: relay, bridge, committer and git peer for one workspace.
import { isUtf8 } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, lstatSync, openSync, readSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { TypeRegistry, hashText, mergeLines, type DocumentType, type ParsedDocument } from '@kuraa/kernel';
import { standardTypes } from '@kuraa/formats';
import { Relay, decodeDoc, encodeSeed, patchState, type PresenceUser, type RoomMessage, type RoomSeed } from '@kuraa/session/server';
import { Git, NON_INTERACTIVE } from './git.js';
import { HttpError } from './errors.js';
import { renameOver } from './files.js';
import { commitSigned, signCommitObject } from './signing.js';
import { Backups } from './backups.js';
import { serialQueue } from './serial.js';
import { initWorkspace } from './workspace.js';
import { Runner, type RunOptions } from './runner.js';
import { loadRunComponents } from './components.js';
import { createRequestHandler, sameToken } from './http.js';
import { conflictsIn, mergeCommits, mergeSignature, type MergeOutcome } from './merging.js';
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
  /** Push to backups this long after the last commit (backups.ts). */
  backupMs: number;
  /** Look this often at where git is (a branch switched, an operation under way outside the app) while rooms are open. */
  gitPollMs: number;
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
  invites?: { peers?: PeerOptions };
  /**
   * People using the app may see, make and import this computer's person's key
   * (person.ts), whose this host's commits are (0034). Only where the one who runs
   * the host is the one using it (`pnpm dev`; --manage-person): on a shared
   * server, its key is its operator's.
   */
  managePerson?: boolean;
  /**
   * People using the app may add and remove backups (backups.ts): git servers
   * pushed to with this computer's credentials. Only where the one running the
   * host is the one using it (the desktop app, `pnpm dev`; --manage-backups).
   * Everyone sees them, and may ask for a push.
   */
  manageBackups?: boolean;
  timings?: Partial<HostTimings>;
  log?: (msg: string) => void;
}

/** How long a sync may wait for its remote, fetching and pushing. */
/** How many files the file list reads at once. */
const TREE_READS = 16;
const FETCH_MS = 5 * 60_000;
const PUSH_MS = 10 * 60_000;

export const DEFAULT_TIMINGS: HostTimings = { flushMs: 2000, idleCommitMs: 30_000, maxCommitMs: 300_000, dropMs: 60_000, backupMs: 30_000, gitPollMs: 1000 };

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
  /** Edited by someone on this device (not another device's edits) since its last commit. */
  localEdits: boolean;
  editingSince: number | null;
  lastFlushAt: string | null;
  lastCommitAt: string | null;
  lastCommit: string | null;
  needsOutsideCheck: boolean;
  /** Writes or commits that failed in a row; retried with a growing wait. */
  failures: number;
  timers: { flush?: NodeJS.Timeout; commit?: NodeJS.Timeout; max?: NodeJS.Timeout; drop?: NodeJS.Timeout; retry?: NodeJS.Timeout };
}

/**
 * Where git is in the working tree: the branch checked out (null: none, an
 * earlier version is), and a git operation under way outside the app, if any.
 */
export interface GitState {
  branch: string | null;
  operation: string | null;
}

/** Files git keeps while an operation is under way (in the repository's git folder). */
const OPERATIONS = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG'];

/** Why saving is paused, for people, or null if it is not. */
export function pausedBecause(st: GitState): string | null {
  if (st.operation) return 'Saving is paused while git is in the middle of an operation in this folder, outside the app. Your edits are kept, and saved when it is done.';
  if (!st.branch) return 'Saving is paused: this folder is showing an earlier version, not a branch. Your edits are kept, and saved when it is back on a branch.';
  return null;
}

/** The host never follows a symbolic link (docs/decisions/0037-host-safety.md). */
const linkRefused = (path: string) => `${path} is a link to somewhere else: the app does not open or follow links`;
const notUtf8 = (path: string) => `${path} is not saved as UTF-8 text (perhaps Latin-1 or another older encoding): the app cannot edit it without changing its characters. Save it as UTF-8 elsewhere to edit it here.`;

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
  /**
   * The same, to merge by: merges read files with every type the host has,
   * whether or not it is on here, so that turning a format off (--format) does
   * not change how this device merges.
   */
  private readonly mergeTypes = new TypeRegistry();
  /** How this device merges, for other devices to compare (merging.ts). */
  readonly mergeSignature: string;
  readonly git: Git;
  readonly dir: string;
  readonly token: string;
  readonly timings: HostTimings;
  /** Git servers this workspace is pushed to, and nothing more (backups.ts). */
  readonly backups: Backups;
  readonly workspace: string;
  private readonly records = new Map<string, RoomRecord>();
  private readonly byRoom = new Map<string, RoomRecord>();
  private relay!: Relay;
  runner!: Runner;
  private watcher: FSWatcher | null = null;
  private cacheDir = '';
  private watchTimers = new Map<string, NodeJS.Timeout>();
  /** What the file list shows of files not open in a room, by path, with the file's size and time when read. */
  private readonly factsCache = new Map<string, { stamp: string; title: string | null; conflicts: number; cannotOpen: string | null }>();
  /** Told when a branch moves (a commit, a merge): the peer layer tells other devices. */
  private readonly refsListeners = new Set<() => void>();
  /** The workspace's other devices, when this host is one of them (see peers/). */
  peers: Peers | null = null;
  private closed = false;
  address: AddressInfo | null = null;
  /** The workspace folder with any links in its own path resolved (/var is /private/var on macOS). */
  private realDir = '';
  private gitDirPath = '';
  /** Where git was when last looked at. */
  private gitState: GitState = { branch: null, operation: null };
  /** The branch rooms are written to: the one checked out when saving last could. */
  private onBranch: string | null = null;
  private gitCheck: Promise<void> | null = null;
  private gitPoll: NodeJS.Timeout | undefined;

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
    this.backups = new Backups(this.git, { delayMs: this.timings.backupMs, log: (m) => this.log(m), serial: (fn) => this.serial(fn) });
    this.allTypes = options.types ?? standardTypes;
    const known = this.allTypes.map((t) => t.id);
    for (const id of options.formats ?? []) if (!known.includes(id)) throw new Error(`Unknown format "${id}". Known: ${known.join(', ')}.`);
    for (const t of this.allTypes) if (!options.formats || options.formats.includes(t.id)) this.registry.register(t);
    for (const t of this.allTypes) this.mergeTypes.register(t);
    this.mergeSignature = mergeSignature(this.allTypes);
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
  readonly serial = serialQueue();

  async start(): Promise<AddressInfo> {
    if (!(await this.git.isRepo())) {
      if (!this.options.init) throw new Error(`Not a git repository: ${this.dir}`);
      await initWorkspace(this.dir);
      this.log(`initialised a git repository in ${this.dir}`);
    }
    this.gitDirPath = await this.git.gitDir();
    this.realDir = realpathSync(this.dir);
    this.cacheDir = join(this.gitDirPath, 'kuraa', 'rooms');
    this.gitState = await this.readGitState();
    this.onBranch = this.gitState.branch;
    // Backups take what was committed, a while after; and, at start, whatever was committed while the host was away.
    this.onRefsChanged(() => this.backups.changed());
    this.backups.changed();
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
    await this.removeLeftovers();
    await this.ensureIdentity();
    // Pushes from other clones update the working tree, so open rooms see them.
    await this.git.run(['config', 'receive.denyCurrentBranch', 'updateInstead']);

    const handler = createRequestHandler(this);
    this.relay = new Relay({
      authenticate: (token, params) => {
        if (!sameToken(token, this.token)) throw new Error('Invalid token');
        return {
          name: params.get('name') || 'Anonymous',
          email: params.get('email') || '',
          color: params.get('color') || '#888888',
        };
      },
      load: (room) => this.loadRoom(room),
      loaded: (room) => this.peers?.rooms.opened(room),
      changed: (room, user, local) => this.onClientChange(room, user, local),
      store: (room, state) => {
        const rec = this.byRoom.get(room);
        if (rec) {
          rec.state = state;
          this.saveCache(rec).catch((e) => this.log(`could not keep ${rec.path}'s room: ${e}`));
        }
      },
      empty: (room) => this.onRoomEmpty(room),
      request: handler,
    }, { host: this.options.host ?? '127.0.0.1', port: this.options.port ?? 0 });
    this.address = await this.relay.listen();
    this.startWatcher();
    // Branches switched and operations run outside the app are seen here (and by the watcher, sooner).
    this.gitPoll = setInterval(() => {
      if (this.records.size) void this.checkGit();
    }, this.timings.gitPollMs);
    this.gitPoll.unref();
    if (this.options.peers) await this.startPeers(this.options.peers === true ? {} : this.options.peers);
    this.log(`host serving ${this.dir} on http://${this.address.address}:${this.address.port}`);
    return this.address;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.backups.close();
    this.watcher?.close();
    clearInterval(this.gitPoll);
    for (const t of this.watchTimers.values()) clearTimeout(t);
    // Every room, whatever happens to one of them: what is not written stays in the room's cache.
    await this.serial(async () => {
      for (const rec of this.records.values()) {
        try {
          await this.flushNow(rec);
          await this.commitNow(rec);
        } catch (e) {
          this.log(`could not save ${rec.path} while stopping (kept in its room, for next time): ${(e as Error).message}`);
        }
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

  /**
   * Resolve a workspace-relative path, refusing anything outside the workspace,
   * and any path through a symbolic link (`link: 'self'`: but for the last part,
   * to delete or rename the link itself, never what it points to).
   */
  resolvePath(path: string, o: { link?: 'self' } = {}): string {
    const clean = path.replace(/\\/g, '/').replace(/^\/+/, '');
    const abs = resolve(this.dir, clean);
    if (abs !== this.dir && !abs.startsWith(this.dir + sep)) throw new HttpError(400, 'Path outside workspace');
    // On Windows a colon names a file's hidden stream (.git::$INDEX_ALLOCATION is .git).
    if (process.platform === 'win32' && clean.includes(':')) throw new HttpError(400, 'Path outside workspace');
    const rel = relative(this.dir, abs).split(sep).join('/');
    // .git however it is written where names ignore case (macOS, Windows), or end in dots
    // and spaces Windows drops, or by its short name on Windows (GIT~1).
    const top = rel.split('/')[0]!.toLowerCase().replace(/[. ]+$/, '');
    if (top === '.git' || (process.platform === 'win32' && /^git~\d+$/.test(top))) throw new HttpError(400, 'Path inside .git');
    this.refuseLinks(abs, rel, o.link === 'self');
    return abs;
  }

  /**
   * The host never follows a symbolic link: refuse a path any part of which is
   * one, and check that where it really is stays inside the workspace's real
   * folder. Parts not there yet (a new file) have nothing to follow.
   */
  private refuseLinks(abs: string, rel: string, leafLink: boolean): void {
    const parts = rel.split('/').filter(Boolean);
    let at = this.dir;
    let real = at;
    for (let i = 0; i < parts.length; i++) {
      const next = join(at, parts[i]!);
      let s;
      try {
        s = lstatSync(next);
      } catch {
        break;
      }
      if (s.isSymbolicLink()) {
        if (leafLink && i === parts.length - 1) break;
        throw new HttpError(403, linkRefused(rel));
      }
      at = real = next;
    }
    if (!this.realDir) return;
    let where: string;
    try {
      where = realpathSync(real);
    } catch {
      return;
    }
    if (where !== this.realDir && !where.startsWith(this.realDir + sep)) throw new HttpError(403, linkRefused(rel));
  }

  /** A workspace file's text; refused if it is not UTF-8 (it would come back with its characters changed). */
  private async readText(abs: string, path: string): Promise<string> {
    const bytes = await readNoFollow(abs);
    if (!isUtf8(bytes)) throw new HttpError(415, notUtf8(path));
    return bytes.toString('utf8');
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
    const st = await this.readGitState();
    // No branch to save to (an earlier version is checked out, or a rebase is under way): nothing new opens.
    if (!st.branch) throw new HttpError(409, pausedBecause(st)!);
    const branch = st.branch;
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
    const text = await this.readText(abs, path);
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
      localEdits: false,
      editingSince: null,
      lastFlushAt: null,
      lastCommitAt: null,
      lastCommit: null,
      needsOutsideCheck: false,
      failures: 0,
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
    this.saveCache(rec).catch((e) => this.log(`could not keep ${rec.path}'s room: ${e}`));
    return { state: rec.state };
  }

  private onClientChange(room: string, user: PresenceUser | null, local = true): void {
    const rec = this.byRoom.get(room);
    if (!rec) return;
    rec.dirty = true;
    if (local) rec.localEdits = true;
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
      this.serial(async () => {
        // Not if it was taken up again meanwhile, or still has edits to save (they are tried again).
        if (this.relay.clients(rec.room) > 0 || this.records.get(rec.key) !== rec) return;
        await this.saveCache(rec);
        if (rec.dirty || rec.uncommitted) return;
        this.clearTimers(rec);
        this.records.delete(rec.key);
        this.byRoom.delete(rec.room);
      }).catch((e) => this.log(`could not close ${rec.path}'s room: ${e}`));
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

  /** Write a file whole or not at all: a new file beside it, on the disk for sure, then renamed over it. */
  private async writeAtomic(abs: string, text: string | Buffer): Promise<void> {
    const tmp = join(dirname(abs), `.${basename(abs)}.kuraa-tmp-${randomBytes(4).toString('hex')}`);
    try {
      const fh = await open(tmp, 'wx');
      try {
        await fh.writeFile(text);
        await fh.sync();
      } finally {
        await fh.close();
      }
      await renameOver(tmp, abs);
    } catch (e) {
      await rm(tmp, { force: true });
      throw e;
    }
  }

  /** Temporary files a write left when the host stopped half-way (writeAtomic): in the workspace and the room cache. */
  private async removeLeftovers(): Promise<void> {
    const r = await this.git.run(['ls-files', '--others', '--exclude-standard', '-z', '--', '*.kuraa-tmp-*'], { allowFail: true });
    const tmp = /(^|\/)\.[^/]+\.kuraa-tmp-[0-9a-f]{8}$/;
    const found = r.stdout.split('\0').filter((p) => tmp.test(p)).map((p) => join(this.dir, p));
    for (const f of await readdir(this.cacheDir).catch(() => [] as string[])) if (tmp.test(f)) found.push(join(this.cacheDir, f));
    for (const f of found) await rm(f, { force: true }).catch(() => undefined);
    if (found.length) this.log(`removed ${found.length} unfinished temporary file${found.length === 1 ? '' : 's'}`);
  }

  /**
   * Serialize the room to its file if the text changed. Only onto the branch the
   * room is for, and not while git is in the middle of an operation: then the
   * edits wait in the room (and its cache). Before writing, the file is read: if
   * someone changed it since it was last seen (and the watcher missed it), that
   * change is merged in first, or kept beside it.
   */
  async flushNow(rec: RoomRecord): Promise<void> {
    if (rec.timers.flush) clearTimeout(rec.timers.flush);
    rec.timers.flush = undefined;
    if (!rec.dirty) return;
    const live = this.relay.state(rec.room);
    if (live) rec.state = live;
    const st = await this.readGitState();
    if (pausedBecause(st) || st.branch !== rec.branch) {
      // Kept for later: committed onto its own branch (commitNow), or written when git is done.
      await this.saveCache(rec);
      if (st.branch !== this.gitState.branch || st.operation !== this.gitState.operation) void this.checkGit();
      return;
    }
    let abs: string;
    let disk: Buffer | null;
    try {
      abs = this.resolvePath(rec.path);
      disk = existsSync(abs) ? await readNoFollow(abs) : null;
    } catch (e) {
      this.saveFailed(rec, e);
      throw e;
    }
    const notText = !!disk && !isUtf8(disk);
    if (disk && !notText && hashText(disk.toString('utf8')) !== rec.lastHash) {
      // Changed outside the app since it was last seen: merged in first (applyOutside writes the result).
      return this.applyOutside(rec, disk.toString('utf8'));
    }
    // Made something that is not text outside the app: keep that beside it, and write the room.
    if (notText) await this.saveBeside(rec, disk!);
    const doc = this.current(rec);
    const text = rec.type.serialize(doc, rec.previous);
    rec.dirty = false;
    if (text !== rec.previous.text || notText) {
      try {
        await this.writeAtomic(abs, text);
      } catch (e) {
        // Not written (on Windows another program may hold the file): the edits wait, and it is tried again.
        rec.dirty = true;
        this.saveFailed(rec, e);
        throw e;
      }
      rec.lastHash = hashText(text);
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

  /**
   * Commit the room's file, with each contributor since the last commit as
   * co-author. A room for a branch that is no longer checked out is committed
   * onto that branch by its ref alone (commitToBranch), never onto another's.
   * Nothing is committed while git is in the middle of an operation.
   */
  async commitNow(rec: RoomRecord, message?: string): Promise<string | null> {
    // A room shared with other devices is committed by one of them (peers/rooms.ts); a named version, by whoever names it.
    if (message === undefined && this.peers && !this.peers.rooms.commits(rec.room)) return null;
    const st = await this.readGitState();
    if (pausedBecause(st)) return null;
    const t = rec.timers;
    for (const k of ['commit', 'max', 'retry'] as const) {
      if (t[k]) clearTimeout(t[k]);
      t[k] = undefined;
    }
    rec.editingSince = null;
    const people = [...rec.contributors.values()];
    const extra = message === undefined ? [AUTOSAVE_TRAILER] : [];
    let committed: string | null;
    let text = message;
    try {
      if (st.branch === rec.branch) {
        // A named version says what it is; otherwise say what changed, and mark it as a save the host made.
        if (text === undefined) {
          const before = await this.git.run(['show', `HEAD:${rec.path}`], { allowFail: true });
          text = describeEdit(rec.type, rec.path, before.code === 0 ? before.stdout : null, rec.previous.text, people.map((u) => u.name));
        }
        committed = await this.commitPaths([rec.path], text, people, extra);
      } else {
        const now = rec.type.serialize(this.current(rec), rec.previous);
        if (text === undefined) {
          const before = await this.git.run(['show', `refs/heads/${rec.branch}:${rec.path}`], { allowFail: true });
          text = describeEdit(rec.type, rec.path, before.code === 0 ? before.stdout : null, now, people.map((u) => u.name));
        }
        committed = await this.commitToBranch(rec.branch, rec.path, now, withTrailers(text, people, extra));
        rec.previous = rec.type.parse(now);
        rec.lastHash = hashText(now);
        rec.dirty = false;
      }
    } catch (e) {
      this.saveFailed(rec, e);
      throw e;
    }
    this.saveRecovered(rec);
    rec.uncommitted = false;
    if (!committed) return null;
    rec.contributors.clear();
    rec.localEdits = false;
    rec.baseCommit = committed;
    rec.lastCommit = committed;
    rec.lastCommitAt = new Date().toISOString();
    this.broadcast(rec, { type: 'committed', at: rec.lastCommitAt, commit: committed, message: text });
    await this.saveCache(rec);
    return committed;
  }

  /**
   * A write or commit did not go through (another program has git's index
   * locked, a file cannot be written): the edits stay in the room, it is tried
   * again after a wait that grows, and people are told.
   */
  private saveFailed(rec: RoomRecord, e: unknown): void {
    rec.failures++;
    const wait = Math.min(1000 * 2 ** (rec.failures - 1), 60_000);
    const msg = e instanceof Error ? e.message : String(e);
    this.log(`saving ${rec.path} failed (${msg.split('\n')[0]}); trying again in ${Math.round(wait / 1000)}s`);
    if (this.closed) return;
    if (rec.timers.retry) clearTimeout(rec.timers.retry);
    rec.timers.retry = setTimeout(() => void this.commitRoom(rec).catch(() => undefined), wait);
    const why = /index\.lock|\.lock'?: File exists/i.test(msg) ? 'another program is using git in this folder'
      : e instanceof HttpError ? msg
        : /EACCES|EPERM|EBUSY|EROFS|ENOSPC/.test(msg) ? 'the file could not be written'
          : 'something went wrong';
    const file = rec.path.slice(rec.path.lastIndexOf('/') + 1);
    this.broadcast(rec, { type: 'save-status', at: new Date().toISOString(), state: 'failing', message: `Could not save ${file} just now (${why}). Your edits are kept, and saving is tried again.` });
  }

  private saveRecovered(rec: RoomRecord): void {
    if (!rec.failures) return;
    rec.failures = 0;
    this.broadcast(rec, { type: 'save-status', at: new Date().toISOString(), state: 'ok', message: 'Saving again: everything is saved.' });
  }

  /** Stage and commit the given paths. Returns the commit, or null if nothing changed. */
  async commitPaths(paths: string[], message: string, coAuthors: PresenceUser[] = [], extra: string[] = []): Promise<string | null> {
    // Never in the middle of a git operation, or with no branch checked out.
    await this.requireWritable();
    // A path neither here nor in git (a merge took it away while its room was open) has nothing to commit, and git would refuse it.
    const known = new Set((await this.git.out(['ls-files', '-z', '--', ...paths])).split('\0').filter(Boolean));
    paths = paths.filter((p) => known.has(p) || existsSync(this.resolvePath(p, { link: 'self' })));
    if (!paths.length) return null;
    await this.git.run(['add', '-A', '--', ...paths]);
    const diff = await this.git.run(['diff', '--cached', '--quiet', '--', ...paths], { allowFail: true });
    if (diff.code === 0) return null;
    const full = withTrailers(message, coAuthors, extra);
    // Syncing with other devices: signed, so they can tell whose it is (signing.ts).
    // Signed with this host's person's key if it keeps one, else its device's (0034).
    if (this.peers) await commitSigned(this.git, paths, full, await this.peers.node.signingKey(), this.tmpDir);
    else await this.git.run(['commit', '-q', '-F', '-', '--', ...paths], { input: full });
    const head = await this.git.head();
    this.log(`committed ${head?.slice(0, 7)} ${message}`);
    this.refsChanged();
    return head;
  }

  /**
   * Commit a file's text onto a branch that is not checked out, by its ref alone:
   * the branch's tree with this file changed, a commit on top (signed, when
   * syncing with devices), and the ref moved only if it is still where it was.
   * The working tree and the checked-out branch are not touched.
   */
  private async commitToBranch(branch: string, path: string, text: string, message: string): Promise<string | null> {
    const ref = `refs/heads/${branch}`;
    const tip = (await this.git.run(['rev-parse', '--verify', '-q', `${ref}^{commit}`], { allowFail: true })).stdout.trim();
    if (!tip) throw new Error(`The branch ${branch} is gone: the edits to ${path} are kept in its room`);
    const before = await this.git.run(['ls-tree', '-z', tip, '--', path], { allowFail: true });
    const m = /^(\d+) blob ([0-9a-f]+)\t/.exec(before.stdout);
    const blob = await this.git.out(['hash-object', '-w', '--stdin'], { input: text });
    if (m && m[2] === blob) return null;
    await mkdir(this.tmpDir, { recursive: true });
    const env = { GIT_INDEX_FILE: join(this.tmpDir, `branch-index-${process.pid}-${randomBytes(4).toString('hex')}`) };
    let tree: string;
    try {
      await this.git.run(['read-tree', tip], { env });
      await this.git.run(['update-index', '-z', '--index-info'], { env, input: `${m?.[1] ?? '100644'} ${blob} 0\t${path}\0` });
      tree = await this.git.out(['write-tree'], { env });
    } finally {
      await rm(env.GIT_INDEX_FILE, { force: true });
    }
    let commit = await this.git.out(['commit-tree', tree, '-p', tip, '-F', '-'], { input: `${message.trimEnd()}\n` });
    if (this.peers) {
      const raw = (await this.git.run(['cat-file', 'commit', commit])).bytes;
      commit = await this.git.out(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: signCommitObject(raw, await this.peers.node.signingKey()) });
    }
    await this.git.run(['update-ref', '-m', `commit: ${message.split('\n')[0]}`, ref, commit, tip]);
    this.log(`committed ${commit.slice(0, 7)} onto ${branch} (not checked out): ${message.split('\n')[0]}`);
    this.refsChanged();
    return commit;
  }

  onRefsChanged(fn: () => void): () => void {
    this.refsListeners.add(fn);
    return () => this.refsListeners.delete(fn);
  }

  refsChanged(): void {
    for (const fn of this.refsListeners) fn();
  }

  /** Flush and commit every open room: each of them, even if one fails (the first failure is thrown after). */
  async commitAll(message?: string): Promise<void> {
    let failed: unknown = null;
    for (const rec of [...this.records.values()]) {
      try {
        await this.flushNow(rec);
        await this.commitNow(rec, message);
      } catch (e) {
        failed ??= e;
      }
    }
    if (failed) throw failed;
  }

  // -------------------------------------------------------------------------
  // Git, as others use it in this folder: branches switched, operations under way

  /** Where git is, from its files (cheap enough to read before every write). */
  async readGitState(): Promise<GitState> {
    let head = '';
    try {
      head = (await readFile(join(this.gitDirPath, 'HEAD'), 'utf8')).trim();
    } catch {
      // No HEAD to read: as if detached, so nothing is written.
    }
    const m = /^ref: refs\/heads\/(.+)$/.exec(head);
    const operation = OPERATIONS.find((f) => existsSync(join(this.gitDirPath, f))) ?? null;
    return { branch: m ? m[1]! : null, operation };
  }

  /** Throw (409, said plainly) if git is in the middle of an operation here, or no branch is checked out. */
  async requireWritable(): Promise<void> {
    const paused = pausedBecause(await this.readGitState());
    if (paused) throw new HttpError(409, paused);
  }

  /** Look at where git is, and follow it (followGit). One look at a time; asked again meanwhile, the queued one serves. */
  checkGit(): Promise<void> {
    this.gitCheck ??= this.serial(() => this.followGit())
      .catch((e) => this.log(`following git failed: ${e}`))
      .finally(() => {
        this.gitCheck = null;
      });
    return this.gitCheck;
  }

  /**
   * Follow git as someone else moved it. In the middle of an operation, or with
   * no branch checked out, pause: edits wait in their rooms, and people are told.
   * When it is done, resume: bring in what it changed, and write what waited.
   * When the branch changed, the old branch's rooms are committed onto it by its
   * ref, and people move to the new branch's version of their file.
   * Call inside serial().
   */
  private async followGit(): Promise<void> {
    if (this.closed) return;
    const was = this.gitState;
    const st = await this.readGitState();
    this.gitState = st;
    const paused = pausedBecause(st);
    const at = new Date().toISOString();
    if (paused) {
      if (paused !== pausedBecause(was)) {
        this.log(st.operation ? `git is in the middle of an operation (${st.operation}): saving paused` : 'no branch checked out: saving paused');
        for (const rec of this.records.values()) this.broadcast(rec, { type: 'save-status', at, state: 'paused', message: paused });
      }
      return;
    }
    const resumed = !!pausedBecause(was);
    if (resumed) {
      this.log('saving again');
      for (const rec of this.records.values()) this.broadcast(rec, { type: 'save-status', at, state: 'ok', message: 'Saving again.' });
    }
    const from = this.onBranch;
    this.onBranch = st.branch;
    if (from && from !== st.branch) await this.branchMoved(from, st.branch!);
    else if (resumed) {
      // The operation may have changed files: bring that into the rooms, then write and commit what waited.
      const head = await this.git.head();
      for (const rec of [...this.records.values()]) {
        if (rec.branch !== st.branch) continue;
        rec.baseCommit = head;
        try {
          await this.checkOutside(rec);
          await this.flushNow(rec);
          if (rec.uncommitted) this.commitSoon(rec.room);
        } catch (e) {
          this.log(`could not bring ${rec.path} up to date: ${e}`);
        }
      }
      for (const rec of this.records.values()) this.broadcast(rec, { type: 'files-changed', at });
    }
  }

  /**
   * The branch checked out changed, outside the app. Rooms are per branch: the
   * old branch's edits are committed onto it (by its ref: the working tree now
   * holds the other branch), and whoever has a file open moves to the new
   * branch's room for it. Call inside serial().
   */
  private async branchMoved(from: string, to: string): Promise<void> {
    this.log(`the branch checked out changed from ${from} to ${to}`);
    const at = new Date().toISOString();
    for (const rec of [...this.records.values()]) {
      if (rec.branch === to) {
        // Back on a branch whose rooms are still here: the files may have moved on meanwhile.
        await this.checkOutside(rec).catch((e) => this.log(`could not bring ${rec.path} up to date: ${e}`));
        continue;
      }
      if (rec.dirty || rec.uncommitted) await this.commitNow(rec).catch(() => undefined); // failures are retried, and said
      if (!this.relay.isOpen(rec.room)) continue;
      let next: RoomRecord | null = null;
      try {
        next = await this.ensureRecord(rec.path);
      } catch {
        // Not on the new branch (or not openable there): the room stays, its edits on its own branch.
      }
      if (next) this.relay.broadcast(rec.room, { type: 'reseeded', at, room: next.room, why: `This folder was switched to the branch ${to}: showing its version of the file. Edits made on ${from} are saved there.` });
      else this.broadcast(rec, { type: 'save-status', at, state: 'paused', message: `This folder was switched to the branch ${to}, which does not have this file. Your edits are saved on ${from}.` });
    }
    for (const rec of this.records.values()) this.broadcast(rec, { type: 'files-changed', at });
  }

  // -------------------------------------------------------------------------
  // Outside changes

  private startWatcher(): void {
    try {
      this.watcher = watch(this.dir, { recursive: true }, (_event, filename) => {
        if (!filename) return;
        const rel = String(filename).split(sep).join('/');
        // A branch switched, or an operation begun or ended, outside the app: follow it (and the poll does, if this is missed).
        const gitFile = /^\.git\/(HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REVERT_HEAD|BISECT_LOG|rebase-merge|rebase-apply)$/.test(rel);
        if (!gitFile && (rel.startsWith('.git/') || rel === '.git' || rel.includes('.kuraa-tmp-'))) return;
        const prev = this.watchTimers.get(rel);
        if (prev) clearTimeout(prev);
        this.watchTimers.set(rel, setTimeout(() => {
          this.watchTimers.delete(rel);
          (gitFile ? this.checkGit() : this.checkPath(rel)).catch((e) => this.log(`checking ${rel} failed: ${e}`));
        }, 50));
      });
    } catch (err) {
      this.log(`file watching unavailable: ${err}`);
    }
  }

  async checkPath(path: string): Promise<void> {
    // Most changes are to files no one has open (a build, an install): don't ask git which branch this is for those.
    if (![...this.records.values()].some((r) => r.path === path)) return;
    const branch = await this.git.branch();
    const rec = this.records.get(`${branch}:${path}`);
    if (!rec) return;
    await this.serial(() => this.checkOutside(rec));
  }

  /** Re-check every open room against its file, e.g. after a git operation: each of them, even if one fails. */
  async checkAll(): Promise<void> {
    for (const rec of [...this.records.values()]) {
      await this.checkOutside(rec).catch((e) => this.log(`could not check ${rec.path} against its file: ${(e as Error).message}`));
    }
  }

  /**
   * Take a change made to a room's file outside the app into the room. Only for
   * rooms of the branch checked out, and not while git is in the middle of an
   * operation (its half-done files are taken once it is done). A file become a
   * link, or not text, is not read: the room's next write keeps it beside.
   */
  private async checkOutside(rec: RoomRecord): Promise<void> {
    const st = await this.readGitState();
    if (pausedBecause(st) || st.branch !== rec.branch) return;
    const abs = this.resolvePath(rec.path);
    if (!existsSync(abs)) return;
    const bytes = await readNoFollow(abs);
    if (!isUtf8(bytes)) {
      rec.dirty = true;
      return this.flushNow(rec);
    }
    const text = bytes.toString('utf8');
    if (hashText(text) === rec.lastHash) return;
    await this.applyOutside(rec, text);
  }

  /** Keep a version of a room's file made outside the app beside it (name.outside-<time>), and say so. */
  private async saveBeside(rec: RoomRecord, content: string | Buffer): Promise<string> {
    const at = new Date().toISOString();
    const savedAs = `${rec.path}.outside-${at.replace(/[:.]/g, '-')}`;
    await this.writeAtomic(this.resolvePath(savedAs), content);
    this.broadcast(rec, { type: 'conflict', at, savedAs });
    this.log(`outside change to ${rec.path} kept beside it as ${savedAs}`);
    return savedAs;
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
      await this.saveBeside(rec, text);
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
  merge(x: string, y: string, override?: (path: string) => string | undefined, keep?: (path: string) => boolean): Promise<MergeOutcome> {
    return mergeCommits(this.git, x, y, { typeFor: (path, head) => this.mergeTypes.resolve(path, head), override, keep, tmpDir: this.tmpDir });
  }

  /**
   * Bring a commit into the current branch: a fast-forward, or a merge made as
   * every device makes it. Open rooms are committed first, and take the result
   * as an outside change. Call inside serial().
   */
  async integrate(ref: string, override?: (path: string) => string | undefined, keep?: (path: string) => boolean): Promise<MergeOutcome> {
    // Not into the middle of someone's rebase or merge: it comes in once that is done.
    await this.requireWritable();
    await this.commitAll();
    const theirs = await this.git.out(['rev-parse', '--verify', `${ref}^{commit}`]);
    const head = await this.git.head();
    const outcome = head ? await this.merge(head, theirs, override, keep) : { commit: theirs, kind: 'fast-forward' as const, conflicts: [], copies: [] };
    if (outcome.commit !== head) {
      // Rooms another device commits (shared rooms, peers/rooms.ts) are left to it:
      // only the device that commits a shared room brings changes from git into
      // it, and the others get them through the room, so no change is made twice
      // there. Here, such a room's file is put back as committed for the move, and
      // the room written out again after it. A room with uncommitted edits is
      // handled the same way, its edits being in the room.
      // A room shared with the device whose work this is, too: it holds both sides' edits already, and the
      // merge took its text, so git brings nothing into it (or it would get the other side's edits twice).
      const branch = await this.git.branch();
      const held = [...this.records.values()].filter((r) => r.branch === branch && (r.uncommitted || (this.peers && !this.peers.rooms.commits(r.room)) || override?.(r.path) !== undefined));
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
        const now = existsSync(this.resolvePath(rec.path)) ? await this.readText(this.resolvePath(rec.path), rec.path) : '';
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

  /** The room someone has open here with this key among devices, if any. */
  liveRoom(key: string): RoomView | undefined {
    for (const r of this.records.values()) if (this.roomKey(r) === key && this.relay.isOpen(r.room)) return this.roomView(r.room);
    return undefined;
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

  /** Whether someone on this device (not another device) has edited the room since its last commit. */
  localEditsIn(name: string): boolean {
    return this.byRoom.get(name)?.localEdits ?? false;
  }

  /**
   * Put a file as given (null: delete it), into its open room as an outside
   * change, and commit it. For taking another device's version of a file
   * (peers.ts). Call inside serial().
   */
  async replaceFile(path: string, content: string | null, message: string): Promise<string | null> {
    const abs = this.resolvePath(path);
    if (content === null) await rm(abs, { force: true });
    else {
      await mkdir(dirname(abs), { recursive: true });
      await this.writeAtomic(abs, content);
    }
    const branch = await this.git.branch();
    const rec = this.records.get(`${branch}:${path}`);
    if (rec) await this.checkOutside(rec);
    return this.commitPaths([path], message);
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
      // The base is the file where the two rooms' histories meet: at the merge base of the
      // commits each started from; failing that, the blob this room started from.
      const show = async (rev: string) => {
        const r = await this.git.run(['show', `${rev}:${rec.path}`], { allowFail: true });
        return r.code === 0 ? r.stdout : null;
      };
      const meet = rec.baseCommit && theirBase ? await this.git.run(['merge-base', rec.baseCommit, theirBase], { allowFail: true }) : null;
      const blob = await this.git.run(['cat-file', 'blob', rec.generation], { allowFail: true });
      const atMeet = meet?.code === 0 ? ((await show(meet.stdout.trim())) ?? '') : null;
      const atHead = await show('HEAD');
      // Read after the waits above: edits people made meanwhile are in it (nothing waits from here to the switch).
      const ours = rec.type.serialize(this.current(rec), rec.previous);
      const theirs = rec.type.serialize(decodeDoc(state, rec.type.schema), rec.previous);
      const base = atMeet ?? (blob.code === 0 ? blob.stdout : null) ?? atHead ?? ours;
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

  /**
   * The sync remote: the ordinary git remote (GitHub, say) Sync fetches from,
   * merges and pushes to, two ways, like any clone of it. The
   * workspace's choice (`kuraa.syncremote`), else origin, else the only one.
   */
  async syncRemoteName(): Promise<string | null> {
    const urls = await this.git.run(['config', '--get-regexp', '^remote\\..*\\.url$'], { allowFail: true });
    // Not devices (they sync with each other), and not backups (they only receive).
    const backups = await this.backups.names();
    const remotes = urls.stdout.split('\n').map((l) => /^remote\.(.+)\.url (.*)$/.exec(l.trim())).filter((m) => m && !m[2]!.startsWith('kuraa://')).map((m) => m![1]!).filter((r) => !backups.includes(r));
    const chosen = (await this.git.run(['config', '--get', 'kuraa.syncremote'], { allowFail: true })).stdout.trim();
    if (chosen && remotes.includes(chosen)) return chosen;
    if (chosen && this.peers) return null;
    return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
  }

  /**
   * Fetch from an ordinary remote, bring its branch in (never stopping on a
   * conflict), and push. Call outside serial(): it takes its turn for the parts
   * that change branches and files, and talks to the remote outside it, so a
   * slow or silent server holds up no saving. Never asks for credentials, and
   * gives up after a while.
   */
  async syncWith(remote: string): Promise<{ ok: boolean; message: string; head?: string | null }> {
    const branch = await this.serial(async () => {
      await this.requireWritable();
      await this.commitAll();
      return (await this.readGitState()).branch!;
    });
    const fetched = await this.git.run(['fetch', remote], { allowFail: true, timeoutMs: FETCH_MS, env: NON_INTERACTIVE });
    if (fetched.code !== 0) throw new Error(`Could not fetch from ${remote}: ${(fetched.stderr || fetched.stdout).trim() || 'it took too long'}`);
    const { kept, head } = await this.serial(async () => {
      if ((await this.readGitState()).branch !== branch) throw new HttpError(409, `The branch changed while syncing (now not ${branch}): sync again`);
      const hasRemoteBranch = (await this.git.run(['rev-parse', '--verify', '-q', `${remote}/${branch}`], { allowFail: true })).code === 0;
      // Never stops on a conflict: both versions stay in the document, to choose between there.
      const outcome = hasRemoteBranch ? await this.integrate(`${remote}/${branch}`) : null;
      return { kept: outcome ? describeOutcome(outcome) : '', head: await this.git.head() };
    });
    if (head) {
      const pushed = await this.git.run(['push', remote, `${head}:refs/heads/${branch}`], { allowFail: true, timeoutMs: PUSH_MS, env: NON_INTERACTIVE });
      if (pushed.code !== 0) throw new Error(`Could not push to ${remote}: ${(pushed.stderr || pushed.stdout).trim() || 'it took too long'}`);
    }
    return { ok: true, message: `Synced with ${remote}/${branch}${kept}`, head };
  }

  /** Sync: with the paired devices that are connected, and with the sync remote if there is one. */
  async syncNow(): Promise<{ ok: boolean; message: string; head?: string | null }> {
    const remote = await this.syncRemoteName();
    const said: string[] = [];
    if (this.peers) said.push(await this.peers.syncAll());
    if (remote) {
      const r = await this.syncWith(remote);
      if (!this.peers) return r;
      said.push(r.message);
    }
    if (!said.length) return { ok: false, message: 'There is no sync remote, and no device to sync with' };
    return { ok: true, message: said.join('. '), head: await this.git.head() };
  }

  // -------------------------------------------------------------------------
  // The file list

  /**
   * A file as the file list shows it: its type; for a document, its title (null
   * if it has none); and how many conflicts it keeps, if any. From its open room
   * if it has one (the live text), else from the file, read again only when it
   * has changed. Null if the file is gone.
   */
  async treeEntry(path: string, branch: string): Promise<TreeEntry | null> {
    const abs = join(this.dir, path);
    let s;
    try {
      s = await lstat(abs);
    } catch {
      return null;
    }
    // A link (git keeps them as they are) is listed, never opened or read.
    if (s.isSymbolicLink()) return { path, type: null, cannotOpen: 'A link to somewhere else: the app does not open links' };
    const type = this.typeFor(path);
    const entry: TreeEntry = { path, type: type?.id ?? null };
    if (!type) return entry;
    const facts = (text: string) => ({ title: type.title?.read(text) ?? null, conflicts: conflictsIn(text, type), cannotOpen: null as string | null });
    let found: { title: string | null; conflicts: number; cannotOpen: string | null };
    const rec = this.records.get(`${branch}:${path}`);
    if (rec) found = facts(type.serialize(this.current(rec), rec.previous));
    else {
      const stamp = `${s.mtimeMs}:${s.size}:${type.id}`;
      const hit = this.factsCache.get(path);
      if (hit?.stamp === stamp) found = hit;
      else {
        let bytes: Buffer;
        try {
          bytes = await readFile(abs);
        } catch {
          // Not read this time (gone meanwhile, or held by another program): shown plainly, and read again next time.
          return entry;
        }
        found = isUtf8(bytes) ? facts(bytes.toString('utf8')) : { title: null, conflicts: 0, cannotOpen: 'Not saved as UTF-8 text: the app cannot edit it without changing its characters' };
        this.factsCache.set(path, { stamp, ...found });
      }
    }
    if (found.cannotOpen) return { path, type: null, cannotOpen: found.cannotOpen };
    if (type.title) entry.title = found.title;
    if (found.conflicts) entry.conflicts = found.conflicts;
    return entry;
  }

  /** The file list's entries for these paths, a few files read at a time (TREE_READS). */
  async treeEntries(paths: string[], branch: string): Promise<TreeEntry[]> {
    const out: (TreeEntry | null)[] = new Array(paths.length).fill(null);
    let next = 0;
    const worker = async () => {
      while (next < paths.length) {
        const i = next++;
        out[i] = await this.treeEntry(paths[i]!, branch);
      }
    };
    await Promise.all(Array.from({ length: Math.min(TREE_READS, paths.length) }, worker));
    return out.filter((e) => e !== null);
  }

  // -------------------------------------------------------------------------
  // Titles

  /**
   * Check that a document can take this title: it has titles, the title is not
   * empty, and its header can be edited. Throws an HttpError (400) if not.
   */
  async checkTitle(path: string, title: string): Promise<void> {
    const type = this.typeFor(path);
    if (!type?.title) throw new HttpError(400, `${path} is not a document with a title`);
    try {
      type.title.write(await this.readText(this.resolvePath(path), path), title);
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
    const text = await this.readText(abs, path);
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

/** A file's bytes, refusing a symbolic link as its last part (where the system can tell). */
async function readNoFollow(abs: string): Promise<Buffer> {
  const fh = await open(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/** A commit message with its trailers: co-authors (those with an email), then any others, each once. */
function withTrailers(message: string, coAuthors: PresenceUser[], extra: string[]): string {
  const trailers = coAuthors
    .filter((u) => u.email)
    .map((u) => `Co-authored-by: ${u.name.replace(/[<>\n]/g, '')} <${u.email.replace(/[<>\n\s]/g, '')}>`);
  const unique = [...new Set([...trailers, ...extra])];
  return unique.length ? `${message}\n\n${unique.join('\n')}` : message;
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

/** A file as the file list shows it (see Host.treeEntry). */
export interface TreeEntry {
  path: string;
  /** Its document type, or null if no type opens it. */
  type: string | null;
  /** Documents only: its title, or null if it has none. */
  title?: string | null;
  /** Why the app does not open it, when it is a file a type would open (a link, a file not in UTF-8). Its type is then null. */
  cannotOpen?: string;
  /** How many conflicts it keeps, when it keeps any. */
  conflicts?: number;
}
