// The host: relay, bridge, committer and git peer for one workspace.
import { isUtf8 } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants as fsConstants, existsSync, lstatSync, openSync, readSync, realpathSync, watch, type FSWatcher } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type { AddressInfo } from 'node:net';
import { markdownWords, TypeRegistry, type DocumentType, type ParsedDocument } from '@kuraa/kernel';
import { standardTypes } from '@kuraa/formats';
import { Relay, decodeDoc, encodeDoc, featuresOfState, vectorOf, type ChunkRef, type FeatureView, type PresenceUser, type RoomMessage, type RoomSeed, type RunRecord } from '@kuraa/session/server';
import { COMPANIONS_FILE, FEATURES_FILE, type HostFeature } from '@kuraa/feature-kit/host';
import { HostFeatures } from './features.js';
import { Git, NON_INTERACTIVE } from './git.js';
import { HttpError } from './errors.js';
import { renameOver } from './files.js';
import { commitSigned, signCommitObject } from './signing.js';
import { serialQueue } from './serial.js';
import { NAME_FILE, cleanName, initWorkspace, readWorkspaceName, writeWorkspaceName } from './workspace.js';
import { Runner, type RunOptions } from './runner.js';
import { Renders } from './renders.js';
import { loadRunComponents } from './components.js';
import { createRequestHandler, sameToken } from './http.js';
import { gateFor, upgradeAllowed, type RequestGate } from './origins.js';
import { conflictsIn, isAncestor, mergeCommits, mergeSignature, type MergeOutcome } from './merging.js';
import { AUTOSAVE_TRAILER, describeEdit } from './messages.js';
import type { Peers, PeerOptions } from './peers/peers.js';
import { POLICY_TRAILER, REFUSED_TRAILER, trailers, type GateResult } from './peers/gate.js';
import { Spaces, spaceRef } from './spaces.js';
import { madeFrom, missingFrom, putTogether, zipOf, type MadeFrom } from './madefrom.js';
import { bookItems, joinBook, type BookPart } from './compile.js';
import { readOrders } from './order.js';
import { withHeaderFields } from './header.js';
import { WordLog, type DayWords, type Uncommitted } from './wordlog.js';
import type { Sync, SyncSession } from '@kuraa/run-kit';

/** How long stopping waits for the last saves to reach the online copies (the rest go at the next start). */
const FINAL_PUSH_MS = 8_000;

export interface HostTimings {
  /** Serialize this long after the last update. */
  flushMs: number;
  /** Commit after this long without updates. */
  idleCommitMs: number;
  /** Commit at least this often during continuous editing. */
  maxCommitMs: number;
  /** Keep a room no one is in here open (still in its session) this long, then leave it. */
  dropMs: number;
  /**
   * A device gone from a session without leaving it (the network): how long the
   * others wait for it to come back before going on without it, in a session of
   * their own (0077).
   */
  rejoinMs: number;
  /** Push to the online copies this long after the last commit (the syncs' delayMs). */
  onlineMs: number;
  /** Fetch from the online copies, merge and push, this often. */
  onlineSyncMs: number;
  /** Look this often at where git is (a branch switched, an operation under way outside the app) while rooms are open. */
  gitPollMs: number;
}

export interface HostOptions {
  dir: string;
  /** What the workspace is called to people where it names itself nowhere (default: its folder's name). Its own name wins (0061). */
  label?: string;
  /** The workspace's own name (0061) is now this: read at start, and again when a rename is made here or comes from another device. */
  onName?: (name: string) => void;
  token: string;
  host?: string;
  port?: number;
  /**
   * Who may talk to it from a web page (origins.ts). Default: what listening at
   * `host` allows, with no other origins; a hub gives its own, as requests to its
   * workspaces come through it.
   */
  requests?: RequestGate;
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
  /**
   * Features (0082): their host halves, passed by whoever starts the host (the
   * standard list is @kuraa/features). None by default: the host imports none.
   */
  features?: HostFeature[];
  /** Which of them are on here, by id (--feature, Settings › Host). Default: all. Each workspace turns them on for itself too. */
  featuresOn?: string[];
  /** If the folder is not a git repository, make it one (committing what is in it) instead of failing. */
  init?: boolean;
  /**
   * Be one of the workspace's devices: sync git and live rooms with
   * the devices paired with this repository (docs/decisions/0028-peers.md).
   * The first device to do so makes the repository a shared workspace.
   */
  peers?: PeerOptions | boolean;
  /**
   * Let people using the app make invitations and subscription links for this
   * workspace (a hub always does, for its workspaces: every member has the same
   * say, 0038). Making one starts syncing with devices if it is not on, with
   * these options.
   */
  invites?: { peers?: PeerOptions };
  /**
   * People using the app may see, make and import this computer's person's key
   * (person.ts), whose this host's commits are (0034). A hub turns it on while it
   * listens only on this computer (0047): on a server open to the network, its
   * key is its owner's.
   */
  managePerson?: boolean;
  /**
   * People using the app may add and remove online copies (syncs, from
   * components such as @kuraa/sync-git): git servers synced with this computer's credentials. A hub turns it on while it
   * listens only on this computer (0047). Everyone sees them, and Sync syncs with them.
   */
  manageOnline?: boolean;
  /** Your identity changed through this host's API: tell every workspace that syncs (the hub's), not just this one. */
  personChanged?: () => Promise<void>;
  /** The signing keys the workspaces know to be this identity's (a hub: all of its workspaces'); else this workspace's. */
  knownKeys?: (id: string) => Promise<string[]>;
  timings?: Partial<HostTimings>;
  log?: (msg: string) => void;
}

/** How many files the file list reads at once. */
const TREE_READS = 16;

/** Rooms kept warm with nobody in them, at most (Host.scheduleDrop). */
const MAX_IDLE_ROOMS = 24;

/** How long a device that is to lead a room's session waits for the last commit of the one before (Host.takeOver). */
const LEAD_WAIT_MS = 10_000;

export const DEFAULT_TIMINGS: HostTimings = { flushMs: 2000, idleCommitMs: 30_000, maxCommitMs: 300_000, dropMs: 15 * 60_000, rejoinMs: 5000, onlineMs: 30_000, onlineSyncMs: 5 * 60_000, gitPollMs: 1000 };

interface RoomRecord {
  key: string;
  path: string;
  branch: string;
  type: DocumentType;
  /** Its name in the relay: a new one for each session it is in (0077), so nothing of one is ever opened in another. */
  room: string;
  /** What makes the name new: random, for each session. */
  generation: string;
  /**
   * The session the room is in (0077): one Yjs document, started on one device
   * from its file and joined by others, never kept or used again once it ends.
   * Null: in none yet (asked for, and not opened).
   */
  session: string | null;
  /**
   * Whether this device leads the session: writes its text to the file, commits
   * it, and brings changes from git into it. Always so of a room in no session.
   */
  leading: boolean;
  /** The newest commit whose text the room holds (where it started, its last commit, or a merge brought in): commits are made on it. */
  baseCommit: string | null;
  /** Commits the room has said it holds, newest last (baseCommit among them): a new leader builds on the newest it has. */
  bases: string[];
  /** The room's state vector when its text was last known to be the file's. */
  flushedSv: Uint8Array | null;
  /** The file text as last written or seen, parsed. */
  previous: ParsedDocument;
  /** The git blob id of the file's text as last written or seen (blobId): a change on the disk is any other. */
  lastHash: string;
  /**
   * A session's state to open (another device's, joined or moved to); in no
   * session, edits not yet written (their text: a new session starts from it, afresh).
   */
  state: Uint8Array | null;
  /** Client edits not yet serialized to the file. */
  dirty: boolean;
  /** Flushed but not committed. */
  uncommitted: boolean;
  /**
   * The hash of the file's text (as `lastHash`) when it was known to be the
   * branch's committed version: committing then has nothing to do. Null: not known.
   */
  committedHash: string | null;
  contributors: Map<string, PresenceUser>;
  editingSince: number | null;
  lastFlushAt: string | null;
  lastCommitAt: string | null;
  lastCommit: string | null;
  needsOutsideCheck: boolean;
  /** Writes or commits that failed in a row; retried with a growing wait. */
  failures: number;
  /** When it was last asked for (Date.now()): the idle rooms used longest ago are closed first. */
  usedAt: number;
  /** Being let go of: no longer kept open by the relay with no one in it. */
  releasing: boolean;
  /** Since when this device waits to lead it (takeOver): for the commit the room holds to come. */
  waitingSince: number | null;
  /** Companions written or removed from the room's state since its last commit (0082): committed with it. */
  companions: Set<string>;
  /** Companions' text kept with edits not written when the host last stopped: the room's features start from these. */
  keptCompanions: Record<string, string | null> | null;
  /** A new document with no file yet (0097): its file made when there is first something in it. */
  draft?: boolean;
  /** Its file just made, in a folder fewer read: committed into that space, not the workspace's own branch (0069). */
  madeInSpace?: string | null;
  /** What this host's person did in the room's session (features.ts, Mine): their file is written with this alone. */
  mine: import('./features.js').Mine;
  timers: { flush?: NodeJS.Timeout; commit?: NodeJS.Timeout; max?: NodeJS.Timeout; drop?: NodeJS.Timeout; retry?: NodeJS.Timeout; lead?: NodeJS.Timeout; own?: NodeJS.Timeout };
}

/** What a new room starts from, read apart from the queue (Host.prepareRecord). */
interface PreparedRecord extends Pick<RoomRecord, 'key' | 'path' | 'branch' | 'type' | 'previous' | 'state' | 'baseCommit' | 'lastHash' | 'dirty' | 'needsOutsideCheck' | 'keptCompanions' | 'draft'> {
  /** The file's text as read. */
  text: string;
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

/**
 * Edits not yet written to a file when the host stopped (saving paused, or
 * failing): their text, kept in the rooms folder beside git's, and the file's
 * as last seen. Never a room's state: a session is not used again once it ends (0077).
 */
interface Unsaved {
  key: string;
  path: string;
  branch: string;
  typeId: string;
  typeVersion: number;
  lastHash: string;
  /** The file's text as last seen. */
  text: string;
  /** The edits' text. */
  pending: string;
  baseCommit: string | null;
  /** What features kept beside it, as their companions' text then (0082). */
  companions?: Record<string, string | null>;
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
  /** The spaces this device holds: files read only by an audience (spaces.ts, 0066); set at start. */
  spaces!: Spaces;
  readonly dir: string;
  readonly token: string;
  /** Who may talk to it from a web page (origins.ts). */
  readonly requests: RequestGate;
  readonly timings: HostTimings;
  /**
   * Places this workspace keeps a copy on and syncs with, by id: the syncs the
   * run components bring (the online copy, @kuraa/sync-git, decision 0059),
   * opened for this workspace at start. None without such a component.
   */
  readonly syncs = new Map<string, { sync: Sync; session: SyncSession }>();
  /** Features (0082): loaded, on or off, for this workspace; their companions, rooms' state, events and routes (features.ts). */
  readonly features: HostFeatures;
  readonly workspace: string;
  private readonly records = new Map<string, RoomRecord>();
  private readonly byRoom = new Map<string, RoomRecord>();
  /** Rooms being opened apart from the queue, by path: two asking at once share one. */
  private readonly opening = new Map<string, Promise<RoomRecord>>();
  private relay!: Relay;
  runner!: Runner;
  /** Documents rendered to HTML, Word and PDF (renders.ts). */
  renders!: Renders;
  /** Words written by day and person, from the history (wordlog.ts, 0094). */
  private wordLog: WordLog | null = null;
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
    this.requests = options.requests ?? gateFor(options.host ?? '127.0.0.1');
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
    this.features = new HostFeatures(this.featurePort(), options.features, options.featuresOn);
    // Features' file types (their companions, say): always on, and merged by, whether or not the feature is on (0082).
    const featureTypes = this.features.types();
    for (const t of featureTypes) this.registry.register(t);
    for (const t of [...this.allTypes, ...featureTypes]) this.mergeTypes.register(t);
    this.mergeSignature = mergeSignature([...this.allTypes, ...featureTypes]);
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
    // Where it may make one (a workspace of a hub's), the folder must be a repository's top, not only inside
    // one: a workspace in a checkout of Kuraa (pnpm dev's, in a git worktree) is never the checkout itself.
    if (!(await (this.options.init ? this.git.isRepoTop() : this.git.isRepo()))) {
      if (!this.options.init) throw new Error(`Not a git repository: ${this.dir}`);
      await initWorkspace(this.dir, this.options.label ?? this.workspace);
      this.log(`initialised a git repository in ${this.dir}`);
    }
    await this.refreshName();
    this.gitDirPath = await this.git.gitDir();
    this.realDir = realpathSync(this.dir);
    this.cacheDir = join(this.gitDirPath, 'kuraa', 'rooms');
    // Before anything here writes: a feature starting (the codebook moved into .kuraa, 0082) writes through a
    // temporary file of the same kind, which this would take away half-way.
    await this.removeLeftovers();
    this.gitState = await this.readGitState();
    this.onBranch = this.gitState.branch;
    this.spaces = new Spaces(this.git, this.dir, this.tmpDir);
    await this.spaces.refresh(this.onBranch);
    await this.features.refresh();
    const run = this.options.run;
    const components = await loadRunComponents(run?.components);
    // Online copies take what was committed, a while after; and, at start, whatever was committed while the host was away.
    for (const sync of components.syncs.values()) {
      const session = sync.open({
        git: this.git,
        nonInteractive: NON_INTERACTIVE,
        delayMs: this.timings.onlineMs,
        everyMs: this.timings.onlineSyncMs,
        log: (m) => this.log(m),
        serial: (fn) => this.serial(fn),
        bringIn: (name) => this.bringInFrom(name),
      });
      this.syncs.set(sync.id, { sync, session });
      this.onRefsChanged(() => session.changed());
      session.changed();
      session.start();
    }
    this.runner = new Runner({
      root: this.dir,
      stateDir: join(await this.git.gitDir(), 'kuraa'),
      components,
      options: run,
      broadcast: (path, message) => this.broadcastPath(path, message),
      broadcastAll: (message) => {
        for (const rec of this.records.values()) this.broadcast(rec, message);
      },
      commit: async (paths, message, by) => {
        await this.serial(() => this.commitPaths(paths, message, by && by.email ? [by] : []));
      },
      log: (m) => this.log(m),
      hidden: (path) => this.hiddenFrom(path),
      madeFrom: (path) => this.madeFrom(path),
    });
    this.renders = new Renders({
      root: this.dir,
      stateDir: join(await this.git.gitDir(), 'kuraa'),
      runner: this.runner,
      flush: (path) => this.writeForRender(path),
      madeFrom: (path) => this.madeFrom(path),
      compile: (folder, o) => this.compileFolder(folder, o),
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
    // A link that comes in a commit (from a push, a device or the online copy) is
    // checked out as a plain file holding where it points: never followed (0037).
    await this.git.run(['config', 'core.symlinks', 'false']);

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
      loaded: (room) => this.onRoomLoaded(room),
      changed: (room, user) => this.onClientChange(room, user),
      empty: (room) => this.onRoomEmpty(room),
      // A room no one is in here stays open, still in its session, until it is dropped (dropMs).
      keep: (room) => {
        const rec = this.byRoom.get(room);
        return !!rec && !rec.releasing && !this.closed;
      },
      unloaded: (room, state) => this.onRoomUnloaded(room, state),
      request: handler,
      upgrade: (req) => upgradeAllowed(req, this.requests),
    }, { host: this.options.host ?? '127.0.0.1', port: this.options.port ?? 0 });
    this.address = await this.relay.listen();
    // What this host's person does in rooms (0082): their own clients' changes, their devices' edits, and their seeding, never a sync's.
    this.relay.onFeatureChange((room, id, person, keys, source) => {
      const rec = this.byRoom.get(room);
      if (!rec || person !== this.features.person()) return;
      const theirs = source.from !== 'peer' || (!source.sync && this.ownDevice(source.peer));
      const set = rec.mine.get(id) ?? new Set<string>();
      for (const k of keys) {
        if (theirs) set.add(k);
        else set.delete(k);
      }
      rec.mine.set(id, set);
    });
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
    this.renders?.close();
    this.watcher?.close();
    clearInterval(this.gitPoll);
    for (const t of this.watchTimers.values()) clearTimeout(t);
    // Every room, whatever happens to one of them: what is not written is kept for next time (saveUnsaved).
    // Each leaves its session, saying so, so the others go on without waiting for this device (0077).
    await this.serial(async () => {
      for (const rec of this.records.values()) {
        try {
          await this.flushNow(rec);
          await this.commitNow(rec);
          // This person's own, from a room another device leads (0082).
          if (!this.leads(rec)) await this.writeOwn(rec);
        } catch (e) {
          this.log(`could not save ${rec.path} while stopping (kept for next time): ${(e as Error).message}`);
        }
        this.clearTimers(rec);
        if (rec.session) this.peers?.rooms.left(this.roomKey(rec), rec.baseCommit);
        if (this.leads(rec)) await this.saveUnsaved(rec).catch(() => undefined);
      }
    });
    // The saves just made, and any still waiting to be pushed, go to the online copies before they stop (a while at most).
    await Promise.all([...this.syncs.values()].map(({ session }) => session.pushPending?.(FINAL_PUSH_MS).catch(() => undefined)));
    for (const { session } of this.syncs.values()) session.close();
    await this.features.close();
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

