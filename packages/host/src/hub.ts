// A hub: one server, one address and token, for workspaces (see
// docs/decisions/0029-hub.md and 0030-one-kind-of-server.md). Every server is
// one: `kuraa-host --workspaces <folder>` holds many and lets people add more;
// `kuraa-host --dir <folder>` holds that one folder, and nothing is added.
//
// The hub runs a host for each of its workspaces, inside this process, each on
// a loopback port of its own, and passes `/w/<id>/…` to it (HTTP and the
// WebSocket alike), so a workspace's client talks to `<hub>/w/<id>` exactly as it
// would to a host of its own. The hub's own API, under `/hub/api`, lists the
// workspaces and adds them: a new folder (made a git repository), or a
// workspace joined from an invitation or subscription link.
//
// New workspaces go in one folder: --workspaces, else the owner's setting (by
// default Kuraa Workspaces, in the home folder: never one a cloud storage
// service keeps, 0103). People may invite others to its workspaces from the
// app (invitations and subscription links), which turns syncing on for that
// workspace. A workspace syncs once it is shared (joined, invited from, forked:
// its repository has a workspace id and secret, peers/identity.ts), and always
// from then on; one on this computer alone has nothing to sync with (0048).
//
// Whoever has the access code of a hub listening only on this computer is its
// owner (decision 0047): they change its settings (settings.ts), which the hub
// applies by reopening every workspace, open any folder on the computer as a
// workspace, browse its folders to choose one, manage their identity and the
// online copy. On a hub open to the network those are off, and the app says why.
//
// The hub answers as soon as it listens, and its workspaces open meanwhile, each
// on its own (0103): one slow to open (its folder kept by a cloud service, say)
// holds up only itself. The list says which are still opening, and a request to
// one waits for it.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { cp, lstat, mkdir, open as openFile, readdir, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { standardTypes } from '@kuraa/formats';
import { DEFAULT_POLICY } from '@kuraa/run-kit';
import { DEFAULT_TIMINGS, type HostOptions } from './host.js';
import { HttpError } from './errors.js';
import { Git } from './git.js';
import { renameOver, reservedName } from './files.js';
import { serialQueue } from './serial.js';
import { localUrl, readBody, sameToken, send, serveStaticFrom, tokenOf } from './http.js';
import { corsHeaders, gateFor, hostAllowed, isLoopback, refuseHost, upgradeAllowed, type RequestGate } from './origins.js';
import { cleanName, initWorkspace, inspectFolder, readWorkspaceName } from './workspace.js';
import type { PeerOptions } from './peers/peers.js';
import type { KeyPair } from './keys.js';
import type { JoinProgress } from './peers/join.js';
import type { PeerNode } from './peers/node.js';
import { decodeLink } from './peers/identity.js';
import { startHost, joinWorkspace, type RunningHost } from './index.js';
import { loadRunComponents } from './components.js';
import type { RunOptions } from './runner.js';
import { fromSettings, type SettingsStore, type SettingsView } from './settings.js';
import { cloudService } from './cloud.js';

/** Where new workspaces go unless the settings or --workspaces say: in the home folder, which no cloud service keeps (0103). */
export const defaultWorkspacesFolder = (): string => join(homedir(), 'Kuraa Workspaces');

export interface HubOptions {
  /**
   * Where new workspaces are made, one folder each (--workspaces). Not with
   * `folder`. Without either, the settings' folder for new workspaces, else `defaultRoot`.
   */
  root?: string;
  /** Where new workspaces go when neither `root` nor the settings say (defaultWorkspacesFolder). */
  defaultRoot?: string;
  /**
   * A hub of this one folder (--dir): the only workspace, nothing added or
   * removed from the app, and no list kept. `init` makes it a git repository if it is not.
   */
  folder?: { dir: string; init?: boolean };
  /** Where the hub keeps its list of workspaces. Default: `<root>/.kuraa-workspaces.json`. */
  registry?: string;
  /**
   * The owner's settings (settings.ts), with the flags given at start winning.
   * With them, what runs, the formats, timings, syncing and where new workspaces
   * go come from the settings, and `hosts` gives only what flags alone set
   * (components, --allow-unsandboxed, the Podman program, engines named with
   * --engine; timings in `hosts` still win, for tests). Without them, `hosts` and
   * `peers` are all, and there is nothing to change from the app.
   */
  settings?: SettingsStore;
  token?: string;
  host?: string;
  port?: number;
  /** The built web client, served at `/`. */
  staticDir?: string;
  /** Pages at other origins that may use the hub (--allow-origin; origins.ts). */
  allowOrigins?: string[];
  /** For every workspace's host: formats, running code, timings, identity, logging. */
  hosts?: Omit<HostOptions, 'dir' | 'token' | 'host' | 'port' | 'staticDir' | 'label' | 'peers' | 'init' | 'invites' | 'managePerson' | 'manageOnline' | 'personChanged' | 'knownKeys' | 'run' | 'requests'> & {
    /** Running code. With settings, only what flags set: engines here (--engine) win over the setting. */
    run?: Partial<RunOptions>;
  };
  /** Syncing with other devices, for the workspaces that are shared: joined from an invite link, or that invited someone. */
  peers?: PeerOptions;
  /**
   * A server (0099; @kuraa/server runs one): every workspace's host has no
   * person, its devices in as the server's; workspaces come by links for a
   * server, and none is made here. Headless: no app, no workspace's API, no
   * rooms; only what `kuraa-server join` and `list` ask (serverApi).
   */
  server?: boolean;
  /**
   * A server's (0115): how long it keeps its copy of a workspace whose owner took
   * it out, in ms (a week by default): a taking out can still stop counting (a
   * clash settled otherwise once more is known), and work that reached only the
   * server is not lost at once. A server whose key the owner blocked keeps nothing.
   */
  keepRemovedMs?: number;
  /**
   * A server's (0099): the device key it is in a workspace as, by the workspace's
   * id, kept apart from the workspace's folder, so a join tried again (or the
   * workspace joined again) is the same device, not one more the others look for.
   */
  deviceKeyFor?: (workspace: string) => Promise<KeyPair>;
  log?: (m: string) => void;
}

/** A workspace as the hub keeps it. */
interface Entry {
  id: string;
  name: string;
  dir: string;
  added: string;
  /** A server's (0115): when it found its owner had taken it out; its copy kept a while (keepRemovedMs), then deleted. */
  removedAt?: string;
}

/** What a server answers to anything but its own few routes (0099). */
const HEADLESS = 'This is a Kuraa server: it serves no app, and shows nothing of the workspaces it holds (its `server list` command says which)';

/** The id the app gives a join, to ask how it is going by. */
const JOIN_ID = /^[A-Za-z0-9_-]{8,64}$/;

/** Whether a repository is a workspace shared between devices: it has a workspace id and secret (peers/identity.ts). */
async function shared(dir: string): Promise<boolean> {
  const git = new Git(dir);
  const has = async (key: string) => (await git.run(['config', '--get', key], { allowFail: true })).code === 0;
  return (await has('kuraa.workspace')) && (await has('kuraa.secret'));
}

/** A workspace as the API shows it. */
/**
 * How a join from the app is going (GET /hub/api/joins/<id>): waiting for the
 * hub to finish adding another workspace, the join's own steps (join.ts), then
 * opening the workspace it made.
 */