  relPath(path: string, o: { link?: 'self' } = {}): string {
    return relative(this.dir, this.resolvePath(path, o)).split(sep).join('/');
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
  //
  // A room is one session of a file (0077): one Yjs document, started here from
  // the file, or joined from another device that has the file open, and over
  // when the last device in it leaves. Nothing of a session is kept or used
  // again once it is over: the next starts from the file. One device leads a
  // session (peers/rooms.ts): it alone writes the room's text to the file,
  // commits it, and brings changes from git into it. With no other device in
  // it, that is this one. A room no one is in here stays open, in its session,
  // for a while (dropMs), so opening its file again is at once.

  private roomName(rec: Pick<RoomRecord, 'branch' | 'path' | 'type' | 'generation'>): string {
    return [this.workspace, rec.branch, rec.path, `${rec.type.id}@${rec.type.version}`, rec.generation].map(encodeURIComponent).join('|');
  }

  /** Where a file's edits not yet written are kept while the host is stopped (Unsaved). */
  private unsavedFile(key: string): string {
    return join(this.cacheDir, createHash('sha1').update(key).digest('hex') + '.json');
  }

  /**
   * The current room for a file, creating it if need be. Not behind the host's
   * other work (saving, merging) when it need not be: a room already open is
   * given at once, and a new one is read and parsed apart from the queue, then
   * taken only if nothing changed meanwhile (else it is made in the queue, as
   * ever). Only edits kept from before, whose file changed since, need the
   * queue, to merge that change in.
   */
  async room(path: string, o: { draft?: boolean } = {}): Promise<RoomRecord> {
    const rel = this.relPath(path);
    let rec = await this.warmRecord(rel);
    if (!rec) {
      let opening = this.opening.get(rel);
      if (!opening) {
        opening = this.openApart(rel, !!o.draft).finally(() => this.opening.delete(rel));
        this.opening.set(rel, opening);
      }
      rec = await opening;
    }
    // Asked for, and nobody in it yet (they are on their way, or it was asked for ahead): it closes if nobody comes.
    if (!this.relay.clients(rec.room)) this.scheduleDrop(rec);
    return rec;
  }

  /** The room for a file on the branch checked out, if it is open (or kept warm): nothing to read or write. */
  private async warmRecord(path: string): Promise<RoomRecord | null> {
    const st = await this.readGitState();
    if (!st.branch) return null;
    const rec = this.records.get(`${st.branch}:${path}`);
    if (!rec) return null;
    this.keepRecord(rec);
    return rec;
  }

  /** A room asked for again: not dropped. */
  private keepRecord(rec: RoomRecord): void {
    if (rec.timers.drop) clearTimeout(rec.timers.drop);
    rec.timers.drop = undefined;
    rec.releasing = false;
    rec.usedAt = Date.now();
  }

  private async openApart(path: string, draft = false): Promise<RoomRecord> {
    const st = await this.readGitState();
    const prep = st.branch ? await this.prepareRecord(path, st.branch, draft).catch(() => null) : null;
    if (prep && !prep.needsOutsideCheck) {
      const now = await this.readGitState();
      const existing = this.records.get(prep.key);
      if (existing) return existing;
      // Taken only if the branch and the file are as they were read: else made in the queue, read again.
      const text = prep.draft ? (existsSync(this.resolvePath(path)) ? null : '') : now.branch === prep.branch ? await this.readText(this.resolvePath(path), path).catch(() => null) : null;
      if (text !== null && text === prep.text && !this.records.has(prep.key)) {
        const rec = this.installRecord(prep);
        this.noteCommitted(rec, prep.text);
        return rec;
      }
    }
    // Errors (no such file, a link, no branch) are said from here, as they always were.
    return this.serial(() => this.ensureRecord(path, draft));
  }

  private async ensureRecord(path: string, draft = false): Promise<RoomRecord> {
    const st = await this.readGitState();
    // No branch to save to (an earlier version is checked out, or a rebase is under way): nothing new opens.
    if (!st.branch) throw new HttpError(409, pausedBecause(st)!);
    const branch = st.branch;
    const key = `${branch}:${path}`;
    const existing = this.records.get(key);
    if (existing) {
      this.keepRecord(existing);
      return existing;
    }
    const prep = await this.prepareRecord(path, branch, draft);
    const rec = this.installRecord(prep);
    if (rec.needsOutsideCheck) await this.applyOutside(rec, prep.text);
    else this.noteCommitted(rec, prep.text);
    return rec;
  }

  /**
   * What a new room for a file starts from: the file read and parsed, and edits
   * to it not yet written when the host last stopped, if any (for the same type
   * version). Only reads: safe apart from the queue.
   */
  private async prepareRecord(path: string, branch: string, draft = false): Promise<PreparedRecord> {
    const key = `${branch}:${path}`;
    const type = this.typeFor(path);
    if (!type) throw new HttpError(415, `No document type for ${path}`);
    const abs = this.resolvePath(path);
    if (!existsSync(abs)) {
      if (!draft) throw new HttpError(404, `No such file: ${path}`);
      // A new document with no file yet (0097): empty, its file made when there is first something in it
      // (flushNow writes only what differs from what it started with). Edits kept from before a restart, if any.
      const head = await this.git.head();
      const kept = await this.readUnsaved(key, type);
      const empty = type.parse('');
      return {
        key, path, branch, type, text: '', previous: empty, state: kept ? encodeDoc(type.parse(kept.pending).doc) : null,
        baseCommit: head, lastHash: blobId(''), dirty: !!kept, needsOutsideCheck: false, keptCompanions: null, draft: true,
      };
    }
    const text = await this.readText(abs, path);
    const head = await this.git.head();
    const kept = await this.readUnsaved(key, type);
    if (kept) {
      return {
        key, path, branch, type, text, previous: type.parse(kept.text), state: encodeDoc(type.parse(kept.pending).doc),
        baseCommit: kept.baseCommit ?? head, lastHash: kept.lastHash, dirty: true,
        // The file changed while the host was away: an outside change against those edits.
        needsOutsideCheck: blobId(text) !== kept.lastHash,
        keptCompanions: kept.companions ?? null,
      };
    }
    return { key, path, branch, type, text, previous: type.parse(text), state: null, baseCommit: head, lastHash: blobId(text), dirty: false, needsOutsideCheck: false, keptCompanions: null };
  }

  /** A prepared room, taken as the file's room. */
  private installRecord(p: PreparedRecord): RoomRecord {
    const rec = this.newRecord({ key: p.key, path: p.path, branch: p.branch, type: p.type, baseCommit: p.baseCommit, previous: p.previous, lastHash: p.lastHash, state: p.state });
    rec.dirty = p.dirty;
    rec.needsOutsideCheck = p.needsOutsideCheck;
    rec.keptCompanions = p.keptCompanions;
    rec.draft = p.draft;
    this.records.set(p.key, rec);
    this.byRoom.set(rec.room, rec);
    return rec;
  }

  /**
   * Find out, apart from the queue (it only reads), whether the file as opened is
   * the branch's committed version: then closing it, or saving it with nothing
   * changed, needs no git at all (commitNow).
   */
  private noteCommitted(rec: RoomRecord, text: string): void {
    const hash = blobId(text);
    void this.git.run(['rev-parse', '-q', '--verify', `refs/heads/${rec.branch}:${rec.path}`], { allowFail: true }).then((r) => {
      if (r.code === 0 && r.stdout.trim() === hash && rec.lastHash === hash && !rec.uncommitted) rec.committedHash = hash;
    }, () => undefined);
  }

  private newRecord(init: Pick<RoomRecord, 'key' | 'path' | 'branch' | 'type' | 'baseCommit' | 'previous' | 'lastHash' | 'state'>): RoomRecord {
    const rec: RoomRecord = {
      ...init,
      room: '',
      generation: newId(),
      session: null,
      leading: true,
      bases: init.baseCommit ? [init.baseCommit] : [],
      flushedSv: null,
      dirty: false,
      uncommitted: false,
      committedHash: null,
      contributors: new Map(),
      editingSince: null,
      lastFlushAt: null,
      lastCommitAt: null,
      lastCommit: null,
      needsOutsideCheck: false,
      failures: 0,
      usedAt: Date.now(),
      releasing: false,
      waitingSince: null,
      companions: new Set(),
      keptCompanions: null,
      mine: new Map(),
      timers: {},
    };
    rec.room = this.roomName(rec);
    return rec;
  }

  /**
   * A room's first client here: the room's session. One another device has
   * open is joined, from the state of a device in it (peers/rooms.ts); else a
   * session starts here, from the file as already parsed (or from edits of
   * this device's not yet written, which meet the others' in git, never in the room).
   */
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
    this.keepRecord(rec);
    // A new session: nothing yet done in it by this host's person (0082).
    rec.mine = new Map();
    // Moved to another device's session (switchRoom): its state, as it came.
    if (rec.session && rec.state) {
      const state = rec.state;
      rec.state = null;
      return { state };
    }
    const joined = !rec.dirty && this.peers ? await this.peers.rooms.join(this.roomKey(rec)).catch(() => null) : null;
    if (this.byRoom.get(room) !== rec || rec.session) return rec.session && rec.state ? { state: rec.state } : null;
    if (joined) {
      rec.session = joined.session;
      rec.leading = false;
      rec.flushedSv = null;
      this.noteBase(rec, joined.base);
      this.log(`joined ${rec.path}'s session on another device`);
      return { state: joined.state };
    }
    // What features keep in the room starts from their companions (0082): read first, then made from the document as it is.
    // (Nothing is waited for where no feature keeps state in rooms: a session starts as it always did.)
    const seeding = this.features.keepsRoomState() ? await this.features.seedFor(rec.path, rec.keptCompanions ?? undefined).catch((e: unknown) => {
      this.log(`could not read what features keep beside ${rec.path}: ${(e as Error).message}`);
      return undefined;
    }) : undefined;
    if (this.byRoom.get(room) !== rec || rec.session) return rec.session && rec.state ? { state: rec.state } : null;
    rec.session = newId();
    rec.leading = true;
    // Afresh, written by a client id of its own: never the state of a session before.
    const doc = this.current(rec);
    const state = encodeDoc(doc, seeding?.(rec.type, doc, this.parsedOf(rec, doc)));
    rec.state = null;
    // Edits kept from before are now in the room's state, where a feature on seeded from them; else they wait to be written (flushNow).
    if (seeding) rec.keptCompanions = null;
    rec.flushedSv = rec.dirty ? null : vectorOf(state);
    void this.features.emit('open', { path: rec.path });
    // Made here, from this person's own files: theirs (0082).
    return { state, own: true };
  }

  /** A room's document as parsed: its last written text's parse, if it is still that, else parsed anew from it. */
  private parsedOf(rec: RoomRecord, doc: ReturnType<RoomRecord['type']['parse']>['doc']): ParsedDocument {
    if (doc === rec.previous.doc) return rec.previous;
    const text = rec.type.serialize(doc, rec.previous);
    return text === rec.previous.text ? rec.previous : rec.type.parse(text);
  }

  /**
   * What features keep in a room, as it is now, from wherever it is held (the
   * relay, or the state it is to open or holds unwritten): a copy, so it stays
   * as the document read with it, whatever is typed meanwhile. Null where no
   * feature on keeps state in rooms.
   */
  private featureView(rec: RoomRecord): FeatureView | null {
    if (!this.features.keepsRoomState()) return null;
    const state = this.relay.state(rec.room) ?? rec.state;
    return state ? featuresOfState(state, rec.type.schema) : null;
  }

  /**
   * Rooms open here whose maps for this host's person are not seeded (0082: a
   * feature turned on while they were open, or a session joined on another
   * device): seeded now from this person's own files, so what they do there is
   * written back. Every open room, led here or not: each person's are their
   * own device's to seed.
   */
  async seedOpenRooms(only?: RoomRecord): Promise<void> {
    for (const rec of only ? [only] : [...this.records.values()]) {
      if (!this.relay.isOpen(rec.room)) continue;
      const view = this.relay.features(rec.room, rec.type.schema);
      const missing = view ? this.features.unseeded(view) : [];
      if (!missing.length) continue;
      const seeding = await this.features.seedFor(rec.path, undefined, missing).catch(() => undefined);
      if (!seeding || !this.relay.isOpen(rec.room)) continue;
      const doc = this.current(rec);
      const { person, seed } = seeding(rec.type, doc, this.parsedOf(rec, doc));
      this.relay.seedFeatures(rec.room, rec.type.schema, person, seed);
    }
  }

  /**
   * Write this host's person's own files from a room another device leads
   * (0082): the leader writes the document, and its own person's files; each
   * person's are their own device's to write, and to commit, as their own.
   */
  private async writeOwn(rec: RoomRecord, leaving = false): Promise<void> {
    if (rec.timers.own) clearTimeout(rec.timers.own);
    rec.timers.own = undefined;
    // (Leaving a session another device led: this device no longer in it, so it "leads" its room, but wrote nothing of it.)
    if ((this.leads(rec) && !leaving) || !this.features.keepsRoomState()) return;
    const st = await this.readGitState();
    if (pausedBecause(st) || st.branch !== rec.branch) return;
    const doc = this.current(rec);
    const view = this.featureView(rec);
    if (!view) return;
    const parsed = this.parsedOf(rec, doc);
    const before = new Map<string, string | null>();
    for (const c of await this.features.ownFilesOf(rec.path)) before.set(c, await readFile(this.resolvePath(c), 'utf8').catch(() => null));
    const written = await this.features.writeRoom(rec.path, rec.type, doc, parsed, view, rec.mine);
    if (!written.length) return;
    const beside = this.features.describe(await Promise.all(written.map(async (c) => ({ path: c, before: before.get(c) ?? null, after: existsSync(this.resolvePath(c)) ? await readFile(this.resolvePath(c), 'utf8') : null }))));
    await this.commitPaths(written, describeEdit(rec.type, rec.path, parsed.text, parsed.text, [], beside.length ? beside : this.features.labelsOf(written)));
  }

  /** A room's document is open here (a client came): the other devices are told. */
  private onRoomLoaded(room: string): void {
    const rec = this.byRoom.get(room);
    if (!rec) return;
    this.peers?.rooms.opened(room);
    // A session joined from another device: this person's own maps, from their files (0082).
    if (this.features.keepsRoomState()) void this.seedOpenRooms(rec).catch((e) => this.log(`could not seed your own beside ${rec.path}: ${e}`));
  }

  private onClientChange(room: string, user: PresenceUser | null): void {
    const rec = this.byRoom.get(room);
    if (!rec) return;
    rec.dirty = true;
    if (user) rec.contributors.set(user.email || user.name, user);
    // Written and committed by the device that leads the session (0077); this person's own annotations, by their device (0082).
    if (!this.leads(rec)) {
      if (this.features.keepsRoomState() && !rec.timers.own) rec.timers.own = setTimeout(() => void this.serial(() => this.writeOwn(rec)).catch((e) => this.log(`could not write your own beside ${rec.path}: ${e}`)), this.timings.flushMs);
      return;
    }
    const t = rec.timers;
    if (t.flush) clearTimeout(t.flush);
    // A draft's file is made as soon as something is written in it (0097), not after the usual wait from the last edit:
    // the file list has it while the writing goes on.
    t.flush = setTimeout(() => void this.serial(() => this.flushNow(rec)).catch((e) => this.log(`flush failed: ${e}`)), rec.draft ? 0 : this.timings.flushMs);
    if (t.commit) clearTimeout(t.commit);
    t.commit = setTimeout(() => void this.commitRoom(rec).catch((e) => this.log(`commit failed: ${e}`)), this.timings.idleCommitMs);
    if (rec.editingSince === null) {
      rec.editingSince = Date.now();
      t.max = setTimeout(() => void this.commitRoom(rec).catch((e) => this.log(`commit failed: ${e}`)), this.timings.maxCommitMs);
    }
  }

  /** Whether this device writes and commits a room: it leads its session, or it is in none (0077). */
  private leads(rec: RoomRecord): boolean {
    return !rec.session || rec.leading;
  }

  private onRoomEmpty(room: string): void {
    const rec = this.byRoom.get(room);
    if (!rec) return;
    // Leaving a file saves it, by the device that leads its session; the room stays open, in its session, a while.
    if (this.leads(rec)) {
      void this.serial(async () => {
        await this.flushNow(rec);
        await this.commitNow(rec);
      }).catch((e) => this.log(`saving on leaving failed: ${e}`));
    }
    rec.usedAt = Date.now();
    this.scheduleDrop(rec);
  }

  /**
   * Close a room nobody is in after a while (dropMs). Until then it is kept
   * warm: still in its session, so opening its file again is at once. At most
   * MAX_IDLE_ROOMS are kept so; past that, the one used longest ago closes now.
   */
  private scheduleDrop(rec: RoomRecord): void {
    if (rec.timers.drop) clearTimeout(rec.timers.drop);
    rec.timers.drop = setTimeout(() => this.drop(rec), this.timings.dropMs);
    const idle = [...this.records.values()].filter((r) => r.timers.drop && !this.relay.clients(r.room));
    if (idle.length <= MAX_IDLE_ROOMS) return;
    const oldest = idle.reduce((a, b) => (b.usedAt < a.usedAt ? b : a));
    clearTimeout(oldest.timers.drop);
    this.drop(oldest);
  }

  private drop(rec: RoomRecord): void {
    rec.timers.drop = undefined;
    if (this.relay.clients(rec.room) > 0) return;
    // In a session: it is left first (onRoomUnloaded), then dropped.
    if (this.relay.isOpen(rec.room)) {
      rec.releasing = true;
      this.relay.release(rec.room);
      return;
    }
    this.serial(async () => {
      // Not if it was taken up again meanwhile, or still has edits to save (they are tried again).
      if (this.relay.clients(rec.room) > 0 || this.relay.isOpen(rec.room) || this.records.get(rec.key) !== rec || rec.timers.drop) return;
      if (rec.dirty || rec.uncommitted) return this.saveUnsaved(rec);
      await this.forget(rec);
    }).catch((e) => this.log(`could not close ${rec.path}'s room: ${e}`));
  }

  /** A room closed for good here: no record of it, nor of edits to keep. */
  private async forget(rec: RoomRecord): Promise<void> {
    this.clearTimers(rec);
    if (this.records.get(rec.key) === rec) this.records.delete(rec.key);
    this.byRoom.delete(rec.room);
    await this.removeUnsaved(rec.key);
  }

  /**
   * A room's document let go of here (dropped): this device has left its
   * session. If it led it, the room's text is written and committed first; what
   * another device in it still has is that device's. The session is over here:
   * its name is not opened again, and the next starts from the file.
   */
  private onRoomUnloaded(room: string, state: Uint8Array): void {
    const rec = this.byRoom.get(room);
    if (!rec || !rec.session) return;
    // What it held, for whatever writes it now (stopping: close, which saves every room).
    rec.state = state;
    if (this.closed) return;
    const key = this.roomKey(rec);
    const leading = this.leads(rec);
    this.byRoom.delete(room);
    rec.generation = newId();
    rec.room = this.roomName(rec);
    this.byRoom.set(rec.room, rec);
    rec.session = null;
    rec.leading = true;
    rec.flushedSv = null;
    rec.waitingSince = null;
    if (rec.timers.lead) clearTimeout(rec.timers.lead);
    rec.state = state;
    if (!leading) rec.dirty = false;
    void this.serial(async () => {
      if (leading) {
        try {
          await this.flushNow(rec);
          await this.commitNow(rec);
        } catch (e) {
          this.log(`could not save ${rec.path} on leaving it: ${(e as Error).message}`);
        }
      } else {
        // Not led here: this person's own, from the session as it was left (0082).
        await this.writeOwn(rec, true).catch((e) => this.log(`could not save your own beside ${rec.path} on leaving it: ${(e as Error).message}`));
      }
      if (!rec.dirty) rec.state = null;
      this.peers?.rooms.left(key, rec.baseCommit);
      if (rec.releasing && !this.relay.clients(rec.room) && !rec.dirty && !rec.uncommitted) await this.forget(rec);
      else if (rec.dirty) await this.saveUnsaved(rec);
    }).catch((e) => this.log(`could not leave ${rec.path}'s session: ${e}`));
  }

  private clearTimers(rec: RoomRecord): void {
    for (const t of Object.values(rec.timers)) if (t) clearTimeout(t);
    rec.timers = {};
  }