export interface JoinStatus {
  step: 'waiting' | JoinProgress['step'] | 'opening';
  slowNetwork: boolean;
  from?: string;
  /** Copying: how far, as git says it. */
  copied?: string;
}

export interface HubWorkspace {
  id: string;
  name: string;
  /** Its folder. */
  path: string;
  /** It syncs with other devices. */
  peers: boolean;
  /** Why it is not open, if it is not. */
  error?: string;
  /** It is still opening (the hub answers meanwhile, 0103): what is asked of it waits. */
  opening?: boolean;
  /** The cloud storage service keeping its folder ("iCloud Drive"), if one does (0103). */
  cloud?: string;
}

/** What GET /hub/api/workspaces answers. */
export interface HubList {
  workspaces: HubWorkspace[];
  /** People may add workspaces (and take them off the list). */
  canAdd: boolean;
  /** People may invite others to its workspaces (always: every member has the same say, 0038). */
  canInvite: boolean;
  /** Any folder on the server's computer may be opened as a workspace (the owner, on a hub of many). */
  canOpenFolder: boolean;
  /** The settings may be changed from the app (Preferences). */
  canChangeSettings: boolean;
  /** Why the owner's features (Preferences, opening folders, your identity) are off here, if they are. */
  ownerOff?: string;
  /** Where new workspaces go, and one moved out of a cloud service's folder (0103): for the owner, where workspaces may be added. */
  folder?: string;
}

/** What GET /hub/api/folders answers: the folders in one, to choose one from. */
export interface FolderListing {
  path: string;
  /** The folder above, or null at the top. */
  parent: string | null;
  /** The home folder, where choosing starts. */
  home: string;
  /** Its folders (never links, files or, unless asked, hidden ones), by name. */
  folders: { name: string; path: string }[];
}

/** Why the owner's features are off on a hub listening on the network, in plain words. */
export const OWNER_OFF = 'This host is open to other computers on the network, so Preferences, opening folders and your identity are not available from the app. Start it without --host (listening only on this computer) to use them.';

/** An id and folder name from a name: lowercase letters, digits and hyphens. */
export function slugOf(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  // A folder Windows could not make (con, nul, …) gets a word more.
  return !slug ? 'workspace' : reservedName(slug) ? `${slug}-workspace` : slug;
}

export class Hub {
  private entries: Entry[] = [];
  private readonly hosts = new Map<string, RunningHost>();
  private readonly errors = new Map<string, string>();
  /** Workspaces opening, by id: what is asked of one waits for it (0103). */
  private readonly opening = new Map<string, Promise<void>>();
  /** The cloud storage service keeping each workspace's folder, by id, where one does (0103). */
  private readonly clouds = new Map<string, string>();
  private server: Server | null = null;
  readonly token: string;
  private rootDir: string;
  private readonly registry: string;
  /** WebSockets passed through to workspaces: closed with the hub (the server does not track them). */
  private readonly tunnels = new Set<import('node:net').Socket>();
  /** Adding and removing, one at a time. */
  private readonly serial = serialQueue();
  /** Joins under way, by the id the app gave to ask how each is going. */
  private readonly joins = new Map<string, JoinStatus>();
  address: AddressInfo | null = null;
  /** Who may talk to it from a web page (origins.ts): its workspaces' hosts let in the same. */
  private readonly gate: RequestGate;

  constructor(readonly o: HubOptions) {
    if (o.root && o.folder) throw new Error('A hub needs a folder of workspaces (root) or one folder (folder), not both');
    if (!o.root && !o.folder && !o.settings && !o.defaultRoot) throw new Error('A hub needs a folder of workspaces (root) or one folder (folder)');
    this.rootDir = this.rootFor();
    this.registry = o.registry ?? join(this.rootDir, '.kuraa-workspaces.json');
    this.token = o.token ?? randomBytes(18).toString('base64url');
    this.gate = gateFor(o.host ?? '127.0.0.1', o.allowOrigins);
  }

  /** The hub's folder: the one folder, or where new workspaces go (--workspaces, else the setting, else the default). */
  get root(): string {
    return this.rootDir;
  }

  private rootFor(): string {
    const o = this.o;
    return resolve(o.folder?.dir ?? o.root ?? o.settings?.current.workspaces ?? o.defaultRoot ?? defaultWorkspacesFolder());
  }

  /**
   * Whoever has the access code is the owner, with Preferences, opening any
   * folder, your identity and the online copy, while the hub listens only on this
   * computer (decision 0047). On the network, not.
   */
  get owner(): boolean {
    return isLoopback(this.o.host ?? '127.0.0.1');
  }

  private mayOwn(): void {
    if (!this.owner) throw new HttpError(403, OWNER_OFF);
  }

  /** People may add workspaces: not to a hub of one folder. */
  get canAdd(): boolean {
    return !this.o.folder;
  }

  private mayAdd(): void {
    if (!this.canAdd) throw new HttpError(403, 'This host holds one workspace: others cannot be added to it');
  }

  private log(m: string): void {
    this.o.log?.(m);
  }

  async start(): Promise<AddressInfo> {
    // Headless (0099): a server serves no app, until people sign in to one somehow.
    if (this.o.server && this.o.staticDir) throw new Error('A server serves no app: it is headless for now');
    // The environments loaded, so that a setting naming one no longer there is passed over.
    if (this.o.settings) await this.loadComponents();
    if (this.o.folder) {
      const name = basename(this.root);
      this.entries = [{ id: slugOf(name), name, dir: this.root, added: new Date().toISOString() }];
      await this.open(this.entries[0]!, this.o.folder.init);
      // The one folder it was started for: if it cannot open, there is nothing to serve.
      const why = this.errors.get(this.entries[0]!.id);
      if (why) throw new Error(why);
    } else {
      await mkdir(this.root, { recursive: true });
      this.entries = await this.readRegistry();
      // A server (0099): a join cut short (stopped, or the computer off) left a folder the list does not name; and
      // git, stopped mid-write, its locks. Taken up or taken away; let go of (no other process holds this folder:
      // @kuraa/server holds a lock on it).
      if (this.o.server) await this.recoverServer();
      // Each workspace opens on its own (a host, git, perhaps the peer network): all at once, and the hub
      // answers meanwhile (0103), so one slow to open keeps no one from the others. A server, which no one
      // waits on, has them all open first: what it lists is then how each stands.
      // A server too (0099): it answers at once (`server list` says which are opening), so `server join` does not
      // wait on every workspace to open first. A server opens them a few at a time: every one at once (each its git,
      // its policy, its connections) is a storm each night it restarts to update.
      if (this.o.server) void this.openInTurn(this.entries, 3);
      else this.entries.map((e) => this.open(e));
      // A server taken out of a workspace, or blocked, lets its copy go (0112), as it holds every space; invited back, it
      // copies the workspace afresh in any case (join). Looked at once a minute.
      if (this.o.server) {
        this.sweepTimer = setInterval(() => void this.sweepRemoved().catch((e: Error) => this.log(`could not let go of a workspace taken out: ${e.message}`)), 60_000);
        this.sweepTimer.unref();
      }
    }
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as import('node:net').Socket, head));
    await new Promise<void>((resolveListen, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.o.port ?? 0, this.o.host ?? '127.0.0.1', () => resolveListen());
    });
    this.address = this.server.address() as AddressInfo;
    this.log(`hub serving ${this.entries.length} workspace${this.entries.length === 1 ? '' : 's'} from ${this.root} on http://${this.address.address}:${this.address.port}`);
    return this.address;
  }

  /**
   * The list of workspaces. None yet only if there is no list: a list that cannot
   * be read is never taken for an empty one (and then written over). One that is
   * not valid is set aside, beside it, and the hub starts with none.
   */
  private async readRegistry(): Promise<Entry[]> {
    let text: string;
    try {
      text = await readFile(this.registry, 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`Could not read the list of workspaces (${this.registry}): ${(e as Error).message}`, { cause: e });
    }
    try {
      const list = JSON.parse(text) as Entry[];
      if (!Array.isArray(list)) throw new Error('not a list');
      return list.map(({ id, name, dir, added, removedAt }) => ({ id, name, dir, added, ...(typeof removedAt === 'string' ? { removedAt } : {}) }));
    } catch (e) {
      const aside = `${this.registry}.unreadable-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      await renameOver(this.registry, aside);
      this.log(`the list of workspaces could not be read (${(e as Error).message}): kept as ${aside}, starting with none`);
      return [];
    }
  }

  /** Once every workspace that was opening has opened (or could not). */
  async opened(): Promise<void> {
    while (this.opening.size) await Promise.all(this.opening.values());
  }

  /** Write and commit every workspace's open edits now (each on its own: one failing stops none of the others). */
  async saveAll(): Promise<void> {
    await Promise.all([...this.hosts.entries()].map(async ([id, h]) => {
      try {
        await h.host.serial(() => h.host.commitAll());
      } catch (e) {
        this.log(`[${id}] could not save everything: ${(e as Error).message}`);
      }
    }));
  }

  private async save(): Promise<void> {
    if (this.o.folder) return; // one folder, no list
    await mkdir(dirname(this.registry), { recursive: true });
    // Its own temporary file: two saves may overlap (a workspace added while another is removed). On the disk for
    // sure before it takes the list's place, so the computer going off then leaves the old list or the new (0099).
    const tmp = `${this.registry}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    const fh = await openFile(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(this.entries, null, 2));
      await fh.sync();
    } finally {
      await fh.close();
    }
    await renameOver(tmp, this.registry);
  }

  /** Syncing: the settings (servers to find computers through), else `peers`. */
  private peerOptions(): PeerOptions {
    // A server has no person (0099), whatever this computer keeps.
    const server = this.o.server ? { person: null } : {};
    if (!this.o.settings) return { ...this.o.peers, ...server };
    const s = fromSettings(this.o.settings.current).peers;
    return { ...this.o.peers, ...(s.bootstrap ? { bootstrap: s.bootstrap } : {}), ...(s.relays ? { relays: s.relays } : {}), ...server };
  }

  /** Every workspace's host options: `hosts`, with the settings applied where there are any. */
  private hostOptions(): Omit<HostOptions, 'dir' | 'token'> {
    const base = this.o.hosts ?? {};
    if (!this.o.settings) return { ...base, run: base.run ? { engines: [], ...base.run } : undefined };
    const types = base.types ?? standardTypes;
    const s = fromSettings(this.o.settings.current, { run: base.run, timings: base.timings, formats: types.map((t) => t.id), engines: this.loaded?.engines, environments: this.loaded?.environments });
    // Flags naming features (--feature) win over the settings, as they do for formats.
    return { ...base, run: s.run, formats: s.formats, timings: s.timings, featuresOn: base.featuresOn ?? s.features };
  }

  /** The engines and environments loaded: a setting naming another is passed over. */
  private loaded: { engines: string[]; environments: string[] } | undefined;

  private async loadComponents(): Promise<import('./components.js').RunComponents | null> {
    try {
      const c = await loadRunComponents(this.o.hosts?.run?.components ?? []);
      this.loaded = { engines: [...c.engines.keys()], environments: [...c.environments.keys()] };
      return c;
    } catch (e) {
      this.log(`could not load the run components: ${(e as Error).message}`);
      return null;
    }
  }

  /** Your identity changed (made, imported, a key revoked): every workspace that syncs says so to its other devices now. */
  private async personChanged(): Promise<void> {
    await Promise.all([...this.hosts.values()].map((h) => h.host.peers?.node.signingKey().catch(() => undefined)));
  }

  /** The signing keys any of this hub's workspaces knows to be this identity's. */
  private async knownKeys(id: string): Promise<string[]> {
    const all = await Promise.all([...this.hosts.values()].map(async (h) =>
      (await h.host.peers?.node.identity.people().catch(() => []) ?? []).find((p) => p.key === id)?.keys ?? []));
    return [...new Set(all.flat())];
  }

  /**
   * Start a workspace's host. A workspace that cannot open is listed with why.
   * `joined`: the node that just joined it, still connected, for its host to go on with.
   */
  private open(e: Entry, init = false, joined?: PeerNode): Promise<void> {
    const opening: Promise<void> = Promise.all([
      this.openNow(e, init, joined),
      // Whether a cloud service keeps its folder: known by the time it has opened.
      cloudService(e.dir).then((s) => void (s ? this.clouds.set(e.id, s) : this.clouds.delete(e.id))),
    ]).then(() => undefined).finally(() => {
      if (this.opening.get(e.id) === opening) this.opening.delete(e.id);
    });
    this.opening.set(e.id, opening);
    return opening;
  }

  private async openNow(e: Entry, init: boolean, joined?: PeerNode): Promise<void> {
    try {
      if (!init && !existsSync(e.dir)) throw new Error(`Its folder is gone: ${e.dir}`);
      // A server's git housekeeping (0099): in the fetch that calls for it, not in the background beside every other
      // workspace's at once; one thread, and a bounded window, so a few at once do not run a small computer out of memory.
      if (this.o.server) for (const [k, v] of [['gc.autoDetach', 'false'], ['pack.threads', '1'], ['pack.windowMemory', '100m']]) await new Git(e.dir).run(['config', k!, v!], { allowFail: true });
      const peerOptions = this.peerOptions();
      const peers = joined ? { ...peerOptions, node: joined } : (await shared(e.dir)) ? peerOptions : undefined;
      const h = await startHost({
        ...this.hostOptions(), dir: e.dir, init, label: e.name,
        // A server's (0099): nothing edits its folders.
        ...(this.o.server ? { watchFiles: false } : {}),
        // A server's (0099): an access code of its own, told to no one (nothing is passed to it: headless).
        token: this.o.server ? undefined : this.token, host: '127.0.0.1', port: 0, requests: this.gate, peers, log: (m) => this.log(`[${e.id}] ${m}`),
        // The list says what the workspace calls itself (0061), and keeps it for when it is not open.
        onName: (name) => this.named(e, name),
        // People may invite others to a hub's workspaces from the app (every member has the same say, 0038);
        // the first invitation turns syncing on, for good (the workspace is shared from then on).
        invites: { peers: peerOptions },
        // The owner's own features: only while the hub listens on this computer alone (0047).
        // A server has no identity to manage (0099).
        managePerson: this.owner && !this.o.server,
        manageOnline: this.owner,
        personChanged: () => this.personChanged(),
        knownKeys: (id) => this.knownKeys(id),
      });
      this.hosts.set(e.id, h);
      this.errors.delete(e.id);
    } catch (err) {
      // Its host never took the joined node: let it go (the next start connects anew).
      await joined?.close();
      this.errors.set(e.id, (err as Error).message);
      this.log(`[${e.id}] could not open: ${(err as Error).message}`);
    }
  }

  /** The workspaces, and what people may do with them. */
  listing(): HubList {
    return {
      workspaces: this.list(),
      canAdd: this.canAdd,
      canInvite: true,
      canOpenFolder: this.owner && this.canAdd,
      canChangeSettings: this.owner && !!this.o.settings,
      ...(this.owner ? {} : { ownerOff: OWNER_OFF }),
      ...(this.owner && this.canAdd ? { folder: this.root } : {}),
    };
  }

  list(): HubWorkspace[] {
    return this.entries.map((e) => ({
      id: e.id, name: e.name, path: e.dir, peers: !!this.hosts.get(e.id)?.host.peers,
      ...(this.errors.has(e.id) ? { error: this.errors.get(e.id) } : {}),
      ...(this.opening.has(e.id) ? { opening: true } : {}),
      ...(this.clouds.has(e.id) ? { cloud: this.clouds.get(e.id) } : {}),
    }));
  }

  private freeId(name: string): string {
    const base = slugOf(name);
    let id = base;
    for (let i = 2; this.entries.some((e) => e.id === id) || this.reserved.has(id) || existsSync(join(this.root, id)); i++) id = `${base}-${i}`;
    return id;
  }

  private async add(e: Entry, joined?: PeerNode): Promise<HubWorkspace> {
    this.entries.push(e);
    await this.save();
    await this.open(e, false, joined);
    this.log(`added workspace ${e.name} (${e.dir})`);
    return this.list().find((w) => w.id === e.id)!;
  }

  /** The workspace says it is called `name` now (0061): the list follows, and keeps it. */
  private named(e: Entry, name: string): void {
    if (e.name === name) return;
    e.name = name;
    if (this.entries.includes(e)) void this.save().catch((err: Error) => this.log(`could not save the list of workspaces: ${err.message}`));
  }

  /** A new workspace: a new folder in the hub's folder, made a git repository, named by whoever makes it (0061). */
  create(name: string): Promise<HubWorkspace> {
    // A server holds what people share with it, and founds nothing (0099: no person to be its owner).
    if (this.o.server) return Promise.reject(new HttpError(403, 'A server holds workspaces shared with it: it makes none of its own'));
    return this.serial(async () => {
      this.mayAdd();
      let label: string;
      try {
        label = cleanName(name);
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
      const id = this.freeId(label);
      const dir = join(this.root, id);
      await mkdir(dir, { recursive: true });
      await initWorkspace(dir, label);
      return this.add({ id, name: label, dir, added: new Date().toISOString() });
    });
  }

  /**
   * A workspace joined from an invite link, into a new folder in the hub's
   * folder. Its host goes on with the connections the join made. `progress`: an
   * id the app asks how it is going by (joinStatus) until it is done. It is
   * called what it calls itself (0061), known once it is copied; a workspace
   * that names itself nowhere (shared before 0061) is "Shared workspace" until
   * someone renames it.
   */
  async join(invitation: string, progress?: string): Promise<HubWorkspace> {
    const tell = (s: JoinStatus) => {
      if (progress) this.joins.set(progress, s);
    };
    tell({ step: 'waiting', slowNetwork: false });
    this.joiningNow++;
    try {
      // The list's turn only for what is quick (0099): which folder, whether held already; the copy, which may be
      // long, is made outside it, so it holds up no other join, nor taking a workspace off the list.
      const prep = await this.serial(async (): Promise<{ held: HubWorkspace } | { id: string; dir: string; workspace: string }> => {
        this.mayAdd();
        let link: ReturnType<typeof decodeLink>;
        try {
          link = decodeLink(invitation);
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
        // A server joins by a link for a server, as no person (0099).
        if (this.o.server && link.grant?.role !== 'server') throw new HttpError(400, 'A server joins by an invite link for a server: ask the workspace’s owner for one (Workspace settings › People › Add a server…)');
        const workspace = link.workspace.id;
        if (this.joiningWorkspaces.has(workspace)) throw new HttpError(409, 'This workspace is being joined already: wait for that join to finish');
        // A server holding the workspace already (0099): in it, that one; taken out since, the old copy let go of, and
        // joined again (as the same device: deviceKeyFor).
        if (this.o.server) {
          await this.opened();
          const held = await this.heldWorkspace(workspace);
          if (held) {
            const peers = this.hosts.get(held.id)?.host.peers;
            const { policy, me } = peers ? await peers.node.policy() : { policy: null, me: null };
            if (policy?.isServer(me)) return { held: this.list().find((w) => w.id === held.id)! };
            this.log(`[${held.id}] held, but no longer in: joined again`);
            await this.hosts.get(held.id)?.close().catch(() => undefined);
            this.hosts.delete(held.id);
            this.entries = this.entries.filter((e) => e !== held);
            await this.save();
            await rm(held.dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
          }
        }
        const id = this.freeId('Shared workspace');
        this.reserved.add(id);
        this.joiningWorkspaces.add(workspace);
        return { id, dir: join(this.root, id), workspace };
      });
      if ('held' in prep) return prep.held;
      const { id, dir, workspace } = prep;
      try {
        let joined;
        try {
          // With the server's ways in (0053): the node joining goes on as the workspace's, and opens the process's TCP listener and DHT node.
          const { peerPort, publicAddress, dhtPort, serveDht } = this.peerOptions();
          const deviceKey = this.o.deviceKeyFor ? await this.o.deviceKeyFor(workspace) : undefined;
          joined = await joinWorkspace({ dir, invitation, bootstrap: this.peerOptions().bootstrap, relays: this.peerOptions().relays, peerPort, publicAddress, dhtPort, serveDht, keep: true, progress: tell, log: (m) => this.log(`[${id}] ${m}`), ...(this.o.server ? { person: null } : {}), ...(this.o.peers?.signing ? { signing: this.o.peers.signing } : {}), ...(deviceKey ? { deviceKey } : {}), ...(this.o.peers?.maxFetchBytes ? { maxFetchBytes: this.o.peers.maxFetchBytes } : {}) });
        } catch (err) {
          // Leave nothing half-made behind.
          // (On Windows a process that has just ended may hold a file in it for a moment.)
          await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch((e: Error) => this.log(`[${id}] could not remove ${dir}: ${e.message}`));
          throw err instanceof HttpError ? err : new HttpError(400, (err as Error).message);
        }
        tell({ step: 'opening', slowNetwork: false, from: joined.inviter });
        const name = (await readWorkspaceName(dir)) ?? 'Shared workspace';
        return await this.serial(async () => {
          try {
            return await this.add({ id, name, dir, added: new Date().toISOString() }, joined.node);
          } catch (err) {
            // Joined, but not kept on the list (a full disk, say): let go of, whole, rather than left syncing unlisted.
            await joined.node?.close().catch(() => undefined);
            await this.hosts.get(id)?.close().catch(() => undefined);
            this.hosts.delete(id);
            this.entries = this.entries.filter((e) => e.id !== id);
            await rm(dir, { recursive: true, force: true, maxRetries: 5 }).catch(() => undefined);
            throw err;
          }
        });
      } finally {
        this.reserved.delete(id);
        this.joiningWorkspaces.delete(workspace);
      }
    } finally {
      this.joiningNow--;
      if (progress) this.joins.delete(progress);
    }
  }

  /** Folders chosen for joins under way (freeId passes them over), and the workspaces being joined (one join each). */
  private readonly reserved = new Set<string>();
  private readonly joiningWorkspaces = new Set<string>();

  /** The entry whose folder is of a workspace (by its id), if this hub holds it. */
  private async heldWorkspace(workspace: string): Promise<Entry | null> {
    for (const e of this.entries) {
      const id = (await new Git(e.dir).run(['config', '--get', 'kuraa.workspace'], { allowFail: true })).stdout.trim();
      if (id === workspace) return e;
    }
    return null;
  }

  /** How a join from the app is going, by the id it gave; null once it is over, or if there is none. */
  joinStatus(progress: string): JoinStatus | null {
    return this.joins.get(progress) ?? null;
  }

  /**
   * A folder that is already there (Open a folder…, or `pnpm dev`'s Scratch): added as it is, made a git repository first if `init`, called
   * `name` (default: the folder's name).
   */
  addFolder(folder: string, init = false, name?: string): Promise<HubWorkspace> {
    return this.serial(async () => {
      this.mayAdd();
      const info = await inspectFolder(folder);
      // Asked to make it a repository (`init`), a folder inside another repository is made one of its own:
      // pnpm dev's Scratch, in a checkout of Kuraa, is never the checkout (a git worktree's, above all).
      const own = !!info.repoRoot && sameFolder(info.repoRoot, info.dir);
      if (init && info.repoRoot && !own) info.repoRoot = null;
      const dir = info.repoRoot ?? info.dir;
      // Windows' folder names ignore case: C:\Users\Ann\notes is c:\users\ann\Notes.
      const same = (a: string) => (process.platform === 'win32' ? resolve(a).toLowerCase() === resolve(dir).toLowerCase() : resolve(a) === resolve(dir));
      const known = this.entries.find((e) => same(e.dir));
      if (known) return this.list().find((w) => w.id === known.id)!;
      if (!info.repoRoot) {
        if (!init) throw new HttpError(400, `${dir} is not a git repository`);
        await initWorkspace(dir, name?.trim() || basename(dir));
      }
      const label = name?.trim() || basename(dir);
      return this.add({ id: this.freeId(label), name: label, dir, added: new Date().toISOString() });
    });
  }

  /**
   * Open any folder on this computer as a workspace (the owner's Open a folder…).
   * A folder that is not yet a git repository is made one only if `init`; else the
   * answer says so (409), with what the app asks before making it one.
   */
  async openFolder(path: unknown, init: boolean): Promise<HubWorkspace> {
    this.mayOwn();
    this.mayAdd();
    if (typeof path !== 'string' || !isAbsolute(path)) throw new HttpError(400, 'Choose a folder on this computer');
    let isDir = false;
    try {
      isDir = (await lstat(path)).isDirectory();
    } catch { /* not there */ }
    if (!isDir) throw new HttpError(400, `There is no folder at ${path}.`);
    const info = await inspectFolder(path);
    if (!info.repoRoot && !init) {
      throw Object.assign(new HttpError(409, `${info.dir} does not keep versions yet`), { notRepository: { name: basename(info.dir), path: info.dir, entries: info.entries } });
    }
    return this.addFolder(info.repoRoot ?? info.dir, !info.repoRoot);
  }

  /**
   * The folders in a folder of this computer (the owner's folder browser): never
   * links (nothing is followed out of a listing), files, or hidden ones unless
   * asked for. Starts at the home folder.
   */
  async folders(path: string | null, hidden = false): Promise<FolderListing> {
    this.mayOwn();
    const home = homedir();
    const dir = resolve(path || home);
    if (path && !isAbsolute(path)) throw new HttpError(400, 'Choose a folder on this computer');
    let entries;
    try {
      if ((await lstat(dir)).isSymbolicLink()) throw new HttpError(400, `${dir} is a link to somewhere else: the app does not follow links`);
      entries = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, `Cannot look in ${dir}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'there is no folder there' : (e as Error).message}`);
    }
    const folders = entries
      // Dirents describe the entry itself: a link to a folder is a link, not a folder, and is left out.
      .filter((d) => d.isDirectory() && (hidden || !d.name.startsWith('.')))
      .map((d) => ({ name: d.name, path: join(dir, d.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const up = dirname(dir);
    return { path: dir, parent: up === dir ? null : up, home, folders };
  }

  /** What the Preferences dialog shows: the settings, which flags set, the defaults, and whether code can run. */
  async settingsView(): Promise<SettingsView> {
    this.mayOwn();
    const store = this.o.settings;
    if (!store) throw new HttpError(404, 'This host is set up with flags when it starts');
    const run = this.hostOptions().run;
    const loaded = await this.loadComponents();
    const environments: SettingsView['environments'] = await Promise.all([...(loaded?.environments.values() ?? [])].map(async (e) => {
      try {
        return { id: e.id, label: e.label, ...(await e.check(run?.options?.[e.id])) };
      } catch (err) {
        return { id: e.id, label: e.label, available: false, message: (err as Error).message };
      }
    }));
    return {
      settings: store.current,
      fromFlags: store.fromFlags,
      defaults: {
        memory: DEFAULT_POLICY.memory, cpus: DEFAULT_POLICY.cpus, disk: DEFAULT_POLICY.disk,
        saveSeconds: DEFAULT_TIMINGS.flushMs / 1000, versionSeconds: DEFAULT_TIMINGS.idleCommitMs / 1000,
      },
      defaultWorkspaces: resolve(this.o.defaultRoot ?? defaultWorkspacesFolder()),
      defaultDataDir: store.defaultDataDir,
      environments,
      formats: (this.o.hosts?.types ?? standardTypes).map((t) => ({ id: t.id, label: t.label })),
      features: (this.o.hosts?.features ?? []).map((f) => ({ id: f.id, label: f.label, description: f.description ?? '' })),
      canAdd: this.canAdd,
    };
  }

  /**
   * Keep new settings (refused, with what is wrong, if a value is), and apply
   * them: every workspace's host is closed, writing and committing its edits,
   * and opened again with them. The address and access code stay the same.
   */
  saveSettings(v: unknown): Promise<SettingsView> {
    return this.serial(async () => {
      this.mayOwn();
      const store = this.o.settings;
      if (!store) throw new HttpError(404, 'This host is set up with flags when it starts');
      if (await store.save(v)) await this.reconfigure();
      return this.settingsView();
    });
  }

  /** Close every workspace (each writes and commits first) and open them again with the options as they now are. */
  private async reconfigure(): Promise<void> {
    await this.opened();
    const running = [...this.hosts.entries()];
    this.hosts.clear();
    await Promise.all(running.map(([id, h]) => h.close().catch((e: Error) => this.log(`[${id}] stopping failed: ${e.message}`))));
    if (!this.o.folder) {
      const root = this.rootFor();
      if (root !== this.rootDir) {
        await mkdir(root, { recursive: true });
        this.rootDir = root;
        this.log(`new workspaces now go in ${root}`);
      }
    }
    await Promise.all(this.entries.map((e) => this.open(e)));
    this.log('settings applied: every workspace opened again');
  }

  /** Take a workspace off the list and close it. Its folder stays as it is. */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      this.mayAdd();
      const e = this.entries.find((x) => x.id === id);
      if (!e) throw new HttpError(404, `No workspace ${id}`);
      await this.opening.get(id);
      await this.hosts.get(id)?.close();
      this.hosts.delete(id);
      this.errors.delete(id);
      this.entries = this.entries.filter((x) => x !== e);
      await this.save();
      this.log(`removed workspace ${e.name} from the list (its folder stays: ${e.dir})`);
    });
  }

  /**
   * Move a workspace's folder out of one a cloud storage service keeps (0103),
   * into the folder new workspaces go in (refused if a service keeps that one
   * too). Its host is closed first, writing and committing its edits, and opened
   * again where it now is. Its devices find it as before: what it is, and who,
   * is in its repository, which moves with it.
   */
  move(id: string): Promise<HubWorkspace> {
    return this.serial(async () => {
      this.mayOwn();
      this.mayAdd();
      const e = this.entries.find((x) => x.id === id);
      if (!e) throw new HttpError(404, `No workspace ${id}`);
      await this.opening.get(id);
      const from = e.dir;
      const service = await cloudService(from);
      if (!service) throw new HttpError(400, `${e.name} is not in a folder a cloud storage service keeps: it stays where it is`);
      const into = this.root;
      const intoService = await cloudService(into);
      if (intoService) throw new HttpError(409, `New workspaces go in ${into}, which ${intoService} keeps too. Choose another folder for them in Settings, then move ${e.name}.`);
      await mkdir(into, { recursive: true });
      const to = freeFolder(into, basename(from));
      const h = this.hosts.get(id);
      this.hosts.delete(id);
      await h?.close();
      try {
        await moveFolder(from, to);
      } catch (err) {
        await this.open(e); // where it was, as it was
        throw new HttpError(500, `Could not move ${e.name} to ${to}: ${(err as Error).message}`);
      }
      e.dir = to;
      await this.save();
      this.log(`moved workspace ${e.name} out of ${service}: from ${from} to ${to}`);
      await this.open(e);
      return this.list().find((w) => w.id === id)!;
    });
  }

  /** The host of a workspace, by id. */
  hostOf(id: string): RunningHost | undefined {
    return this.hosts.get(id);
  }

  // HTTP ----------------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const w = /^\/w\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname);
    if (!hostAllowed(req, this.gate)) return refuseHost(res);
    try {
      // A server is headless (0099): its own few routes, with the access code, and nothing else.
      if (this.o.server) {
        if (!url.pathname.startsWith('/hub/api/')) return send(res, 404, { error: HEADLESS });
        if (!sameToken(tokenOf(req), this.token)) return send(res, 401, { error: 'Unauthorized' });
        return await this.serverApi(req, res, url);
      }
      if (w) return this.proxy(req, res, w[1]!, `${w[2] ?? '/'}${url.search}`);
      if (url.pathname.startsWith('/hub/api/')) {
        corsHeaders(req, res, this.gate);
        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          return void res.end();
        }
        if (!sameToken(tokenOf(req), this.token)) return send(res, 401, { error: 'Unauthorized' });
        return await this.api(req, res, url);
      }
      // A client that asks a hub for one workspace's API is told this is a hub.
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/git')) return send(res, 404, { error: 'This is a hub: workspaces are under /w/<id>', hub: true });
      serveStaticFrom(this.o.staticDir, url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) send(res, status, { error: (err as Error).message });
      else res.end();
    }
  }

  /**
   * A server's API (0099), all it answers: the workspaces it holds and whether
   * each has taken it in (GET /hub/api/server), joining one by a link for a
   * server (POST /hub/api/workspaces, kind join), and how a join is going.
   * No workspace's files, history or people: whoever has the access code runs
   * the server, and sees what it holds only by `kuraa-server list`.
   */
  private async serverApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /hub/api/server') return send(res, 200, { workspaces: await this.serverListing() });
    // Its key given up (kuraa-host server new-key, 0112): blocked by itself in every workspace it is in, so no owner need.
    if (route === 'POST /hub/api/server/retire-key') return send(res, 200, { workspaces: await this.retireKey() });
    // How it stands (kuraa-host server status, 0112): since when it runs, and each workspace's members, latest work and size.
    if (route === 'GET /hub/api/server/status') return send(res, 200, { started: this.started, workspaces: await this.serverStatus() });
    if (route === 'POST /hub/api/workspaces') {
      const b = await readBody(req);
      if (b.kind !== 'join') throw new HttpError(403, 'A server holds workspaces shared with it: it makes none of its own');
      if (typeof b.invitation !== 'string' || !b.invitation.trim()) throw new HttpError(400, 'Give an invite link for a server');
      const progress = typeof b.progress === 'string' && JOIN_ID.test(b.progress) ? b.progress : undefined;
      return send(res, 201, { workspace: await this.join(b.invitation, progress) });
    }
    const joining = /^\/hub\/api\/joins\/([^/]+)$/.exec(url.pathname);
    if (joining && req.method === 'GET') {
      const status = JOIN_ID.test(joining[1]!) ? this.joinStatus(joining[1]!) : null;
      return status ? send(res, 200, status) : send(res, 404, { error: 'No join under way by that id' });
    }
    // A workspace let go of (kuraa-host server remove <id>): off the list, and its copy here taken away; the server
    // stays in the workspace until its owner takes it out.
    const one = /^\/hub\/api\/workspaces\/([a-z0-9-]+)$/.exec(url.pathname);
    if (one && req.method === 'DELETE') {
      const e = this.entries.find((x) => x.id === one[1]);
      await this.remove(one[1]!);
      if (e) await rm(e.dir, { recursive: true, force: true, maxRetries: 5 });
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, HEADLESS);
  }

  /**
   * The workspaces a server holds, and how each stands: taken in (its own policy
   * names this computer's key as a server), or out (0112): taken out by its
   * owner, or blocked; its copy goes within the minute (sweepRemoved).
   */
  private async serverListing(): Promise<{ id: string; name: string; path: string; in: boolean; out?: 'removed' | 'blocked' | 'retired'; opening?: boolean; error?: string }[]> {
    return Promise.all(this.listing().workspaces.map(async (w) => {
      const out = await this.outOf(w.id);
      return { id: w.id, name: w.name, path: w.path, in: !out && (await this.isIn(w.id)), ...(out ? { out } : {}), ...(this.opening.has(w.id) ? { opening: true } : {}), ...(w.error ? { error: w.error } : {}) };
    }));
  }

  /**
   * A server giving up its key (0112): in each workspace it is in, a drop of its
   * own key, told to the members' devices connected. Said for each: whether it
   * was, and how many members' devices were connected to hear it at once (the
   * others hear it from them).
   */
  private async retireKey(): Promise<{ id: string; name: string; dropped: boolean; heardBy: number; error?: string }[]> {
    const out: { id: string; name: string; dropped: boolean; heardBy: number; error?: string }[] = [];
    for (const e of this.entries) {
      const peers = this.hosts.get(e.id)?.host.peers;
      if (!peers) {
        out.push({ id: e.id, name: e.name, dropped: false, heardBy: 0, error: 'not open' });
        continue;
      }
      try {
        const key = await peers.node.signingKeyNow();
        const { policy } = await peers.node.policy();
        const mine = key.publicKey.toString('hex');
        if (!policy.dropped.has(mine)) await peers.node.identity.dropKey(mine, await peers.node.branchTips(), key);
        await peers.node.membersChanged();
        const status = await peers.status();
        out.push({ id: e.id, name: e.name, dropped: true, heardBy: status.devices.filter((d) => d.online && !d.server).length });
      } catch (err) {
        out.push({ id: e.id, name: e.name, dropped: false, heardBy: 0, error: (err as Error).message });
      }
    }
    return out;
  }

  /** When this hub started (ms since 1970). */
  private readonly started = Date.now();

  /**
   * Each workspace a server holds, with how it stands (0112): its listing, and
   * the members' devices connected of those it knows, when work last came in
   * from one, and how much room its folder takes.
   */
  private async serverStatus(): Promise<{ id: string; name: string; in: boolean; out?: string; online: number; devices: number; lastBrought: number | null; bytes: number | null }[]> {
    const listed = await this.serverListing();
    return Promise.all(listed.map(async (w) => {
      const peers = this.hosts.get(w.id)?.host.peers;
      const status = peers ? await peers.status().catch(() => null) : null;
      const members = (status?.devices ?? []).filter((d) => !d.server && !d.related);
      return { id: w.id, name: w.name, in: w.in, ...(w.out ? { out: w.out } : {}), online: members.filter((d) => d.online).length, devices: members.length, lastBrought: peers?.lastBrought ?? null, bytes: await this.sizeOf(w.path) };
    }));
  }

  /** Folders' sizes, worked out two at a time (0115: a status asked of a server with many workspaces is no burst on its disk). */
  private sizing: Promise<unknown> = Promise.resolve();
  private sizingNow = 0;
  private async sizeOf(dir: string): Promise<number | null> {
    while (this.sizingNow >= 2) await this.sizing;
    this.sizingNow++;
    const run = folderBytes(dir).finally(() => void this.sizingNow--);
    this.sizing = run;
    return run;
  }

  /** Whether a workspace's policy names this server as one of its servers. */
  private async isIn(id: string): Promise<boolean> {
    const peers = this.hosts.get(id)?.host.peers;
    if (!peers) return false;
    const { policy, me } = await peers.node.policy();
    return policy.isServer(me);
  }

  /**
   * How a server is out of a workspace, if it is (0112): its key blocked by the
   * owner, its key given up by itself (0115: server new-key; kept until the
   * operator finishes, so its drop is not lost before a member has it), or
   * taken out by its owner.
   */
  private async outOf(id: string): Promise<'removed' | 'blocked' | 'retired' | null> {
    const peers = this.hosts.get(id)?.host.peers;
    if (!peers) return null;
    const { policy } = await peers.node.policy();
    if (!policy.founded) return null;
    // By its own key: out, the policy no longer says it is the server's (node.policy's `me`).
    const me = (await peers.node.signingKeyNow()).publicKey.toString('hex');
    if (policy.dropped.has(me)) {
      const own = (await peers.node.identity.records()).some((r) => r.kind === 'policy' && r.op?.t === 'drop' && r.op.key === me && r.signer === me);
      return own ? 'retired' : 'blocked';
    }
    return !policy.isServer(me) && policy.cutoffs.has(me) ? 'removed' : null;
  }

  private sweepTimer: NodeJS.Timeout | undefined;

  /**
   * A server's copies of workspaces it is out of (0112), let go of: taken out by
   * its owner, or its key blocked. It holds every space; invited back, it copies
   * the workspace afresh (join), so keeping a copy would gain nothing.
   */
  async sweepRemoved(now = Date.now()): Promise<void> {
    const keep = this.o.keepRemovedMs ?? 7 * 24 * 3600_000;
    let changed = false;
    for (const e of [...this.entries]) {
      if (this.opening.has(e.id)) continue;
      const out = await this.outOf(e.id);
      // In again (a taking out that stopped counting), or never out: kept, its mark let go of.
      if (!out || out === 'retired') {
        if (e.removedAt && !out) {
          delete e.removedAt;
          changed = true;
        }
        continue;
      }
      if (out === 'removed' && !e.removedAt) {
        e.removedAt = new Date(now).toISOString();
        changed = true;
        this.log(`[${e.id}] taken out of ${e.name} by its owner: its copy here goes on ${new Date(now + keep).toISOString().slice(0, 10)}, unless it is in again by then`);
        continue;
      }
      // Blocked: at once. Taken out: once kept long enough, and still out (looked at again just now).
      if (out === 'blocked' || (e.removedAt && now - Date.parse(e.removedAt) >= keep)) {
        await this.remove(e.id);
        await rm(e.dir, { recursive: true, force: true, maxRetries: 5 });
        this.log(`[${e.id}] ${out === 'blocked' ? 'its key blocked in' : 'taken out of'} ${e.name} by its owner: its copy here deleted`);
        changed = false;
      }
    }
    if (changed) await this.save();
  }

  /** Open workspaces, `at` at a time (a server's start: 0099); each listed as opening until it has. */
  private async openInTurn(list: Entry[], at: number): Promise<void> {
    // Each listed as opening from now: waiting its turn, until its own opening is done (which takes its place).
    const done = new Map<string, () => void>();
    for (const e of list) this.opening.set(e.id, new Promise<void>((r) => done.set(e.id, r)));
    let next = 0;
    const worker = async () => {
      while (next < list.length) {
        const e = list[next++]!;
        await this.open(e).catch(() => undefined);
        done.get(e.id)?.();
      }
    };
    await Promise.all(Array.from({ length: Math.min(at, list.length) }, worker));
  }

  /** How many joins are under way (a server's update waits for them: 0099). */
  get joinsUnderWay(): number {
    return this.joiningNow;
  }

  private joiningNow = 0;

  /**
   * A server's folder after a stop at any moment (0099): folders the list does
   * not name (a join cut short) taken up where the join got as far as a copy
   * checked out and its link noted, else taken away; and in every workspace,
   * git's locks a stop mid-write left (no other process holds them: the server
   * holds its folder alone), which would otherwise stop it opening, or merging.
   */
  private async recoverServer(): Promise<void> {
    const listed = new Set(this.entries.map((e) => resolve(e.dir)));
    let changed = false;
    for (const name of await readdir(this.root).catch(() => [] as string[])) {
      const dir = join(this.root, name);
      if (name.startsWith('.') || listed.has(resolve(dir)) || !(await lstat(dir).catch(() => null))?.isDirectory()) continue;
      await this.clearLocks(dir);
      const head = (await new Git(dir).run(['rev-parse', '-q', '--verify', 'HEAD^{commit}'], { allowFail: true })).stdout.trim();
      if (head && existsSync(join(dir, '.git', 'kuraa', 'joined-link')) && /^[a-z0-9-]+$/.test(name) && (await shared(dir))) {
        this.entries.push({ id: name, name: (await readWorkspaceName(dir)) ?? 'Shared workspace', dir, added: new Date().toISOString() });
        this.log(`[${name}] a join cut short after its copy: taken up`);
        changed = true;
      } else {
        await rm(dir, { recursive: true, force: true }).catch((e: Error) => this.log(`[${name}] could not remove what a join cut short left: ${e.message}`));
        this.log(`[${name}] a join cut short before its copy: taken away`);
      }
    }
    for (const e of this.entries) await this.clearLocks(e.dir);
    if (changed) await this.save();
  }

  /** Git's locks in a repository, a stop mid-write left (index, config, HEAD, packed-refs, any ref's): taken away. */
  private async clearLocks(dir: string): Promise<void> {
    const gitDir = join(dir, '.git');
    const gone: string[] = [];
    for (const f of ['index.lock', 'config.lock', 'HEAD.lock', 'ORIG_HEAD.lock', 'packed-refs.lock', 'shallow.lock']) {
      if (existsSync(join(gitDir, f))) gone.push(join(gitDir, f));
    }
    const walk = async (d: string): Promise<void> => {
      for (const x of await readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = join(d, x.name);
        if (x.isDirectory()) await walk(p);
        else if (x.name.endsWith('.lock')) gone.push(p);
      }
    };
    await walk(join(gitDir, 'refs'));
    for (const f of gone) await rm(f, { force: true }).catch(() => undefined);
    if (gone.length) this.log(`[${basename(dir)}] took away ${gone.length} lock${gone.length === 1 ? '' : 's'} git left when stopped`);
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /hub/api/workspaces') return send(res, 200, this.listing());
    if (route === 'POST /hub/api/workspaces/open') {
      const b = await readBody(req);
      try {
        return send(res, 201, { workspace: await this.openFolder(b.path, b.init === true) });
      } catch (e) {
        const notRepository = (e as { notRepository?: unknown }).notRepository;
        if (notRepository) return send(res, 409, { error: (e as Error).message, notRepository });
        throw e;
      }
    }
    if (route === 'GET /hub/api/folders') return send(res, 200, await this.folders(url.searchParams.get('path'), url.searchParams.get('hidden') === '1'));
    if (route === 'GET /hub/api/settings') return send(res, 200, await this.settingsView());
    if (route === 'PUT /hub/api/settings') return send(res, 200, await this.saveSettings(await readBody(req)));
    if (route === 'POST /hub/api/workspaces') {
      const b = await readBody(req);
      if (b.kind === 'new') return send(res, 201, { workspace: await this.create(String(b.name ?? '')) });
      if (b.kind === 'join') {
        if (typeof b.invitation !== 'string' || !b.invitation.trim()) throw new HttpError(400, 'Paste an invitation or subscription link');
        const progress = typeof b.progress === 'string' && JOIN_ID.test(b.progress) ? b.progress : undefined;
        return send(res, 201, { workspace: await this.join(b.invitation, progress) });
      }
      throw new HttpError(400, 'Add a new workspace (kind: new) or join one (kind: join)');
    }
    const joining = /^\/hub\/api\/joins\/([^/]+)$/.exec(url.pathname);
    if (joining && req.method === 'GET') {
      const status = JOIN_ID.test(joining[1]!) ? this.joinStatus(joining[1]!) : null;
      return status ? send(res, 200, status) : send(res, 404, { error: 'No join under way by that id' });
    }
    const moving = /^\/hub\/api\/workspaces\/([a-z0-9-]+)\/move$/.exec(url.pathname);
    if (moving && req.method === 'POST') return send(res, 200, { workspace: await this.move(moving[1]!) });
    const one = /^\/hub\/api\/workspaces\/([a-z0-9-]+)$/.exec(url.pathname);
    if (one && req.method === 'DELETE') {
      await this.remove(one[1]!);
      return send(res, 200, { ok: true });
    }
    throw new HttpError(404, `No route: ${route}`);
  }

  /** Pass a request to a workspace's host, as if it had come to it. */
  private proxy(req: IncomingMessage, res: ServerResponse, id: string, path: string): void {
    const h = this.hosts.get(id);
    // Still opening (0103): passed on once the workspace has opened, or told why it could not.
    const opening = this.opening.get(id);
    if (!h && opening) return void opening.then(() => this.proxy(req, res, id, path));
    if (!h) return send(res, this.entries.some((e) => e.id === id) ? 503 : 404, { error: this.errors.get(id) ?? `No workspace ${id}` });
    const target = new URL(h.url);
    const out = request({ host: target.hostname, port: target.port, method: req.method, path, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    out.on('error', (e) => {
      if (!res.headersSent) send(res, 502, { error: e.message });
      else res.destroy();
    });
    req.pipe(out);
  }

  /** WebSockets (a workspace's rooms): the upgrade request, rewritten, then the bytes both ways. */
  private upgrade(req: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const w = /^\/w\/([a-z0-9-]+)(\/.*)$/.exec(url.pathname);
    const h = w && this.hosts.get(w[1]!);
    // Still opening (0103): let in once it has opened.
    const opening = w && !h && !this.o.server ? this.opening.get(w[1]!) : undefined;
    if (opening) return void opening.then(() => (socket.destroyed ? undefined : this.upgrade(req, socket, head)));
    // A server is headless (0099): no rooms for anyone.
    if (this.o.server || !h || !upgradeAllowed(req, this.gate)) return void socket.destroy();
    const target = new URL(h.url);
    const upstream = connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${w[2]}${url.search} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    this.tunnels.add(socket);
    this.tunnels.add(upstream);
    const end = () => {
      upstream.destroy();
      socket.destroy();
      this.tunnels.delete(socket);
      this.tunnels.delete(upstream);
    };
    upstream.on('error', end);
    socket.on('error', end);
    upstream.on('close', end);
    socket.on('close', end);
  }

  async close(): Promise<void> {
    clearInterval(this.sweepTimer);
    const closed = new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections();
    for (const s of this.tunnels) s.destroy();
    this.tunnels.clear();
    await closed;
    // A workspace still opening is let finish, and closed with the others.
    await this.opened();
    await Promise.all([...this.hosts.entries()].map(([id, h]) => h.close().catch((e: Error) => this.log(`[${id}] stopping failed: ${e.message}`))));
    this.hosts.clear();
  }
}

/** How much room a folder takes on the disk, in bytes (du); null if it cannot be said. */
async function folderBytes(dir: string): Promise<number | null> {
  return new Promise((resolveBytes) => {
    execFile('du', ['-sk', dir], { timeout: 30_000 }, (err, out) => {
      const kb = err ? NaN : Number(String(out).split(/\s/)[0]);
      resolveBytes(Number.isFinite(kb) ? kb * 1024 : null);
    });
  });
}

export interface RunningHub {
  hub: Hub;
  url: string;
  token: string;
  close(): Promise<void>;
}

export { isLoopback };

/** Start a hub on a folder of workspaces. */
export async function startHub(options: HubOptions): Promise<RunningHub> {
  const hub = new Hub(options);
  return { hub, url: localUrl(await hub.start()), token: hub.token, close: () => hub.close() };
}

/** A folder in `parent` called `name`, or `name 2`, `name 3`… if there is one already. */
function freeFolder(parent: string, name: string): string {
  let to = join(parent, name);
  for (let i = 2; existsSync(to); i++) to = join(parent, `${name} ${i}`);
  return to;
}

/**
 * Move a folder: renamed, if it stays on the same disk; else copied, and the
 * original removed only once the copy is whole (a copy that fails is removed instead).
 */
async function moveFolder(from: string, to: string): Promise<void> {
  try {
    return await rename(from, to);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EXDEV') throw e;
  }
  try {
    await cp(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true });
  } catch (e) {
    await rm(to, { recursive: true, force: true }).catch(() => undefined);
    throw e;
  }
  await rm(from, { recursive: true, force: true, maxRetries: 5 });
}

/** Whether two paths are the same folder (links followed; on Windows, case aside). */
function sameFolder(a: string, b: string): boolean {
  const real = (p: string) => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const [x, y] = [real(a), real(b)];
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
}