  /** The room's current document: from the relay, or the state it is to open or holds unwritten, or the file as last seen. */
  private current(rec: RoomRecord) {
    const live = this.relay.read(rec.room, rec.type.schema);
    if (live) return live;
    if (rec.state) return decodeDoc(rec.state, rec.type.schema);
    return rec.previous.doc;
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
   * edits wait in the room. Before writing, the file is read: if someone changed
   * it since it was last seen (and the watcher missed it), that change is merged
   * in first, or kept beside it. Only by the device that leads the room's
   * session (0077): the others never write the file from the room.
   */
  async flushNow(rec: RoomRecord): Promise<void> {
    if (rec.timers.flush) clearTimeout(rec.timers.flush);
    rec.timers.flush = undefined;
    if (!rec.dirty || !this.leads(rec)) return;
    const st = await this.readGitState();
    if (pausedBecause(st) || st.branch !== rec.branch) {
      // Kept for later: committed onto its own branch (commitNow), or written when git is done.
      if (!rec.session) await this.saveUnsaved(rec);
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
    if (disk && !notText && blobId(disk.toString('utf8')) !== rec.lastHash) {
      // Changed outside the app since it was last seen: merged in first (applyOutside writes the result).
      return this.applyOutside(rec, disk.toString('utf8'));
    }
    // Made something that is not text outside the app: keep that beside it, and write the room.
    if (notText) await this.saveBeside(rec, disk!);
    // The room as written: its text, and how far its edits go (for devices moving to another session: rooms.ts).
    const sv = this.relay.stateVector(rec.room);
    const doc = this.current(rec);
    // What features keep in the room, as it is with this document (0082).
    const view = this.featureView(rec);
    const text = rec.type.serialize(doc, rec.previous);
    rec.dirty = false;
    if (text !== rec.previous.text || notText) {
      // A draft's file is made now (0097): in its folder's space where that is one (as POST /api/files makes one).
      const making = rec.draft && !existsSync(abs);
      if (making) rec.madeInSpace = this.peers ? await this.peers.spaceForNew(rec.path) : null;
      try {
        if (making) await mkdir(dirname(abs), { recursive: true });
        await this.writeAtomic(abs, text);
        if (making) {
          rec.draft = false;
          const at = new Date().toISOString();
          for (const r of this.records.values()) this.broadcast(r, { type: 'files-changed', at });
        }
      } catch (e) {
        // Not written (on Windows another program may hold the file): the edits wait, and it is tried again.
        rec.dirty = true;
        this.saveFailed(rec, e);
        throw e;
      }
      rec.lastHash = blobId(text);
      rec.previous = rec.type.parse(text);
      rec.uncommitted = true;
      rec.lastFlushAt = new Date().toISOString();
      this.broadcast(rec, { type: 'flushed', at: rec.lastFlushAt, hash: rec.lastHash });
      // Committed after the usual wait, even if a commit made meanwhile let go of the one set for it.
      if (!rec.timers.commit) this.commitSoon(rec.room);
      void this.features.emit('save', { path: rec.path, text });
    }
    // This person's own files kept with edits not written when the host last stopped, where no feature seeded the room from
    // them (one off now): written as they were, never lost (0082).
    if (rec.keptCompanions) {
      const me = this.features.person();
      for (const [c, kept] of Object.entries(rec.keptCompanions)) {
        if (!me || !c.includes(`/@${me}`)) continue;
        if (kept === null) await this.features.removeOwn(c);
        else {
          await mkdir(dirname(this.resolvePath(c)), { recursive: true });
          await this.writeAtomic(this.resolvePath(c), kept);
        }
        rec.companions.add(c);
        rec.uncommitted = true;
      }
      rec.keptCompanions = null;
    }
    // What features keep in the room, beside the document (0082): from the same document, into the same commit.
    if (view) {
      try {
        const written = await this.features.writeRoom(rec.path, rec.type, doc, rec.previous, view, rec.mine);
        for (const c of written) rec.companions.add(c);
        if (written.length) {
          rec.uncommitted = true;
          if (!rec.timers.commit) this.commitSoon(rec.room);
        }
      } catch (e) {
        // Tried again at the next save: the document's own text is written.
        rec.dirty = true;
        this.log(`could not write what features keep beside ${rec.path}: ${(e as Error).message}`);
      }
    }
    rec.flushedSv = sv;
    if (!rec.session) rec.state = null;
    await this.removeUnsaved(rec.key);
  }

  async commitRoom(rec: RoomRecord, message?: string): Promise<string | null> {
    // A named version of a room another device leads: made there, where its text is written (0077).
    if (message !== undefined && !this.leads(rec) && this.peers) return this.peers.rooms.askVersion(rec.room, message);
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
    // Committed by the device that leads the room's session (0077); a named version is asked of it (commitRoom).
    if (!this.leads(rec)) return null;
    const st = await this.readGitState();
    if (pausedBecause(st)) return null;
    const t = rec.timers;
    for (const k of ['commit', 'max', 'retry'] as const) {
      if (t[k]) clearTimeout(t[k]);
      t[k] = undefined;
    }
    rec.editingSince = null;
    // Nothing written since the file was last known to be committed: nothing to commit (and no git to run for it).
    if (message === undefined && st.branch === rec.branch && !rec.dirty && !rec.uncommitted && rec.committedHash === rec.lastHash && !rec.companions.size) return null;
    // Companions written from the room's state go into the same commit (0082).
    const companions = [...rec.companions];
    const people = [...rec.contributors.values()];
    const extra = message === undefined ? [AUTOSAVE_TRAILER] : [];
    let committed: string | null;
    let text = message;
    try {
      if (st.branch === rec.branch) {
        // A named version says what it is; otherwise say what changed, and mark it as a save the host made.
        if (text === undefined) {
          const before = await this.git.run(['show', `${this.refFor(rec.path)}:${rec.path}`], { allowFail: true });
          const beside = this.features.describe(await Promise.all(companions.map(async (c) => {
            const was = await this.git.run(['show', `${this.refFor(c)}:${c}`], { allowFail: true });
            const abs = this.resolvePath(c);
            return { path: c, before: was.code === 0 ? was.stdout : null, after: existsSync(abs) ? await readFile(abs, 'utf8') : null };
          })));
          text = describeEdit(rec.type, rec.path, before.code === 0 ? before.stdout : null, rec.previous.text, people.map((u) => u.name), beside);
        }
        // Made just now in a folder fewer read: committed into its space (0069), never onto the workspace's own branch.
        const space = rec.madeInSpace;
        rec.madeInSpace = null;
        committed = space ? await this.commitIntoSpace(space, [rec.path], withTrailers(text, people, extra)) : await this.commitPaths([rec.path, ...companions], text, people, extra);
        for (const c of companions) rec.companions.delete(c);
      } else {
        const now = rec.type.serialize(this.current(rec), rec.previous);
        if (text === undefined) {
          const before = await this.git.run(['show', `refs/heads/${rec.branch}:${rec.path}`], { allowFail: true });
          text = describeEdit(rec.type, rec.path, before.code === 0 ? before.stdout : null, now, people.map((u) => u.name));
        }
        committed = await this.commitToBranch(rec.branch, rec.path, now, withTrailers(text, people, [...extra, ...(await this.policyTrailer())]));
        rec.previous = rec.type.parse(now);
        rec.lastHash = blobId(now);
        rec.dirty = false;
        // This person's own files written from the room before the branch was switched (0082): onto its branch too, and
        // put back as the branch checked out has them.
        for (const c of companions) {
          const abs = this.resolvePath(c);
          const own = existsSync(abs) ? await readFile(abs, 'utf8') : null;
          if (own !== null) committed = (await this.commitToBranch(rec.branch, c, own, withTrailers(text, people, [...extra, ...(await this.policyTrailer())]))) ?? committed;
          if ((await this.git.run(['cat-file', '-e', `HEAD:${c}`], { allowFail: true })).code === 0) await this.git.run(['checkout', 'HEAD', '--', c], { allowFail: true });
          else await this.features.removeOwn(c);
          rec.companions.delete(c);
        }
      }
    } catch (e) {
      this.saveFailed(rec, e);
      throw e;
    }
    this.saveRecovered(rec);
    rec.uncommitted = false;
    // On the branch checked out, the file is now as committed (a commit, or nothing to commit).
    if (st.branch === rec.branch) rec.committedHash = rec.lastHash;
    if (!committed) {
      if (rec.session) this.peers?.rooms.committed(rec.room);
      return null;
    }
    rec.contributors.clear();
    this.noteBase(rec, committed);
    rec.lastCommit = committed;
    rec.lastCommitAt = new Date().toISOString();
    this.broadcast(rec, { type: 'committed', at: rec.lastCommitAt, commit: committed, message: text });
    // The devices in the session (and any other with the file open) hear of it: the next to lead builds on it.
    if (rec.session) this.peers?.rooms.committed(rec.room);
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

  /** The policy a commit made here is made under (0066: peers/gate.ts), as a trailer: none where there is no policy. */
  private async policyTrailer(): Promise<string[]> {
    if (!this.peers) return [];
    const policy = await this.peers.node.identity.policy();
    return policy.founded && policy.heads.length ? [`${POLICY_TRAILER}: ${policy.heads.join(' ')}`] : [];
  }

  /** The ref a file is committed on and read from: its space's (spaces.ts), or HEAD for the workspace's own. */
  refFor(path: string): string {
    const space = this.spaces?.spaceOf(path);
    return (space && this.spaces.refOf(space)) || 'HEAD';
  }

  /**
   * Changes to a file that were not kept (0072): made by someone who may not
   * change it, kept out by a merge, which says so (`Kuraa-Refused: <commit>
   * <path>`). Each the commit proposing its text, and the merge; newest first.
   * Never the file's text: they stay in its history, to read and take up.
   */
  async notKept(path: string): Promise<{ commit: string; merge: string }[]> {
    const ref = this.refFor(path);
    const tip = (await this.git.run(['rev-parse', '-q', '--verify', `${ref}^{commit}`], { allowFail: true })).stdout.trim();
    if (!tip) return [];
    const key = `${tip}\0${path}`;
    const had = this.notKeptMemo.get(key);
    if (had) return had;
    const log = await this.git.run(['log', tip, '--merges', '-n', '500', '--format=%H%x1f%B%x1e', `--grep=^${REFUSED_TRAILER}: `], { allowFail: true });
    const out: { commit: string; merge: string }[] = [];
    const seen = new Set<string>();
    for (const entry of log.stdout.split('\x1e')) {
      const [merge, body] = entry.trim().split('\x1f');
      if (!merge || body === undefined) continue;
      for (const v of trailers(body, REFUSED_TRAILER)) {
        const m = /^([0-9a-f]{40,64}) (.+)$/.exec(v);
        if (m && m[2] === path && !seen.has(m[1]!)) {
          seen.add(m[1]!);
          out.push({ commit: m[1]!, merge });
        }
      }
    }
    if (this.notKeptMemo.size > 200) this.notKeptMemo.clear();
    this.notKeptMemo.set(key, out);
    return out;
  }

  private notKeptMemo = new Map<string, { commit: string; merge: string }[]>();

  /**
   * The files code run for a document must not see (0066): those of spaces
   * whose readers are not everyone who reads the document. Data flows from
   * wider to narrower audiences, never back.
   */
  async hiddenFrom(path: string): Promise<string[]> {
    const entries = this.spaces?.entries() ?? [];
    if (!entries.length || !this.peers) return [];
    const holds = await this.wideEnough(path);
    return entries.filter(([, space]) => !holds(space)).map(([p]) => p);
  }

  /** Whether code run for a document may read a space: everyone who reads the document reads it (0066). */
  private async wideEnough(path: string): Promise<(space: string) => boolean> {
    if (!this.peers) return () => false;
    const policy = await this.peers.node.identity.policy();
    const readers = policy.readers(this.spaceOf(path));
    const wide = new Map<string, boolean>();
    return (space: string) => {
      if (!wide.has(space)) {
        const theirs = policy.readers(space);
        wide.set(space, [...readers].every((r) => theirs.has(r)));
      }
      return wide.get(space)!;
    };
  }

  /** What code run for a document reads now (0081): the commit of each history it may read, and the files that differ. */
  async madeFrom(path: string): Promise<MadeFrom> {
    const ids = this.spaces?.ids() ?? [];
    const holds = ids.length ? await this.wideEnough(path) : () => false;
    const entries = this.spaces?.entries() ?? [];
    const spaces = ids.filter(holds).map((id) => ({ id, ref: this.spaces.refOf(id)!, files: entries.filter(([, s]) => s === id).map(([p]) => p) }));
    return madeFrom(this.git, this.dir, spaces);
  }

  /**
   * The files an output was made from, as a zip, or why they cannot be had: a commit no longer here (a
   * space this device no longer holds, say).
   */
  async madeFromZip(made: MadeFrom, name: string): Promise<Buffer> {
    const missing = await missingFrom(this.git, made);
    if (missing) throw new HttpError(410, `The files it was made from are no longer all here (${missing.slice(0, 7)} is missing).`);
    return zipOf(this.git, await putTogether(this.git, made, join(await this.git.gitDir(), 'kuraa', 'tmp')), name);
  }

  /** The space a file is in (null: the workspace's own). */
  spaceOf(path: string): string | null {
    return this.spaces?.spaceOf(path) ?? null;
  }

  /** Sign a commit object with this device's signing key (spaces' commits; there are spaces only where devices sync). */
  private async signRaw(raw: Buffer): Promise<Buffer> {
    if (!this.peers) throw new Error('Spaces are for a workspace shared with other devices');
    return signCommitObject(raw, await this.peers.node.signingKey());
  }

  /**
   * Commit files of spaces (0066), each in its own space's history: those of
   * `paths` in a space, and those in a space under a folder of them. Returns
   * the paths left for the workspace's own commit, and the last commit made.
   */
  private async commitSpaces(paths: string[], message: string): Promise<{ rest: string[]; commit: string | null }> {
    if (!this.spaces?.entries().length) return { rest: paths, commit: null };
    const branch = await this.git.branch();
    if (!branch) return { rest: paths, commit: null };
    const bySpace = new Map<string, string[]>();
    const rest: string[] = [];
    for (const p of paths) {
      const own = this.spaces.spaceOf(p);
      if (own) {
        bySpace.set(own, [...(bySpace.get(own) ?? []), p]);
        continue;
      }
      for (const [f, id] of this.spaces.entries()) if (f.startsWith(`${p}/`)) bySpace.set(id, [...(bySpace.get(id) ?? []), f]);
      rest.push(p);
    }
    let commit: string | null = null;
    for (const [id, files] of bySpace) commit = (await this.spaces.commit(id, branch, files.map((path) => ({ path })), message, (raw) => this.signRaw(raw))) ?? commit;
    if (bySpace.size) {
      await this.spaces.refresh(branch);
      if (commit) this.log(`committed ${commit.slice(0, 7)} ${message.split('\n')[0]} (in a space)`);
    }
    return { rest, commit };
  }

  /** Stage and commit the given paths. Returns the commit, or null if nothing changed. */
  async commitPaths(paths: string[], message: string, coAuthors: PresenceUser[] = [], extra: string[] = []): Promise<string | null> {
    // Never in the middle of a git operation, or with no branch checked out.
    await this.requireWritable();
    // A space's files, in its own history (0066); the rest, the workspace's own.
    const all = paths;
    const spaced = await this.commitSpaces(paths, withTrailers(message, coAuthors, [...extra, ...(await this.policyTrailer())]));
    if (spaced.commit) {
      this.refsChanged();
      void this.features.emit('commit', { commit: spaced.commit, paths: all.filter((p) => !spaced.rest.includes(p)) });
    }
    paths = spaced.rest;
    if (!paths.length) return spaced.commit;
    // A path neither here nor in git (a merge took it away while its room was open) has nothing to commit, and git would refuse it.
    // Git is asked only about paths gone from the working tree (a move's old path, a deleted file): most commits have none.
    const here = (p: string) => existsSync(this.resolvePath(p, { link: 'self' }));
    const gone = paths.filter((p) => !here(p));
    const listed = async (args: string[]) => new Set(gone.length ? (await this.git.run([...args, '--', ...gone], { allowFail: true })).stdout.split('\0').filter(Boolean) : []);
    // A folder (a folder moved) is known by the files in it.
    const known = (p: string, set: Set<string>) => set.has(p) || [...set].some((x) => x.startsWith(`${p}/`));
    const inHead = await listed(['ls-tree', '-r', '--name-only', '-z', 'HEAD']);
    const inIndex = await listed(['ls-files', '-z']);
    paths = paths.filter((p) => here(p) || known(p, inIndex) || known(p, inHead));
    if (!paths.length) return spaced.commit;
    await this.git.stage(paths);
    const diff = await this.git.run(['diff', '--cached', '--quiet', '--', ...paths], { allowFail: true });
    if (diff.code === 0) return spaced.commit;
    const full = withTrailers(message, coAuthors, [...extra, ...(await this.policyTrailer())]);
    // Syncing with other devices: signed, so they can tell whose it is (signing.ts).
    // Signed with this host's person's key if it keeps one, else its device's (0034).
    if (this.peers) await commitSigned(this.git, paths, full, await this.peers.node.signingKey(), this.tmpDir);
    else if (caseRename(paths)) await this.commitFromIndex(paths, full);
    else {
      // `git commit -- <paths>` refuses a path git knows nothing of (gone, and now in neither the index nor HEAD).
      const staged = await listed(['ls-files', '-z']);
      await this.git.run(['commit', '-q', '-F', '-', '--', ...paths.filter((p) => here(p) || known(p, staged) || known(p, inHead))], { input: full });
    }
    const head = await this.git.head();
    this.log(`committed ${head?.slice(0, 7)} ${message}`);
    this.refsChanged();
    if (head) void this.features.emit('commit', { commit: head, paths });
    return head;
  }

  /**
   * Commit these paths as they are in the working tree, from an index of their
   * own (as commitSigned, unsigned). For a rename in case alone, which
   * `git commit -- <paths>` cannot make on a file system that ignores case.
   */
  private async commitFromIndex(paths: string[], message: string): Promise<void> {
    const head = await this.git.head();
    await mkdir(this.tmpDir, { recursive: true });
    const env = { GIT_INDEX_FILE: join(this.tmpDir, `case-index-${process.pid}-${randomBytes(4).toString('hex')}`) };
    try {
      await this.git.run(head ? ['read-tree', head] : ['read-tree', '--empty'], { env });
      await this.git.stage(paths, { env });
      const tree = await this.git.out(['write-tree'], { env });
      const text = `${message.trimEnd()}\n`;
      const commit = await this.git.out(['commit-tree', tree, ...(head ? ['-p', head] : []), '-F', '-'], { input: text });
      await this.git.run(['update-ref', '-m', `commit: ${text.split('\n')[0]}`, 'HEAD', commit, head ?? '']);
      await this.git.stage(paths);
    } finally {
      await rm(env.GIT_INDEX_FILE, { force: true });
    }
  }

  /**
   * Commit a file's text onto a branch that is not checked out, by its ref alone:
   * the branch's tree with this file changed, a commit on top (signed, when
   * syncing with devices), and the ref moved only if it is still where it was.
   * The working tree and the checked-out branch are not touched.
   */
  private async commitToBranch(branch: string, path: string, text: string, message: string): Promise<string | null> {
    // A space's file, in its space's history on that branch (0066).
    const space = this.spaces?.spaceOf(path);
    if (space) {
      const commit = await this.spaces.commit(space, branch, [{ path, content: Buffer.from(text, 'utf8') }], message, (raw) => this.signRaw(raw));
      if (commit) {
        await this.spaces.refresh(await this.git.branch());
        this.refsChanged();
      }
      return commit;
    }
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
    // Spaces follow the branch by name.
    if (from !== st.branch) await this.spaces.refresh(st.branch);
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
    // Which features are on, changed outside the app (0082).
    if (path === FEATURES_FILE || path === COMPANIONS_FILE) {
      await this.features.refresh();
      await this.seedOpenRooms();
    }
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
   * A room another device leads (0077) is never changed here: an edit made
   * outside the app on this device's disk is committed as it is, and reaches
   * the room through the device that leads it, by git.
   */
  private async checkOutside(rec: RoomRecord): Promise<void> {
    const st = await this.readGitState();
    if (pausedBecause(st) || st.branch !== rec.branch) return;
    const abs = this.resolvePath(rec.path);
    if (!existsSync(abs)) {
      // Renamed or deleted by a commit (another device's, a push, git outside the app): the room closes, so
      // it never writes the old path again. One with edits not yet in a commit keeps them, and its file.
      if (rec.uncommitted || (rec.dirty && this.leads(rec))) return;
      const to = await this.takenByCommit(rec.path);
      if (to === undefined) return;
      this.log(`${rec.path} was ${to ? `renamed to ${to}` : 'deleted'} by a commit: its room is closed`);
      this.closeGone(rec, to);
      return;
    }
    const bytes = await readNoFollow(abs);
    if (!isUtf8(bytes)) {
      if (!this.leads(rec)) return;
      rec.dirty = true;
      return this.flushNow(rec);
    }
    const text = bytes.toString('utf8');
    if (blobId(text) === rec.lastHash) return;
    if (!this.leads(rec)) return this.commitOutside(rec, text);
    await this.applyOutside(rec, text);
  }

  /** An edit made outside the app to a file whose room another device leads: an ordinary commit here (0077). */
  private async commitOutside(rec: RoomRecord, text: string): Promise<void> {
    const before = await this.git.run(['show', `${this.refFor(rec.path)}:${rec.path}`], { allowFail: true });
    const was = before.code === 0 ? before.stdout : null;
    rec.previous = rec.type.parse(text);
    rec.lastHash = blobId(text);
    if (was === text) return;
    await this.commitPaths([rec.path], describeEdit(rec.type, rec.path, was, text, []));
    this.log(`outside change to ${rec.path} committed, for the device that leads its room`);
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
      rec.previous = theirs;
      this.applyDoc(rec, theirs.doc, text);
      rec.lastHash = blobId(text);
      if (!quiet) this.broadcast(rec, { type: 'outside-change', at, merged: false });
      this.log(`outside change applied to ${rec.path}`);
      // The room is the file again.
      rec.flushedSv = this.relay.stateVector(rec.room);
      return;
    }
    const base = rec.previous.text;
    const ours = rec.type.serialize(this.current(rec), rec.previous);
    const merged = await this.git.mergeFile(ours, base, text, join(this.cacheDir, '..'));
    rec.previous = theirs;
    rec.lastHash = blobId(text);
    if (!merged.conflict) {
      this.applyDoc(rec, rec.type.parse(merged.text).doc, merged.text);
      if (!quiet) this.broadcast(rec, { type: 'outside-change', at, merged: true });
      this.log(`outside change merged into ${rec.path}`);
    } else {
      await this.saveBeside(rec, text);
    }
    // The room now differs from the file: write it back soon.
    rec.dirty = true;
    await this.flushNow(rec);
  }

  /**
   * Make a document (`text`, parsed) the room's. Open: as a minimal difference,
   * which reaches everyone in its session; only the device that leads it does
   * this (0077), so a change from git is made in the session once. In no
   * session: the text is kept to write, and to start the next session from.
   */
  private applyDoc(rec: RoomRecord, doc: ReturnType<DocumentType['parse']>['doc'], text: string): void {
    if (this.relay.isOpen(rec.room) && this.relay.apply(rec.room, doc)) return;
    rec.state = text === rec.previous.text ? null : encodeDoc(doc);
  }

  /**
   * A document's runs as people see them: the latest of each chunk run here,
   * and those the workspace's other devices published (0058), less those
   * cleared anywhere.
   */
  async runsOf(path: string): Promise<RunRecord[]> {
    const shared = this.peers?.outputs;
    const hidden = shared ? await shared.hidden() : new Set<string>();
    const own = (await this.runner.outputs(path)).filter((r) => !hidden.has(r.id));
    return shared ? [...own, ...(await shared.runs(path))] : own;
  }

  /** Runs of a document waiting or under way: this device's, and other devices' as they tell (0062). */
  async pendingOf(path: string): Promise<RunRecord[]> {
    return [...this.runner.pending(path), ...((await this.peers?.outputs?.pending(path)) ?? [])];
  }

  /** Clear one chunk's outputs, or all of a document's: this device's, and those other devices published (for every device). */
  async clearRuns(path: string, chunk?: ChunkRef): Promise<void> {
    const own = await this.runner.clear(path, chunk);
    // The other devices connected stop showing this device's at once (0062); the rest, once it publishes.
    this.peers?.outputs?.cleared(own);
    const ids = [...own, ...((await this.peers?.outputs?.hide(path, chunk)) ?? [])];
    if (ids.length) this.broadcastPath(path, { type: 'runs-removed', path, ids });
  }

  /** Send a message to everyone with `path` open, on any branch or generation. */
  broadcastPath(path: string, message: RoomMessage): void {
    for (const rec of this.records.values()) if (rec.path === path) this.broadcast(rec, message);
  }

  private broadcast(rec: RoomRecord, message: RoomMessage): void {
    this.relay.broadcast(rec.room, message);
  }

  // -------------------------------------------------------------------------
  // Edits not yet written, while the host is stopped (Unsaved)

  /** Edits to a file kept from when the host last stopped, for this type version; null if none. Also as an older host kept them (a room's state). */
  private async readUnsaved(key: string, type: DocumentType): Promise<Unsaved | null> {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(await readFile(this.unsavedFile(key), 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
    // Removed once written; one of nothing to write (or for another type version), now.
    this.unsaved.add(key);
    const none = async () => {
      await this.removeUnsaved(key);
      return null;
    };
    if (raw.typeId !== type.id || raw.typeVersion !== type.version || typeof raw.text !== 'string') return none();
    let pending: string | null = typeof raw.pending === 'string' ? raw.pending : null;
    // Kept by an older host: its text, not its state (0077).
    if (pending === null && typeof raw.state === 'string') {
      try {
        pending = type.serialize(decodeDoc(Buffer.from(raw.state, 'base64'), type.schema), type.parse(raw.text));
      } catch {
        pending = null;
      }
    }
    const companions = raw.companions && typeof raw.companions === 'object' && !Array.isArray(raw.companions)
      ? Object.fromEntries(Object.entries(raw.companions as Record<string, unknown>).filter(([k, v]) => typeof k === 'string' && (v === null || typeof v === 'string'))) as Record<string, string | null>
      : undefined;
    if (pending === null || (pending === raw.text && !companions)) return none();
    const lastHash = isBlobId(raw.lastHash) ? raw.lastHash : blobId(raw.text);
    return { key, path: String(raw.path), branch: String(raw.branch), typeId: type.id, typeVersion: type.version, lastHash, text: raw.text, pending, baseCommit: typeof raw.baseCommit === 'string' ? raw.baseCommit : null, ...(companions ? { companions } : {}) };
  }

  /** Keep a room's edits not yet written, for the next time the host starts (only while they cannot be written). */
  private async saveUnsaved(rec: RoomRecord): Promise<void> {
    if (!rec.dirty) return;
    const doc = this.current(rec);
    const pending = rec.type.serialize(doc, rec.previous);
    // What features keep beside it (0082), as their companions would be written: kept where it differs from the files.
    const view = this.featureView(rec);
    let companions: Record<string, string | null> | undefined;
    if (view) {
      const current = new Map<string, string | null>();
      for (const c of await this.features.ownFilesOf(rec.path)) current.set(c, await readFile(this.resolvePath(c), 'utf8').catch(() => null));
      for (const [c, { text }] of this.features.companionTexts(rec.path, rec.type, doc, this.parsedOf(rec, doc), view, current, rec.mine)) {
        const now = current.get(c) ?? null;
        if (now !== text) (companions ??= {})[c] = text;
      }
    }
    if (pending === rec.previous.text && !companions) return;
    const entry: Unsaved = { key: rec.key, path: rec.path, branch: rec.branch, typeId: rec.type.id, typeVersion: rec.type.version, lastHash: rec.lastHash, text: rec.previous.text, pending, baseCommit: rec.baseCommit, ...(companions ? { companions } : {}) };
    await this.writeAtomic(this.unsavedFile(rec.key), JSON.stringify(entry));
    this.unsaved.add(rec.key);
  }

  private async removeUnsaved(key: string): Promise<void> {
    if (!this.unsaved.has(key)) return;
    this.unsaved.delete(key);
    await rm(this.unsavedFile(key), { force: true });
  }

  /** Files whose edits were kept (saveUnsaved), or may have been by a host before: removed once written. */
  private readonly unsaved = new Set<string>();

  // -------------------------------------------------------------------------
  // Merging

  /** Start syncing with this workspace's devices (at start, for a shared workspace, or when the first invitation is made). */
  // -------------------------------------------------------------------------
  // The workspace's name (decision 0061)

  /** The workspace's own name, the same on every device (.kuraa/workspace.json); null where it names itself nowhere. */
  sharedName: string | null = null;

  /** What the workspace is called: its own name, else what this device calls it. */
  get name(): string {
    return this.sharedName ?? this.options.label ?? this.workspace;
  }

  /** Read the workspace's name again (a rename here, from another device, or made outside the app), saying so if it changed. */
  async refreshName(): Promise<string | null> {
    const name = await readWorkspaceName(this.dir);
    if (name !== null && name !== this.sharedName) {
      if (this.sharedName !== null) this.log(`the workspace is now called ${name}`);
      this.sharedName = name;
      this.options.onName?.(name);
    }
    return this.sharedName;
  }

  /**
   * Rename the workspace for everyone: its name file, committed, and so synced
   * to every device, like any other change. `by`: who renamed it, credited on
   * the commit. Anyone in the workspace may (every member has the same say, 0038).
   */
  rename(raw: unknown, by?: PresenceUser): Promise<string> {
    return this.serial(async () => {
      let name: string;
      try {
        name = cleanName(raw);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      await this.requireWritable();
      if (name === this.sharedName) return name;
      await writeWorkspaceName(this.dir, name);
      await this.commitPaths([NAME_FILE], `Rename the workspace to “${name}”`, by && by.email ? [by] : []);
      await this.refreshName();
      // Whoever has a file open here sees the new name (as they do a rename from another device).
      for (const rec of this.records.values()) this.broadcast(rec, { type: 'files-changed', at: new Date().toISOString() });
      return name;
    });
  }

  /**
   * Give a workspace that names itself nowhere (made before 0061) the name this
   * device calls it, before it is shared: whoever first invites someone names
   * it, as whoever makes a workspace does now.
   */
  ensureName(): Promise<void> {
    return this.serial(async () => {
      if ((await this.refreshName()) !== null) return;
      await this.requireWritable();
      const name = cleanName(this.options.label ?? this.workspace);
      await writeWorkspaceName(this.dir, name);
      await this.commitPaths([NAME_FILE], `Name the workspace “${name}”`);
      await this.refreshName();
    });
  }

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
    if (!allowed) throw new HttpError(403, 'Making invitations from the app is turned off for this workspace');
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
  async merge(x: string, y: string, space: string | null = null): Promise<MergeOutcome> {
    // Who may change what (0066): judged by the workspace's policy, where it has one (peers/gate.ts), in the history it is (a space's: 0082).
    const g = this.gate ? await this.judgeBoth(x, y, space) : null;
    if (g?.waitFor.length) throw new WaitingForPolicy(g.waitFor);
    return mergeCommits(this.git, x, y, { typeFor: (path, head) => this.mergeTypes.resolve(path, head), tmpDir: this.tmpDir, keeps: g?.keeps, refused: g?.refused, signature: this.mergeSignature });
  }

  /**
   * Judge the new commits on both sides of a merge (gate.ts judges those one
   * side brings the other), whichever side this device is on: every device
   * merging the same two commits keeps out the same changes, and so makes the
   * same merge (0025). A file kept as it was keeps the side whose change was not
   * refused; where both sides' were, it keeps its version where they meet.
   */
  private async judgeBoth(x: string, y: string, space: string | null = null): Promise<GateResult> {
    const [theirs, ours] = await Promise.all([this.gate!(x, y, space), this.gate!(y, x, space)]);
    const waitFor = [...new Set([...theirs.waitFor, ...ours.waitFor])].sort();
    if (waitFor.length) return { keeps: new Map(), refused: [], waitFor };
    const keeps = new Map([...theirs.keeps, ...ours.keeps]);
    const both = [...theirs.keeps.keys()].filter((p) => ours.keeps.has(p));
    if (both.length) {
      const base = (await this.git.run(['merge-base', x, y], { allowFail: true })).stdout.trim();
      for (const path of both) {
        const r = base ? await this.git.run(['rev-parse', '-q', '--verify', `${base}:${path}`], { allowFail: true }) : null;
        keeps.set(path, r?.code === 0 ? r.stdout.trim() : null);
      }
    }
    const refused = [...theirs.refused, ...ours.refused].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.commit < b.commit ? -1 : a.commit > b.commit ? 1 : 0));
    return { keeps, refused, waitFor: [] };
  }

  /** The tree of the merge of two commits as this device makes it, plainly (to check another's merge: peers/gate.ts). */
  async remakeMergeTree(a: string, b: string): Promise<string> {
    const outcome = await mergeCommits(this.git, a, b, { typeFor: (path, head) => this.mergeTypes.resolve(path, head), tmpDir: this.tmpDir });
    return this.git.out(['rev-parse', `${outcome.commit}^{tree}`]);
  }

  /** Judges the commits that `y` brings to `x` by the workspace's write rules (peers/gate.ts), where it syncs with other devices. */
  gate: ((x: string | null, y: string, space?: string | null) => Promise<GateResult>) | null = null;

  /**
   * Where a commit took a room's file, if one did (it is in no file now, and the
   * commit that took it away is in the history): its new path if renamed, else null.
   * Undefined if no commit did (deleted outside git, say).
   */
  private async takenByCommit(path: string): Promise<string | null | undefined> {
    if ((await this.git.run(['cat-file', '-e', `HEAD:${path}`], { allowFail: true })).code === 0) return undefined;
    const commit = (await this.git.run(['log', '-1', '--format=%H', '--diff-filter=D', 'HEAD', '--', path], { allowFail: true })).stdout.trim();
    if (!commit) return undefined;
    const out = await this.git.run(['diff', '--name-status', '-z', '-M', '--diff-filter=R', `${commit}^`, commit], { allowFail: true });
    const parts = out.code === 0 ? out.stdout.split('\0') : [];
    for (let i = 0; i + 2 < parts.length; i += 3) {
      if (parts[i + 1] === path) return parts[i + 2] ?? null;
    }
    return null;
  }

  /**
   * Bring a commit into the current branch: a fast-forward, or a merge made as
   * every device makes it. Open rooms are committed first. Rooms this device
   * leads take the result as an outside change; rooms another device leads
   * (0077) take nothing: their file is git's, as it comes, and the device that
   * leads them brings the change in, once, when it has the commit. Call inside serial().
   */
  async integrate(ref: string): Promise<MergeOutcome> {
    // Not into the middle of someone's rebase or merge: it comes in once that is done.
    await this.requireWritable();
    await this.commitAll();
    const theirs = await this.git.out(['rev-parse', '--verify', `${ref}^{commit}`]);
    const head = await this.git.head();
    const outcome = head ? await this.merge(head, theirs) : { commit: theirs, kind: 'fast-forward' as const, conflicts: [], copies: [] };
    if (outcome.commit !== head) {
      const branch = await this.git.branch();
      const here = [...this.records.values()].filter((r) => r.branch === branch);
      const members = here.filter((r) => !this.leads(r));
      // Rooms with edits not committed (their commit failed): the file put back as committed for the move, and the
      // edits merged with what comes, as an outside change.
      const kept = here.filter((r) => this.leads(r) && r.uncommitted);
      for (const rec of kept) {
        const before = await this.git.run(['show', `HEAD:${rec.path}`], { allowFail: true });
        if (before.code === 0) await this.writeAtomic(this.resolvePath(rec.path), before.stdout);
        else await rm(this.resolvePath(rec.path), { force: true });
        const text = before.code === 0 ? before.stdout : '';
        rec.previous = rec.type.parse(text);
        rec.lastHash = blobId(text);
        rec.dirty = true;
        rec.uncommitted = false;
      }
      const r = await this.git.run(['merge', '--ff-only', '-q', outcome.commit], { allowFail: true });
      if (r.code !== 0) throw new Error(`Could not update the files to ${outcome.commit.slice(0, 7)}: ${(r.stderr || r.stdout).trim()}`);
      for (const rec of members) {
        // Git's change to the file, not an outside edit: seen, and left to the device that leads the room.
        const abs = this.resolvePath(rec.path);
        const now = existsSync(abs) ? await this.readText(abs, rec.path).catch(() => null) : '';
        if (now === null) continue;
        rec.previous = rec.type.parse(now);
        rec.lastHash = blobId(now);
        rec.committedHash = null;
      }
      for (const rec of kept) this.commitSoon(rec.room);
      this.log(`${outcome.kind === 'merge' ? 'merged' : 'moved to'} ${outcome.commit.slice(0, 7)}${outcome.conflicts.length ? ` (conflicts kept in ${outcome.conflicts.map((c) => c.path).join(', ')})` : ''}`);
      await this.checkAll();
      // The rooms this device leads hold the commit now: the others in their sessions build on it.
      for (const rec of here) {
        if (members.includes(rec) || this.records.get(rec.key) !== rec) continue;
        this.noteBase(rec, outcome.commit);
        if (rec.session) this.peers?.rooms.committed(rec.room);
      }
      this.refsChanged();
      // The workspace may have been renamed on another device.
      await this.refreshName();
      // Features (0082): their choices may have changed, and companions follow documents renamed elsewhere.
      const changed = head && this.features.inUse() ? (await this.git.run(['diff', '--name-only', '-z', head, outcome.commit], { allowFail: true })).stdout.split('\0').filter(Boolean) : [];
      if (changed.includes(FEATURES_FILE) || changed.includes(COMPANIONS_FILE)) {
        await this.features.refresh();
        await this.seedOpenRooms();
      }
      await this.followRenamedDocuments(changed).catch((e) => this.log(`could not move what is kept beside renamed documents: ${(e as Error).message}`));
      void this.features.emit('merge', { from: head, to: outcome.commit, paths: changed });
      // The files may have changed: everyone with something open reloads the list (and the workspace's name).
      for (const rec of this.records.values()) this.broadcast(rec, { type: 'files-changed', at: new Date().toISOString() });
    }
    return outcome;
  }

  // -------------------------------------------------------------------------
  // Rooms, as other devices see them (peers/rooms.ts, 0077)

  get sessionRelay(): Relay {
    return this.relay;
  }

  /** A room's key among devices: branch, path and type version (its session is told apart). */
  private roomKey(rec: RoomRecord): string {
    return `${rec.branch}\0${rec.path}\0${rec.type.id}@${rec.type.version}`;
  }

  roomView(name: string): RoomView | undefined {
    const rec = this.byRoom.get(name);
    return rec && { name: rec.room, key: this.roomKey(rec), session: rec.session, leading: this.leads(rec), path: rec.path, branch: rec.branch, base: rec.baseCommit };
  }

  /** Rooms in a session, open here. */
  liveRooms(): RoomView[] {
    return [...this.records.values()].filter((r) => r.session && this.relay.isOpen(r.room)).map((r) => this.roomView(r.room)!);
  }

  /** The room in a session, open here, with this key among devices, if any. */
  liveRoom(key: string): RoomView | undefined {
    for (const r of this.records.values()) if (r.session && this.roomKey(r) === key && this.relay.isOpen(r.room)) return this.roomView(r.room);
    return undefined;
  }

  /** A room's text as it is now. */
  roomText(name: string): string | undefined {
    const rec = this.byRoom.get(name);
    return rec && rec.type.serialize(this.current(rec), rec.previous);
  }

  /** The commit a room's text was last based on (where it started, its last commit or a merge brought in). */
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

  /** Commit a room after a wait (the usual one, or `ms`). */
  commitSoon(name: string, ms = this.timings.idleCommitMs): void {
    const rec = this.byRoom.get(name);
    if (!rec || (!rec.uncommitted && !rec.dirty)) return;
    if (rec.timers.commit) clearTimeout(rec.timers.commit);
    rec.timers.commit = setTimeout(() => void this.commitRoom(rec).catch((e) => this.log(`commit failed: ${e}`)), ms);
  }

  /** A commit the room holds, as the device that leads its session says (it left, or committed): the next to lead builds on it. */
  roomHolds(name: string, commit: string): void {
    const rec = this.byRoom.get(name);
    if (rec && /^[0-9a-f]{40,64}$/.test(commit)) this.noteBase(rec, commit);
  }

  private noteBase(rec: RoomRecord, commit: string | null): void {
    if (!commit) return;
    rec.baseCommit = commit;
    if (rec.bases.at(-1) !== commit) rec.bases = [...rec.bases.filter((b) => b !== commit), commit].slice(-8);
  }

  /** The room's session is now another (a fork: the same document, apart from those this device no longer hears). */
  setSession(name: string, session: string): void {
    const rec = this.byRoom.get(name);
    if (rec?.session) rec.session = session;
  }

  /**
   * Whether this device may lead a room's session now changed (peers/rooms.ts).
   * Given up (a device with a lower key came into it): its text is written and
   * committed a last time, and the others are told on what to build. Taken
   * (the one before left, or is gone): takeOver.
   */
  leadingChanged(name: string, may: boolean): void {
    const rec = this.byRoom.get(name);
    if (!rec?.session) return;
    if (may) {
      if (rec.leading) return;
      rec.waitingSince ??= Date.now();
      void this.takeOver(rec).catch((e) => this.log(`could not take ${rec.path}'s room over: ${e}`));
      return;
    }
    if (rec.timers.lead) clearTimeout(rec.timers.lead);
    rec.timers.lead = undefined;
    rec.waitingSince = null;
    if (!rec.leading) return;
    void this.serial(async () => {
      if (!rec.leading || this.peers?.rooms.mayLead(rec.room)) return;
      try {
        await this.flushNow(rec);
        await this.commitNow(rec);
      } catch (e) {
        this.log(`could not save ${rec.path} before handing it over: ${(e as Error).message}`);
      }
      rec.leading = false;
      for (const k of ['flush', 'commit', 'max', 'retry'] as const) {
        if (rec.timers[k]) clearTimeout(rec.timers[k]);
        rec.timers[k] = undefined;
      }
      rec.editingSince = null;
      this.peers?.rooms.handedOver(rec.room);
    }).catch((e) => this.log(`could not hand ${rec.path} over: ${e}`));
  }

  /**
   * Begin to lead a room's session (the one before left it, or is gone): on the
   * newest commit the room holds that is here (waiting a while for the last the
   * one before made, which may be on its way). What the file has beyond that
   * commit (others' work brought in by git while another led, an edit made
   * outside the app) is brought into the room, as the leader does; then its
   * text is written, and committed after the usual wait.
   */
  private takeOver(rec: RoomRecord): Promise<void> {
    return this.serial(async () => {
      if (rec.timers.lead) clearTimeout(rec.timers.lead);
      rec.timers.lead = undefined;
      if (rec.leading || !rec.session || this.byRoom.get(rec.room) !== rec || !this.relay.isOpen(rec.room) || !this.peers?.rooms.mayLead(rec.room)) return;
      const again = () => {
        rec.timers.lead = setTimeout(() => void this.takeOver(rec).catch((e) => this.log(`could not take ${rec.path}'s room over: ${e}`)), 200);
      };
      const st = await this.readGitState();
      if (pausedBecause(st) || st.branch !== rec.branch) return again();
      const head = await this.git.head();
      let base: string | null = null;
      for (const b of [...rec.bases].reverse()) {
        if (head && (b === head || (await isAncestor(this.git, b, head)))) {
          base = b;
          break;
        }
      }
      if (base !== (rec.bases.at(-1) ?? null) && Date.now() - (rec.waitingSince ?? 0) < LEAD_WAIT_MS) return again();
      rec.leading = true;
      rec.waitingSince = null;
      const at = base ? await this.git.run(['show', `${base}:${rec.path}`], { allowFail: true }) : null;
      const baseText = at?.code === 0 ? at.stdout : null;
      const abs = this.resolvePath(rec.path);
      const bytes = existsSync(abs) ? await readNoFollow(abs) : null;
      const disk = bytes && isUtf8(bytes) ? bytes.toString('utf8') : null;
      this.log(`leading ${rec.path}'s session now`);
      rec.dirty = true;
      rec.committedHash = null;
      if (baseText !== null && disk !== null && disk !== baseText) {
        rec.previous = rec.type.parse(baseText);
        rec.lastHash = blobId(baseText);
        await this.applyOutside(rec, disk, true);
      } else {
        if (disk !== null) {
          rec.previous = rec.type.parse(disk);
          rec.lastHash = blobId(disk);
        }
        await this.flushNow(rec);
      }
      if (base) this.noteBase(rec, base);
      this.commitSoon(rec.room, this.timings.flushMs);
    });
  }

  /** The room as last committed, if nothing has been written since: the commit, and how far the room's edits went then. */
  async committedOf(name: string): Promise<{ commit: string; sv: Uint8Array } | null> {
    const rec = this.byRoom.get(name);
    if (!rec?.flushedSv || !this.leads(rec) || rec.dirty || rec.uncommitted || rec.committedHash !== rec.lastHash) return null;
    const r = await this.git.run(['rev-parse', '-q', '--verify', `refs/heads/${rec.branch}`], { allowFail: true });
    return r.code === 0 ? { commit: r.stdout.trim(), sv: rec.flushedSv } : null;
  }

  /** A named version of a room this device leads, asked for by another device in its session. */
  async namedVersion(name: string, message: string): Promise<string | null> {
    const rec = this.byRoom.get(name);
    return rec && rec.leading ? this.commitRoom(rec, message) : null;
  }

  /** Write and commit a room now, if this device leads it (one moving to another session: rooms.ts). */
  async settleRoom(name: string): Promise<void> {
    const rec = this.byRoom.get(name);
    if (!rec || !this.leads(rec)) return;
    await this.serial(async () => {
      await this.flushNow(rec);
      await this.commitNow(rec);
    });
  }

  /**
   * Move a room to another device's session of the file (0077: two sessions
   * never combine; the one whose leader has the higher key gives way, once the
   * other holds all of it): its people move to the new room, and edits of theirs
   * not yet here are carried across by the app. Only while `ready` (nothing in
   * this session that is not in a commit the other holds); else false.
   */
  async switchRoom(name: string, session: string, state: Uint8Array, base: string | null, ready: () => boolean): Promise<boolean> {
    return this.serial(async () => {
      const rec = this.byRoom.get(name);
      if (!rec?.session || !this.relay.isOpen(name) || rec.dirty && this.leads(rec) || !ready()) return false;
      const old = rec.room;
      this.byRoom.delete(old);
      rec.generation = newId();
      rec.room = this.roomName(rec);
      rec.session = session;
      rec.state = state;
      rec.leading = false;
      rec.dirty = false;
      rec.flushedSv = null;
      rec.waitingSince = null;
      for (const k of ['flush', 'commit', 'max', 'lead'] as const) {
        if (rec.timers[k]) clearTimeout(rec.timers[k]);
        rec.timers[k] = undefined;
      }
      rec.editingSince = null;
      rec.bases = [];
      this.noteBase(rec, base);
      this.byRoom.set(rec.room, rec);
      this.log(`moved ${rec.path} to another device's session of it`);
      this.relay.broadcast(old, { type: 'reseeded', at: new Date().toISOString(), room: rec.room });
      this.relay.closeRoom(old);
      this.relay.release(old);
      this.scheduleDrop(rec);
      return true;
    });
  }

  /**
   * Bring a commit into a branch, as every device merges: the checked-out one
   * through the working tree (integrate), others by their ref alone, made here
   * if this repository lacks them. Call inside serial().
   */
  async bringBranch(branch: string, ref: string): Promise<MergeOutcome> {
    if (branch === (await this.git.branch())) return this.integrate(ref);
    const oid = await this.git.out(['rev-parse', '--verify', `${ref}^{commit}`]);
    const mine = (await this.git.run(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true })).stdout.trim();
    if (!mine) {
      await this.git.run(['update-ref', `refs/heads/${branch}`, oid, '']);
      this.refsChanged();
      return { commit: oid, kind: 'fast-forward', conflicts: [], copies: [] };
    }
    const outcome = await this.merge(mine, oid);
    if (outcome.commit !== mine) {
      await this.git.run(['update-ref', `refs/heads/${branch}`, outcome.commit, mine]);
      this.refsChanged();
    }
    return outcome;
  }

  /**
   * Bring another device's history of a space in (0066): onto this device's
   * history of it on that branch, as branches are (a merge, judged by the write
   * rules), and the space's files that changed into the working tree, if it is
   * the branch checked out. Call inside serial().
   */
  async bringSpace(id: string, branch: string, ref: string): Promise<MergeOutcome> {
    const theirs = await this.git.out(['rev-parse', '--verify', `${ref}^{commit}`]);
    const own = spaceRef(id, branch);
    const mine = (await this.git.run(['rev-parse', '-q', '--verify', `${own}^{commit}`], { allowFail: true })).stdout.trim();
    const current = (await this.git.branch()) === branch;
    if (current) {
      await this.requireWritable();
      await this.commitAll();
    }
    // What the working tree has of the space now (its branch, or the one it is read from).
    const readNow = current && this.spaces.refOf(id) ? (await this.git.run(['rev-parse', '-q', '--verify', `${this.spaces.refOf(id)}^{commit}`], { allowFail: true })).stdout.trim() : '';
    const base = mine || readNow;
    if (!base && this.gate) {
      // A space's history arriving here for the first time is judged too (0071): taken whole, or not at all.
      const g = await this.gate(null, theirs, id);
      if (g.waitFor.length) throw new WaitingForPolicy(g.waitFor);
      if (g.refused.length) throw new NotBrought(`holds changes not its makers’ to make (${[...new Set(g.refused.map((r) => r.path))].join(', ')}): not brought in`);
    }
    const outcome = base ? await this.merge(base, theirs, id) : { commit: theirs, kind: 'fast-forward' as const, conflicts: [], copies: [] };
    if (outcome.commit === mine) return outcome;
    await this.git.run(['update-ref', '-m', `bring in a space's ${branch}`, own, outcome.commit, mine]);
    if (current) {
      for (const c of await this.spaces.changes(readNow || null, outcome.commit)) {
        // A file the workspace's own branch has stays the workspace's (spaces.ts).
        if ((await this.git.run(['cat-file', '-e', `HEAD:${c.path}`], { allowFail: true })).code === 0) continue;
        const abs = this.resolvePath(c.path);
        if (c.blob) {
          await mkdir(dirname(abs), { recursive: true });
          await this.writeAtomic(abs, (await this.git.run(['cat-file', 'blob', c.blob])).bytes);
        } else {
          await rm(abs, { force: true });
        }
      }
      await this.spaces.refresh(branch);
      await this.checkAll();
      for (const rec of this.records.values()) this.broadcast(rec, { type: 'files-changed', at: new Date().toISOString() });
    }
    this.refsChanged();
    return outcome;
  }

  /**
   * Move a file to a space (or, null, to the workspace's own files) (0066): out
   * of where it is, as a commit there (its history stays there, with those who
   * read it then), and into the other, as it is now.
   */
  async moveToSpace(path: string, target: string | null): Promise<void> {
    if (!this.peers) throw new Error('Spaces are for a workspace shared with other devices');
    // What is kept beside a document goes where it goes (0082).
    // Only this person's own: others' are theirs to move (0082), and stay where those who read the document could read them.
    for (const p of [path, ...(await this.features.ownFilesOf(path))]) await this.moveOneToSpace(p, target);
  }

  private async moveOneToSpace(path: string, target: string | null): Promise<void> {
    await this.serial(async () => {
      await this.requireWritable();
      await this.commitAll();
      const branch = await this.git.branch();
      if (!branch) throw new Error('No branch is checked out');
      const from = this.spaces.spaceOf(path);
      if (from === target) return;
      const abs = this.resolvePath(path);
      const bytes = await readFile(abs);
      const policy = await this.policyTrailer();
      const message = (what: string) => withTrailers(what, [], policy);
      if (from) await this.spaces.commit(from, branch, [{ path, content: null }], message(`Move ${path} to ${target ? 'another audience' : 'everyone in the workspace'}`), (raw) => this.signRaw(raw));
      else await this.commitRemoval(path, message(`Move ${path} to a narrower audience`));
      if (target) await this.spaces.commit(target, branch, [{ path, content: bytes }], message(`Move ${path} here`), (raw) => this.signRaw(raw));
      await this.spaces.refresh(branch);
      if (!target) await this.commitPaths([path], message(`Move ${path} to everyone in the workspace`));
      this.refsChanged();
      for (const rec of this.records.values()) this.broadcast(rec, { type: 'files-changed', at: new Date().toISOString() });
    });
  }

  /**
   * A rename or move of files in spaces (0069): each stays in its space, at its
   * new path (taken away at the old one), as a commit there. Before the
   * workspace's own commit of the move, which then leaves them be. Call inside serial().
   */
  async carrySpaces(from: string, to: string, isFolder: boolean): Promise<void> {
    const moved = this.spaces?.entries().filter(([p]) => (isFolder ? p.startsWith(`${from}/`) : p === from)) ?? [];
    if (!moved.length) return;
    const branch = await this.git.branch();
    if (!branch) return;
    const bySpace = new Map<string, { path: string; content?: null }[]>();
    for (const [p, id] of moved) {
      const next = isFolder ? `${to}/${p.slice(from.length + 1)}` : to;
      bySpace.set(id, [...(bySpace.get(id) ?? []), { path: p, content: null }, { path: next }]);
    }
    const message = withTrailers(isFolder ? `Move ${from}/ to ${to}/` : `Rename ${from} to ${to}`, [], await this.policyTrailer());
    for (const [id, changes] of bySpace) await this.spaces.commit(id, branch, changes, message, (raw) => this.signRaw(raw));
    await this.spaces.refresh(branch);
    this.refsChanged();
  }

  /** Commit new files into a space (0069: made in a folder fewer read), never onto the workspace's own branch. Call inside serial(). */
  async commitIntoSpace(id: string, paths: string[], message: string): Promise<string | null> {
    await this.requireWritable();
    const branch = await this.git.branch();
    if (!branch) throw new Error('No branch is checked out');
    const commit = await this.spaces.commit(id, branch, paths.map((path) => ({ path })), withTrailers(message, [], await this.policyTrailer()), (raw) => this.signRaw(raw));
    await this.spaces.refresh(branch);
    this.refsChanged();
    if (commit) this.log(`committed ${commit.slice(0, 7)} ${message} (in a space)`);
    return commit;
  }

  /** Take a file out of the workspace's own branch, as a signed commit, leaving it in the working tree (for a space to take). */
  private async commitRemoval(path: string, message: string): Promise<void> {
    const head = await this.git.head();
    if (!head) return;
    await mkdir(this.tmpDir, { recursive: true });
    const env = { GIT_INDEX_FILE: join(this.tmpDir, `remove-index-${process.pid}-${randomBytes(4).toString('hex')}`) };
    let tree: string;
    try {
      await this.git.run(['read-tree', head], { env });
      await this.git.run(['update-index', '--force-remove', '--', path], { env });
      tree = await this.git.out(['write-tree'], { env });
    } finally {
      await rm(env.GIT_INDEX_FILE, { force: true });
    }
    if (tree === (await this.git.out(['rev-parse', `${head}^{tree}`]))) return;
    const unsigned = await this.git.out(['commit-tree', tree, '-p', head, '-F', '-'], { input: `${message.trimEnd()}\n` });
    const raw = (await this.git.run(['cat-file', 'commit', unsigned])).bytes;
    const commit = await this.git.out(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: await this.signRaw(raw) });
    await this.git.run(['update-ref', '-m', `commit: ${message.split('\n')[0]}`, 'HEAD', commit, head]);
    await this.git.run(['rm', '--cached', '-q', '--ignore-unmatch', '--', path], { allowFail: true });
    this.log(`committed ${commit.slice(0, 7)} ${message.split('\n')[0]}`);
  }

  /** Bring an online copy's branches in, as fetched (SyncContext.bringIn): what the merge into the open branch kept, to say. */
  async bringInFrom(name: string): Promise<string> {
    const prefix = `refs/remotes/${name}/`;
    const refs = (await this.git.out(['for-each-ref', '--format=%(refname)', prefix])).split('\n').filter((r) => r && r !== `${prefix}HEAD`);
    return this.serial(async () => {
      const current = await this.git.branch();
      let said = '';
      for (const ref of refs) {
        const branch = ref.slice(prefix.length);
        const outcome = await this.bringBranch(branch, ref);
        if (branch === current) said = `/${branch}${describeOutcome(outcome)}`;
      }
      return said;
    });
  }

  /**
   * Sync: commit, then bring in the work of connected devices, and sync with the
   * online copies. Says how many commits came in (`brought`, merges left out)
   * and how many conflicts their merges kept, for the app to say in words.
   */
  async syncNow(): Promise<{ ok: boolean; message: string; head?: string | null; brought?: number; conflicts?: number }> {
    await this.serial(() => this.commitAll());
    const before = await this.git.head();
    const said: string[] = [];
    let ok = true;
    if (this.peers) said.push(await this.peers.syncAll());
    for (const { session } of this.syncs.values()) {
      if (!(await session.names()).length) continue;
      const r = await session.syncAll();
      ok &&= r.ok;
      said.push(...r.messages);
    }
    if (!said.length) return { ok: false, message: 'There is no online copy, and no other device to sync with.' };
    const head = await this.git.head();
    let brought = 0;
    if (head && head !== before) {
      const range = before ? [`${before}..${head}`] : [head];
      const r = await this.git.run(['rev-list', '--count', '--no-merges', ...range], { allowFail: true });
      brought = r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
    }
    const conflicts = said.reduce((n, m) => n + [...m.matchAll(/(\d+) conflicts? kept/g)].reduce((k, x) => k + Number(x[1]), 0), 0);
    return { ok, message: said.join('. '), head, brought, conflicts };
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
   * empty, and its header can be edited. Throws an HttpError (400) if not. `as`:
   * the path it will have, when a rename makes it another kind of file (a text
   * file becoming a document, given its first title).
   */
  async checkTitle(path: string, title: string, as = path): Promise<void> {
    const type = this.typeFor(as);
    if (!type?.title) throw new HttpError(400, `${as} is not a document with a title`);
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
  /**
   * Set fields of a Markdown document's header (0096: a corkboard's synopsis,
   * an outline's status), open or not: written to the file, and where it is
   * open, the room takes it (everyone sees it at once). Not committed here.
   */
  async setHeader(path: string, fields: Record<string, unknown>): Promise<boolean> {
    if (!/\.(md|markdown|qmd|rmd)$/i.test(path) || !this.typeFor(path)) throw new HttpError(400, `${path} is not a document with a header`);
    const rec = this.records.get(`${await this.git.branch()}:${path}`);
    if (rec) await this.flushNow(rec);
    const abs = this.resolvePath(path);
    const text = await this.readText(abs, path);
    let next: string;
    try {
      next = withHeaderFields(text, fields);
    } catch (e) {
      throw new HttpError(409, (e as Error).message);
    }
    if (next === text) return false;
    await this.writeAtomic(abs, next);
    if (rec) await this.applyOutside(rec, next, true);
    return true;
  }

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

  /**
   * Close a file's room and forget its cache (before a rename or delete): saved
   * first, and whoever has it open is told where it went (`to`, null if deleted).
   */
  async dropRoom(path: string, to: string | null = null): Promise<void> {
    const branch = await this.git.branch();
    const key = `${branch}:${path}`;
    const rec = this.records.get(key);
    if (rec) {
      await this.flushNow(rec);
      await this.commitNow(rec);
      this.closeGone(rec, to);
    }
    this.unsaved.add(key);
    await this.removeUnsaved(key);
  }

  /** Close the rooms of every open file under a folder (before the folder moves to `to`, or is deleted). */
  async dropRoomsUnder(folder: string, to: string | null = null): Promise<void> {
    const prefix = `${folder.replace(/\/+$/, '')}/`;
    const paths = [...new Set([...this.records.values()].map((r) => r.path).filter((p) => p.startsWith(prefix)))];
    for (const p of paths) await this.dropRoom(p, to === null ? null : `${to.replace(/\/+$/, '')}/${p.slice(prefix.length)}`);
  }

  /**
   * A room whose file is gone (renamed to `to`, or deleted): its people told,
   * its session left, and the room closed, never written again. Its file must
   * not come back from it: a room left open would write the old path again on
   * its next save, and a new file given the old name would join its session.
   */
  private closeGone(rec: RoomRecord, to: string | null): void {
    this.broadcast(rec, { type: 'gone', at: new Date().toISOString(), to });
    this.clearTimers(rec);
    // Its session left here: the other devices are told.
    if (rec.session) this.peers?.rooms.left(this.roomKey(rec), rec.baseCommit);
    this.relay.closeRoom(rec.room);
    this.records.delete(rec.key);
    this.byRoom.delete(rec.room);
    this.relay.release(rec.room);
  }

  /**
   * Words written each day from `since` (YYYY-MM-DD), by person (0094): the
   * branch's history, and what is typed in documents open here and not
   * committed yet, credited to whoever typed it.
   */
  async wordsByDay(since: string): Promise<DayWords[]> {
    this.wordLog ??= new WordLog({ git: this.git, isCompanion: (p) => this.features.documentOf(p) !== null });
    const branch = await this.git.branch();
    const uncommitted: Uncommitted[] = [];
    for (const rec of this.records.values()) {
      if (rec.branch !== branch || !rec.contributors.size || !/\.(md|markdown|qmd|rmd)$/i.test(rec.path)) continue;
      const before = await this.git.run(['show', `HEAD:${rec.path}`], { allowFail: true });
      uncommitted.push({
        before: before.code === 0 ? before.stdout : null,
        after: rec.type.serialize(this.current(rec), rec.previous),
        people: [...rec.contributors.values()].map((u) => ({ name: u.name, email: u.email })),
      });
    }
    return this.wordLog.days(since, uncommitted);
  }

  /** A document's open room, if it has one, written to its file and committed, to be rendered as it is now. */
  private async writeForRender(path: string): Promise<void> {
    // Not while git is busy outside the app: the file may be half-way through it.
    await this.requireWritable();
    const rec = this.records.get(`${await this.git.branch()}:${path}`);
    // Written and committed (where this device leads the room), so the commit it is rendered from holds it (0081).
    if (rec) {
      await this.serial(async () => {
        await this.flushNow(rec);
        await this.commitNow(rec);
      });
    }
  }

  /**
   * What a folder's book could have (0093: '' the top level): its folders and
   * the documents a book is made of, all of them (nothing left out), in the
   * file tree's order, each at how deep it is (1: in the folder itself), with
   * its title or name, for Compile's outline.
   */
  async bookContents(folder: string): Promise<{ kind: 'folder' | 'document'; path: string; title: string; depth: number; words?: number }[]> {
    const paths = await this.listFiles();
    const entries = (await this.treeEntries(paths, await this.git.branch())).filter((e) => !this.features.documentOf(e.path));
    const titles = new Map(entries.map((e) => [e.path, e.title ?? null]));
    const out = [];
    for (const i of bookItems(folder, entries, await readOrders(this, paths), [])) {
      // A document's words (0094), as its file has them.
      const words = i.kind === 'document' ? markdownWords(await readFile(this.resolvePath(i.path), 'utf8').catch(() => '')) : undefined;
      out.push({ kind: i.kind, path: i.path, title: i.kind === 'folder' ? i.name : titles.get(i.path) || basename(i.path), depth: i.level, ...(words !== undefined ? { words } : {}) });
    }
    return out;
  }

  /**
   * A folder compiled (0093: '' the top level): its documents in the file
   * tree's order, but those left out, each as it is now (its open room written
   * first), joined into one Markdown document; with the folders they are in,
   * where what they refer to is found. A string says why there is nothing.
   */
  async compileFolder(folder: string, o: { exclude: string[]; noHeading: string[]; title: string }): Promise<{ text: string; resources: string[] } | string> {
    const paths = await this.listFiles();
    const entries = (await this.treeEntries(paths, await this.git.branch())).filter((e) => !this.features.documentOf(e.path));
    const orders = await readOrders(this, paths);
    const items = bookItems(folder, entries, orders, o.exclude, o.noHeading);
    const docs = items.flatMap((i) => (i.kind === 'document' ? [i.path] : []));
    if (!docs.length) return `${folder ? `${folder}/` : 'The workspace'} has no documents to compile${o.exclude.length ? ' that are not left out' : ''}.`;
    const titles = new Map(entries.map((e) => [e.path, e.title ?? null]));
    const parts: BookPart[] = [];
    for (const i of items) {
      if (i.kind === 'folder') {
        parts.push(i);
        continue;
      }
      await this.writeForRender(i.path);
      parts.push({ kind: 'document', level: i.level, title: titles.get(i.path) ?? null, text: await readFile(this.resolvePath(i.path), 'utf8') });
    }
    const resources = [...new Set(docs.map((p) => resolve(this.dir, p, '..')))];
    return { text: joinBook(o.title, parts), resources };
  }

  /** The workspace's files this device holds: git's, untracked ones as .gitignore leaves them, and those of the spaces it holds. */
  async listFiles(): Promise<string[]> {
    const out = await this.git.out(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    const spaced = this.spaces.entries().map(([p]) => p).filter((p) => existsSync(join(this.dir, p)));
    return [...new Set([...out.split('\0').filter(Boolean), ...spaced])].sort();
  }

  /**
   * Companions whose documents a merge renamed (0082), made where the feature
   * was not there to move them (another app, an older host): moved to their
   * documents' new names, as a commit of this device's. A companion whose
   * document was deleted is left, and shows in the file list on its own. Call inside serial().
   */
  private async followRenamedDocuments(changed: string[]): Promise<void> {
    const moves: [string, string][] = [];
    for (const p of changed) {
      if (this.features.documentOf(p) || existsSync(this.resolvePath(p, { link: 'self' }))) continue;
      // Everyone's files go: moved, unchanged, which anyone may (the gate takes a move of someone's own file).
      const left = await this.features.filesOf(p);
      if (!left.length) continue;
      const to = await this.takenByCommit(p);
      if (!to) continue;
      for (const c of left) {
        const next = `${to}${c.slice(p.length)}`;
        if (!existsSync(this.resolvePath(next))) moves.push([c, next]);
      }
    }
    if (!moves.length) return;
    for (const [from, to] of moves) {
      await mkdir(dirname(this.resolvePath(to)), { recursive: true });
      await renameOver(this.resolvePath(from), this.resolvePath(to));
      await this.carrySpaces(from, to, false);
    }
    await this.commitPaths(moves.flat(), moves.length === 1 ? `Move ${moves[0]![0]} with its document` : `Move ${moves.length} files with their documents`);
  }

  /** Whether an edit from another device (`via>origin`, or the device itself) was made on one of this host's person's devices. */
  private ownDevice(peer: string): boolean {
    const [via, origin] = peer.split('>');
    const me = this.features.person();
    return !!me && !!this.peers && this.peers.node.personOfDevice(origin || via || '') === me;
  }

  /** What features (features.ts) are given of the host: as little as they need. */
  private featurePort(): import('./features.js').FeaturePort {
    return {
      log: (m) => this.log(m),
      serial: (fn) => this.serial(fn),
      requireWritable: () => this.requireWritable(),
      resolvePath: (p) => this.resolvePath(p),
      writeAtomic: async (abs, text) => {
        await mkdir(dirname(abs), { recursive: true });
        await this.writeAtomic(abs, text);
      },
      commitPaths: (paths, message, by) => this.commitPaths(paths, message, by ?? []),
      commitIntoSpace: (id, paths, message) => this.commitIntoSpace(id, paths, message),
      spaceOf: (p) => this.spaceOf(p),
      canWrite: async (p) => (this.peers ? (await this.peers.access(p)).canWrite : true),
      list: () => this.listFiles(),
      tell: (feature, message, path) => {
        const m: RoomMessage = { type: 'feature', feature, message, path };
        if (path) this.broadcastPath(path, m);
        else for (const rec of this.records.values()) this.broadcast(rec, m);
      },
      roomOpen: (p) => [...this.records.values()].some((r) => r.path === p && !!this.relay && this.relay.isOpen(r.room)),
      person: async () => (this.peers ? (await this.peers.node.policy()).me : (await (await import('./peers/person.js')).readPerson())?.id ?? null),
    };
  }

  /** Public view of a room for the HTTP API. */
  describe(rec: RoomRecord) {
    return {
      room: rec.room,
      path: rec.path,
      branch: rec.branch,
      type: rec.type.id,
      generation: rec.generation,
      session: rec.session,
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
/** Work names a policy this device does not hold yet (peers/gate.ts): it is brought in once the policy has come. */
export class WaitingForPolicy extends Error {
  constructor(readonly heads: string[]) {
    super(`waiting for the workspace's policy (${heads.map((h) => h.slice(0, 8)).join(', ')}) before bringing this work in`);
  }
}

/** Work another device has that is not brought in as it is, nor tried again until it changes (0071): a space's history whose first commits are refused. */
export class NotBrought extends Error {}

function withTrailers(message: string, coAuthors: PresenceUser[], extra: string[]): string {
  const trailers = coAuthors
    .filter((u) => u.email)
    .map((u) => `Co-authored-by: ${u.name.replace(/[<>\n]/g, '')} <${u.email.replace(/[<>\n\s]/g, '')}>`);
  const unique = [...new Set([...trailers, ...extra])];
  return unique.length ? `${message}\n\n${unique.join('\n')}` : message;
}

/** Whether a string is a blob id, as blobId makes. */
const isBlobId = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{40}$/.test(s);

/** A text's git blob id, as `git hash-object` gives it. */
export function blobId(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}

/** A new session's id, or a room's generation (0077): random. */
function newId(): string {
  return randomBytes(8).toString('hex');
}

/** A room as other devices know it. */
export interface RoomView {
  /** Its name here (for the relay). */
  name: string;
  /** Branch, path and type version: the same on every device. */
  key: string;
  /** The session it is in (0077); null: none. */
  session: string | null;
  path: string;
  branch: string;
  /** Whether this device leads its session (or it is in none). */
  leading: boolean;
  /** The newest commit whose text it holds. */
  base: string | null;
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
  /** A companion (0082): the document it is kept beside, which the file list shows it with. */
  of?: string;
}

/** Two of these paths differ in case alone: a rename in case (drama to Drama). */
function caseRename(paths: string[]): boolean {
  const seen = new Set<string>();
  for (const p of new Set(paths)) {
    if (seen.has(p.toLowerCase())) return true;
    seen.add(p.toLowerCase());
  }
  return false;
}
