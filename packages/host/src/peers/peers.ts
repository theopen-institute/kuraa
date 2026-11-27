// The host as one of a workspace's devices (see docs/decisions/0028-peers.md).
//
// Git between devices: when a device connects, or says its branches moved, this
// one fetches them (into `<device>/<branch>`) and brings them into its own
// branches: a fast-forward, or a merge made as every device makes it (0025), so
// devices converge without merging each other's merges. When this device's
// branches move, it tells the others. Rooms across devices: rooms.ts.
//
// Every member's work comes in, on every branch (0038): all devices of a
// workspace have the same say. The one exception is about convergence, not
// trust: between two devices that merge differently (another version of
// kuraa), only the one with the lower key makes the merges, and the other
// takes them.
import { NotBrought, WaitingForPolicy, describeOutcome, type Host } from '../host.js';
import { gate, policyWaits, type GateResult } from './gate.js';
import { commitSigner } from '../signing.js';
import { digestOf } from './node.js';
import { clashWords } from './clashes.js';
import { isAncestor, mergeTrailerValue } from '../merging.js';
import { randomBytes } from 'node:crypto';
import { PEER_SPACES } from './node.js';
import { spaceRef } from '../spaces.js';
import { PROTOCOL, type PeerLink } from './link.js';
import { PeerNode, type NodeEvents, type Via } from './node.js';
import { Rooms } from './rooms.js';
import { SharedOutputs, liveRun, outputRefs } from './outputs.js';
import type { Person } from './person.js';
import { WORKSPACE, hashedPath, isGroupName, isRulePath, isWriter, pathsAbove, type JoinRole, type Perm, type Policy, type PolicyOp, type Role } from './policy.js';
import type { ClashInfo } from './clashes.js';
import { NotAllowed } from '../errors.js';
import type { KeyPair } from '../keys.js';

/** How soon this device tells the others its outputs changed, in ms: sooner than branches, which come in bursts. */
const OUTPUTS_ANNOUNCE_MS = 20;

export interface PeerOptions {
  /** DHT bootstrap nodes (`host:port`): a private network, or tests. Default: Hyperswarm's public ones. */
  bootstrap?: (string | { host: string; port: number })[];
  /** The most one fetch from a device may bring, in bytes. */
  maxFetchBytes?: number;
  /** How long publishing run outputs waits after a change, in ms (outputs.ts; tests). */
  outputsPublishMs?: number;
  /** This computer's person's identity (person.ts); default: the one this computer keeps, if any. Tests give their own. */
  person?: Person | null;
  /** This computer's signing key (person.ts); default: the one this computer keeps, made on first use. Tests give their own. */
  signing?: KeyPair;
  /** How long a device is dialled for, and when the workspace is looked up again while one is missing, in ms (PeerNode; tests). */
  dialMs?: number;
  lookupsMs?: number[];
  /** Relays run by someone, by key (relay.ts; `--relay`): gone through when no member offers one. */
  relays?: string[];
  /** Offer the other members a relay when this network allows (relay.ts). Default: yes. */
  offerRelay?: boolean;
  /** Find devices on the local network too, with or without the internet (lan.ts). Default: yes. */
  lan?: boolean;
  /** A server's (0053): take connections over TCP on this port, for devices on networks that block UDP. */
  peerPort?: number;
  /** A server's: where others reach it over TCP (`host:port`, or a host with peerPort), told to members and in invite links. */
  publicAddress?: string;
  /** A server's: its DHT node on this port, for members to start from (with publicAddress). */
  dhtPort?: number;
  /** false: never serve the public DHT. */
  serveDht?: boolean;
  /** Tests (node.ts): whether a device can be reached directly, which computer this one is on, how soon to go through another device. */
  direct?: (key: string) => boolean;
  computer?: string;
  tunnelAfterMs?: number;
  /**
   * A node that has just joined this workspace (join.ts, with `keep`), still
   * connected: gone on with (PeerNode.becomeMember) instead of starting another.
   */
  node?: PeerNode;
}

export interface DeviceInfo {
  name: string;
  key: string;
  /** Whose device it is, as their identity says (0035); null if it does not say. */
  person: string | null;
  /** A server's device (0099): in as itself, no person's. */
  server: boolean;
  /** Connected to this device. */
  online: boolean;
  /**
   * Not connected to this device, but to these (their keys), which say so: it is
   * online, and its work reaches this device through them.
   */
  through: string[];
  /**
   * It merges differently from this device (another version of kuraa, say).
   * Between the two, only the one with the lower key makes merges; the other
   * takes them, so their histories never part.
   */
  otherVersion: boolean;
  /** A fork of this workspace, or the workspace this one was forked from: fetched from, never merged on its own. */
  related: boolean;
  /**
   * It runs a kuraa that speaks another protocol (link.ts, PROTOCOL): newer (this
   * one is to be updated) or older (it is). The two do not sync until then.
   */
  kuraa: 'newer' | 'older' | null;
  /** How it is connected here (0053): on the local network, over TCP to a server, through another device, or over the internet (the DHT, directly or by a relay). */
  via: Via | null;
  /** When it was last connected here (ms since 1970), if ever. */
  lastSeen: number | null;
}

export interface PeersStatus {
  /** This device, and whose it is (null if no identity says). */
  device: { name: string; key: string; person: string | null };
  /** What this computer's network is like for connecting (PeerNode.network). */
  network: ReturnType<PeerNode['network']>;
  workspace: { id: string; forkedFrom: string | null };
  devices: DeviceInfo[];
  /**
   * This device was removed from the workspace: it took the record of it, and no
   * longer syncs. A device offline when it was removed is never told (the others
   * no longer let it reach them): see noContactSince.
   */
  removed: boolean;
  /**
   * Since when (ms since 1970) no other device has been connected here: the last
   * time one was, or when syncing started here if later. Null while one is
   * connected, or if there are no others. A long time may mean they are all
   * offline, or that this device was removed while it was.
   */
  noContactSince: number | null;
  /** The people of the workspace, as its policy says (0066). */
  people: PeopleInfo;
}

/** Who may change a file (0066). */
export interface FileAccess {
  canWrite: boolean;
  /** The rule that counts for it: its path, who it names in words, and as the policy says it; null if none (anyone may). */
  rule: { path: string; by: string[]; who: string[] } | null;
  /** Whether this person may make rules (an admin of the workspace). */
  admin: boolean;
  /** This person (identity ID). */
  you: string | null;
  /** Who reads it: null for everyone in the workspace; else its space's audience, and that in words (0066). */
  readers: { audience: string[]; words: string } | null;
  /** This person's changes to it that were not kept (0072: they could not change it), newest first: to tell them, once. */
  notKept: { commit: string; date: string }[];
}

/** An audience in words: "Only you", "Ada and Bo", "editors", "admins". */
export function audienceWords(audience: string[], me: string | null, names: Map<string, string>): string {
  if (audience.length === 1 && audience[0] === me) return 'Only you';
  // You first: "You and Bo".
  const ordered = [...audience].sort((x, y) => Number(y === me) - Number(x === me));
  const words = ordered.map((w, i) => (w === me ? (i === 0 ? 'You' : 'you') : w === 'admins' ? 'admins' : w.startsWith('group:') ? w.slice(6) : names.get(w) ?? `${w.slice(0, 8)}…`));
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** The workspace's groups and write rules (0066). */
export interface RulesInfo {
  /** Whether this person may change them. */
  admin: boolean;
  rules: { path: string; by: string[] }[];
  groups: { name: string; entries: { who: string; role: Role; name: string | null }[] }[];
  /** Every file's and folder's permission (0069): its path (null: private, not one this device knows), who may change it, who reads what is made there. */
  permissions: { path: string | null; private: boolean; write: string[] | null; read: string[] | null }[];
  /**
   * Clashes settled (0078), the latest first: changes made at the same time of
   * which the one giving less counted; each in words, and whether this person
   * may make the one that lost again (an admin, as the change needs).
   */
  clashes: ClashInfo[];
  /** A workspace from before 0066, to be founded again (0078): its owner's name (null: none, any admin may), and whether this person may. Null: founded. */
  refound: { owner: string | null; may: boolean } | null;
}

/** A file's or folder's permissions (0069), for its Permissions… dialog. */
export interface PermissionsInfo {
  path: string;
  folder: boolean;
  /** Its own: who may change it, and (a folder's) who reads what is made in it; null for none. */
  own: { write: string[] | null; read: string[] | null } | null;
  /** What it has from the folders above it, or the workspace: who may change it, who reads it. */
  fromAbove: { write: { path: string; by: string[] } | null; read: { path: string; audience: string[] } | null };
  /** A file's readers now: its space's audience; null for everyone. */
  readers: string[] | null;
  /** Whether this person is an admin (says who changes what, and who reads a folder). */
  admin: boolean;
  /** Whether this person may change it (a file: says who reads it). */
  canWrite: boolean;
}

/** The workspace's people, by its policy (0066). */
export interface PeopleInfo {
  /** Whether the workspace has a policy yet (no: every member has the same say, 0038). */
  founded: boolean;
  /** Whether this person may invite people, remove devices and change who is in it. */
  admin: boolean;
  /** The workspace's owner (0070); null: one from before that has none. */
  owner: string | null;
  /** Whether this person makes, unmakes and takes out admins: the owner. */
  assignsAdmins: boolean;
  people: { id: string; role: Role | 'owner'; name: string | null; devices: string[]; you: boolean }[];
  /**
   * The servers in the workspace (0099): each by its key, what its devices call
   * themselves, its devices here, and whether this is one of them.
   */
  servers: { key: string; name: string; devices: string[]; you: boolean }[];
  /** Whether this person invites and removes servers: the owner (0099). */
  managesServers: boolean;
  /**
   * The latest removals (0072: people taken out, computers dropped; 0099:
   * servers), each with the names of those whose devices hold it so far.
   */
  removals: { kind: 'person' | 'computer' | 'server' | 'server-out'; who: string; by: string | null; confirmedBy: string[] }[];
}

/** An invite link this device made, and whether it still lets people in. */
export interface LinkInfo {
  id: string;
  created: number;
  /** When it stops working (ms since 1970); 0: never. */
  expires: number;
  /** For one person: the first device it lets in uses it up. */
  once: boolean;
  state: 'active' | 'expired' | 'revoked' | 'used';
}

/** A device's kuraa beside this one's, from the protocol it speaks; null: the same, or not known. */
const versionOf = (p: number | undefined) => (p === undefined || p === PROTOCOL ? null : p > PROTOCOL ? 'newer' : 'older');

export class Peers {
  readonly node: PeerNode;
  readonly rooms: Rooms;
  /** Run outputs shared with the other devices (outputs.ts); set once started. */
  outputs: SharedOutputs | null = null;
  private stopOutputs: (() => void) | null = null;
  private readonly fetching = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  /** Fetching run outputs from a device, beside its branches (0062); and asked again meanwhile. */
  private readonly fetchingOutputs = new Map<string, Promise<void>>();
  private readonly againOutputs = new Set<string>();
  /** Work waiting on a device that merges differently, already logged: `remote/branch`. */
  private readonly waiting = new Set<string>();
  /**
   * A device's sync to try again (0071): a fetch failed, work waits for its
   * policy, or bringing something in failed. One timer per device, backing off
   * (to a minute), and at once when records come (the policy may be among them).
   */
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private readonly retryMs = new Map<string, number>();
  /** The latest link to each device: a sync under way reads it each round (one that reconnected meanwhile said other heads). */
  private readonly linkTo = new Map<string, PeerLink>();
  /** What each link last said of its branches and spaces: outputs alone need no sync of branches. */
  private readonly refsSaid = new WeakMap<PeerLink, string>();
  /** Spaces from a device not brought in as they were (NotBrought), already logged: `remote/ref` → commit. */
  private readonly notBrought = new Map<string, string>();
  /** The workspace's policy and what goes with it for judging work, as of a set of records (gate). */
  private gateCache: { digest: string; ctx: Promise<Omit<import('./gate.js').GateContext, 'remake' | 'mergeTrailer'> | null> } | null = null;
  private announceTimer: NodeJS.Timeout | undefined;
  private stopRefs: (() => void) | null = null;
  private closed = false;
  /** When syncing started here (ms since 1970): no device connected since then, at the most, for noContactSince. */
  private readonly started = Date.now();

  private readonly events: NodeEvents = {
    accepted: (link) => {
      this.rooms.connected(link);
      this.refsSaid.set(link, JSON.stringify([link.heads, link.spaces]));
      this.syncFrom(link);
      this.syncOutputs(link);
    },
    closed: (link) => {
      this.rooms.disconnected(link);
      this.outputs?.disconnected(link.key);
      const remote = link.remote;
      if (remote && this.linkTo.get(remote) === link) {
        this.linkTo.delete(remote);
        clearTimeout(this.retries.get(remote));
        this.retries.delete(remote);
      }
    },
    refs: (link) => {
      // Its branches or spaces moved: synced. Outputs alone (said often, while code runs): only those (0071).
      const said = JSON.stringify([link.heads, link.spaces]);
      if (this.refsSaid.get(link) !== said || !link.heads) {
        this.refsSaid.set(link, said);
        this.syncFrom(link);
      }
      this.syncOutputs(link);
    },
    // Records came (the policy work waits for may be among them): what waits is tried again now.
    members: () => this.retryNow(),
    // Operations its commits name that it does not hold: not waited for (knownFrom).
    unheld: (link, ids) => {
      const had = this.unheld.get(link.key) ?? new Set<string>();
      for (const id of ids) had.add(id);
      this.unheld.set(link.key, had);
      this.retryNow();
    },
    room: (link, m) => this.rooms.message(link, m),
    outputs: (link, frame) => void this.outputs?.receive(link.key, frame),
  };

  constructor(private readonly host: Host, private readonly opts: PeerOptions, stateDir: string) {
    this.node = opts.node ?? new PeerNode({
      dir: host.dir,
      stateDir,
      bootstrap: opts.bootstrap,
      maxFetchBytes: opts.maxFetchBytes,
      dialMs: opts.dialMs,
      lookupsMs: opts.lookupsMs,
      relays: opts.relays,
      offerRelay: opts.offerRelay,
      lan: opts.lan,
      peerPort: opts.peerPort,
      publicAddress: opts.publicAddress,
      dhtPort: opts.dhtPort,
      serveDht: opts.serveDht,
      direct: opts.direct,
      computer: opts.computer,
      tunnelAfterMs: opts.tunnelAfterMs,
      ...this.memberOptions(),
    }, this.events);
    this.rooms = new Rooms(host, this.node);
    // A device opened a document: the runs of it under way here, so it shows them as they go on.
    this.rooms.onOpened = (link, path) => {
      for (const run of this.host.runner.pending(path)) {
        const frame = liveRun(run);
        if (frame) link.sendOutputs(frame);
      }
    };
    this.stateDir = stateDir;
    // Who may change what, where work comes in (0066).
    host.gate = (x, y, space) => this.gate(x, y, space ?? null);
  }

  private readonly stateDir: string;

  /** The workspace's write rules, applied to the commits `y` brings to `x` (gate.ts). */
  private async gate(x: string | null, y: string, space: string | null = null): Promise<GateResult> {
    const ctx = await this.gateContext();
    if (!ctx) return { keeps: new Map(), refused: [], waitFor: [] };
    return gate(this.host.git, x, y, { ...ctx, space, known: this.knownFrom(ctx.known, this.bringing), remake: (a, b) => this.host.remakeMergeTree(a, b), mergeTrailer: mergeTrailerValue(this.host.mergeSignature) });
  }

  /**
   * The policy operations commits from a device are judged knowing (gate.ts):
   * those held here, and those the device said it does not hold, though its
   * commits name them (node.ts, ops). A device holds every operation the commits
   * it has name (it waited for them itself, or made them): one that does not
   * named one that is no one's, and its commits are judged by the policy held,
   * not waited on for ever.
   */
  private knownFrom(known: Set<string>, device: string | null): Set<string> {
    const unheld = device ? this.unheld.get(device) : undefined;
    return unheld?.size ? new Set([...known, ...unheld]) : known;
  }

  /** Operations a device said it does not hold, though commits it sent name them (knownFrom). */
  private readonly unheld = new Map<string, Set<string>>();
  /** The device whose work is being brought in (inside host.serial): whose commits the gate judges. */
  private bringing: string | null = null;

  /** Ask a device for the policy operations its commits name that this one lacks; those it does not hold, it says (unheld). */
  private askFor(link: PeerLink, ops: string[]): void {
    const unheld = this.unheld.get(link.key);
    const ask = ops.filter((id) => !unheld?.has(id)).slice(0, 100);
    if (ask.length) link.send({ type: 'ops', ids: ask });
  }

  /** The policy, people and cutoffs work is judged by, worked out once for each set of records (0071); null: no policy. */
  private async gateContext() {
    const id = this.node.identity;
    const records = await id.records();
    const digest = digestOf(records);
    if (this.gateCache?.digest !== digest) {
      const ctx = (async () => {
        const policy = await id.policy(records);
        if (!policy.founded) return null;
        const people = await id.people();
        const byKey = new Map(people.flatMap((p) => p.keys.map((k) => [k, p.key] as const)));
        const names = new Map(people.map((p) => [p.key, p.name]));
        const known = new Set(records.filter((r) => r.kind === 'policy').map((r) => r.subject));
        // Servers, now or before (0099): the keys whose joins as a server counted.
        const servers = await id.everServers(records);
        return { policy, known, servers, personOf: (k: string) => byKey.get(k) ?? null, nameOf: (p: string) => names.get(p) ?? (servers.has(p) ? 'a server' : null), cutKeys: await id.cutKeys() };
      })();
      this.gateCache = { digest, ctx };
      ctx.catch(() => {
        if (this.gateCache?.ctx === ctx) this.gateCache = null;
      });
    }
    return this.gateCache.ctx;
  }

  /** The policy operations the commits `theirs` brings to `ours` name and this device lacks (gate.ts, policyWaits). */
  private async policyWaits(ours: string | null, theirs: string, device: string): Promise<string[]> {
    const ctx = await this.gateContext();
    return ctx ? policyWaits(this.host.git, ours, theirs, this.knownFrom(ctx.known, device)) : [];
  }

  /** Try a device's sync again later, backing off (0071). */
  private retryLater(remote: string): void {
    if (this.closed || this.retries.has(remote)) return;
    const ms = Math.min((this.retryMs.get(remote) ?? 1000) * 2, 60_000);
    this.retryMs.set(remote, ms);
    const timer = setTimeout(() => {
      this.retries.delete(remote);
      const link = this.linkTo.get(remote);
      if (link && link.accepted && !link.closed) void this.syncFrom(link);
    }, ms);
    timer.unref();
    this.retries.set(remote, timer);
  }

  /** Try every sync that waits now (records came). */
  private retryNow(): void {
    for (const [remote, timer] of [...this.retries]) {
      clearTimeout(timer);
      this.retries.delete(remote);
      const link = this.linkTo.get(remote);
      if (link && link.accepted && !link.closed) void this.syncFrom(link);
    }
  }

  /** Work held back until the policy it names has come: tried again shortly (gate.ts). */
  private readonly waitingForPolicy = new Set<string>();

  /** What the node needs of this host (the same for a node just joined). */
  private memberOptions() {
    return {
      git: this.host.git,
      branch: () => this.host.git.branch(),
      log: (m: string) => this.host.log(m),
      merges: this.host.mergeSignature,
      person: this.opts.person,
      signing: this.opts.signing,
    };
  }

  async start(): Promise<void> {
    // A link in another device's commits is checked out as a file holding where it points, never as a link (gate.ts refuses them too).
    await this.host.git.run(['config', 'core.symlinks', 'false'], { allowFail: true });
    if (this.opts.node) await this.node.becomeMember(this.memberOptions(), this.events);
    else await this.node.start(true);
    this.stopRefs = this.host.onRefsChanged(() => this.announce());
    const identity = this.node.identity;
    this.outputs = new SharedOutputs({
      git: this.host.git,
      myKey: this.node.myKey,
      stateDir: this.stateDir,
      signing: () => this.node.signingKey(),
      members: () => identity.members(),
      signerOf: (key) => identity.signingKeyOf(key),
      // Not a space's documents' (0066): this ref goes to every device of the workspace. Their outputs stay here.
      cached: async () => (await this.host.runner.cached()).filter((c) => !this.host.spaceOf(c.path)),
      forget: (ids) => this.host.runner.forgetRuns(ids),
      changed: (path, added, removed) => {
        for (const run of added) this.host.broadcastPath(path, { type: 'run', run });
        if (removed.length) this.host.broadcastPath(path, { type: 'runs-removed', path, ids: removed });
      },
      announce: () => this.announce(OUTPUTS_ANNOUNCE_MS),
      // As they happen (0062): about a run, to the devices with its document open; anything else, to every one.
      live: (frame, path) => {
        const links = path ? this.rooms.devicesWith(path) : [...this.node.links.values()].filter((l) => l.accepted && l.hello?.workspace === this.node.ws.id);
        for (const link of links) link.sendOutputs(frame);
      },
      log: (m) => this.host.log(m),
      publishMs: this.opts.outputsPublishMs,
    });
    const stopCache = this.host.runner.onCacheChanged(() => this.outputs?.publish());
    const stopRuns = this.host.runner.onRun((run) => this.outputs?.ran(run));
    this.stopOutputs = () => {
      stopCache();
      stopRuns();
    };
    await this.outputs.start();
  }

  /**
   * Tell the other devices this one's branches moved (soon, once for a burst),
   * and to what: a device that has those commits already (it brought them in
   * from another) does not fetch.
   */
  private announce(ms = 200): void {
    // One already due sooner stands.
    if (this.announceTimer && this.announceAt <= Date.now() + ms) return;
    clearTimeout(this.announceTimer);
    this.announceAt = Date.now() + ms;
    this.announceTimer = setTimeout(() => {
      this.announceTimer = undefined;
      void Promise.all([this.node.heads(), outputRefs(this.host.git)]).then(([heads, outputs]) => this.node.broadcastRefs(heads, outputs)).catch((e: Error) => this.host.log(`peers: ${e.message}`));
    }, ms);
  }

  /** When the announcement waiting is due (ms since 1970). */
  private announceAt = 0;

  /**
   * Whether this device has every branch the device says it has, as far as it
   * goes or further: then fetching its branches would bring nothing. Its
   * tracking branches (`<device>/<branch>`) are moved to what it said, as a
   * fetch would. (Run outputs are fetched apart: syncOutputs.)
   */
  private async upToDate(link: PeerLink): Promise<boolean> {
    const theirs = link.heads;
    if (!theirs) return false;
    const mine = await this.node.heads();
    for (const [branch, oid] of Object.entries(theirs)) {
      const here = mine[branch];
      if (here === oid) continue;
      if (!here || !(await isAncestor(this.host.git, oid, here))) return false;
    }
    const remote = link.remote!;
    // Its spaces this person may read, likewise (0066): each held here as far, in this device's history of it.
    for (const [name, oid] of Object.entries(link.spaces ?? {})) {
      const m = /^([0-9a-f]{32})\/(.+)$/.exec(name);
      if (!m) continue;
      const here = (await this.host.git.run(['rev-parse', '-q', '--verify', `${spaceRef(m[1]!, m[2]!)}^{commit}`], { allowFail: true })).stdout.trim();
      if (here !== oid && (!here || !(await isAncestor(this.host.git, oid, here)))) return false;
    }
    const tracking = new Map((await this.branchesOf(remote)).map((b) => [b.branch, b.oid]));
    // Each from what it was (0071): a fetch under way meanwhile is not moved back.
    const zero = '0'.repeat(Object.values(theirs)[0]?.length ?? 40);
    const moves = Object.entries(theirs).filter(([b, oid]) => tracking.get(b) !== oid).map(([b, oid]) => `update refs/remotes/${remote}/${b} ${oid} ${tracking.get(b) ?? zero}\n`);
    if (moves.length) await this.host.git.run(['update-ref', '--stdin'], { input: moves.join(''), allowFail: true });
    return true;
  }

  /** Fetch from a device and bring its work in; one at a time per device, again if asked meanwhile. */
  syncFrom(link: PeerLink): Promise<void> {
    if (this.closed) return Promise.resolve();
    const remote = link.remote!;
    // The newest link to it counts, whichever started the sync under way.
    if (!link.closed || !this.linkTo.has(remote)) this.linkTo.set(remote, link);
    const running = this.fetching.get(remote);
    if (running) {
      this.again.add(remote);
      return running;
    }
    const run = (async () => {
      do {
        this.again.delete(remote);
        const l = this.linkTo.get(remote) ?? link;
        if (l.closed) return;
        if (await this.upToDate(l)) {
          this.retryMs.delete(remote);
          continue;
        }
        const asked = Date.now();
        // Not fetched (the network, the device busy): tried again, and anything asked meanwhile still is.
        if (!(await this.node.fetch(remote))) {
          this.retryLater(remote);
          continue;
        }
        this.outputs?.timing(`fetched branches from ${remote} in ${Date.now() - asked} ms`);
        if (l.hello?.workspace !== this.node.ws.id) return; // a fork: fetched, never merged on its own
        if (this.closed) return;
        if (await this.bringIn(l)) this.retryLater(remote);
        else this.retryMs.delete(remote);
      } while (this.again.has(remote) && !this.closed);
    })().catch((e: Error) => {
      this.host.log(`peers: syncing with ${remote} failed: ${e.message}`);
      this.retryLater(remote);
    }).finally(() => this.fetching.delete(remote));
    this.fetching.set(remote, run);
    return run;
  }

  /**
   * Fetch the run outputs a device has that this one lacks, and take them: in a
   * queue of their own (0062), so they never wait on its branches being
   * brought in (a merge, rooms settling). One at a time per device, again if
   * asked meanwhile.
   */
  syncOutputs(link: PeerLink): Promise<void> {
    if (this.closed || !this.outputs || link.hello?.workspace !== this.node.ws.id) return Promise.resolve();
    const remote = link.remote!;
    const running = this.fetchingOutputs.get(remote);
    if (running) {
      this.againOutputs.add(remote);
      return running;
    }
    const run = (async () => {
      do {
        this.againOutputs.delete(remote);
        if (!(await this.outputs!.lacks(link.outputs))) continue;
        const asked = Date.now();
        if (!(await this.node.fetchOutputs(remote))) return;
        this.outputs!.timing(`fetched outputs from ${remote} in ${Date.now() - asked} ms`);
        await this.outputs!.adopt(remote, link.key);
      } while (this.againOutputs.has(remote) && !this.closed);
    })().catch((e: Error) => this.host.log(`peers: taking ${remote}’s run outputs failed: ${e.message}`)).finally(() => this.fetchingOutputs.delete(remote));
    this.fetchingOutputs.set(remote, run);
    return run;
  }

  /** Sync with every connected device now. */
  async syncAll(): Promise<string> {
    const links = [...this.node.links.values()].filter((l) => l.accepted);
    await Promise.all(links.flatMap((l) => [this.syncFrom(l), this.syncOutputs(l)]));
    return links.length ? `Synced with ${links.map((l) => l.remote).join(', ')}` : 'No other device is connected';
  }

  /** The branches a device has, from what was fetched. */
  private async branchesOf(remote: string): Promise<{ branch: string; oid: string }[]> {
    const out = await this.host.git.out(['for-each-ref', '--format=%(refname)%00%(objectname)', `refs/remotes/${remote}/`]);
    return out.split('\n').filter(Boolean).map((l) => {
      const [ref, oid] = l.split('\0');
      return { branch: ref!.slice(`refs/remotes/${remote}/`.length), oid: oid! };
    }).filter((b) => b.branch !== 'HEAD');
  }

  /**
   * Bring a device's branches in. Of two devices, the one with the lower key
   * makes the merges, and the other only fast-forwards (0077): two devices that
   * merge differently would each make their own merge of the same work, and
   * their histories would part; and devices that each merged the others' merges
   * at once would each make a new one, and could go on so for ever.
   */
  private async bringIn(link: PeerLink): Promise<boolean> {
    const remote = link.remote!;
    const forwardOnly = link.key < this.node.myKey;
    let retry = false;
    // Each on its own (0071): one that fails (a file in the way, the policy not here yet) holds up none of the others.
    for (const { branch, oid } of await this.branchesOf(remote)) {
      try {
        if (await this.bringBranch(branch, oid, link, forwardOnly)) retry = true;
      } catch (e) {
        this.host.log(`peers: bringing in ${branch} from ${remote} failed: ${(e as Error).message}`);
        retry = true;
      }
    }
    // Its spaces this person may read (0066): node.ts serves only those; taken only if this device's person and the
    // sender's both read the space by the policy here (0071), so no one plants a made-up space in others' folders.
    const out = await this.host.git.run(['for-each-ref', '--format=%(refname)%00%(objectname)', `${PEER_SPACES}${remote}/`], { allowFail: true });
    for (const line of out.stdout.split('\n').filter(Boolean)) {
      const [ref, oid] = line.split('\0') as [string, string];
      const m = new RegExp(`^${PEER_SPACES}${remote}/([0-9a-f]{32})/heads/(.+)$`).exec(ref);
      if (!m) continue;
      const [, id, branch] = m as unknown as [string, string, string];
      const key = `${remote}/${ref}`;
      const mineAccess = this.node.spaceAccess(this.node.myKey, id);
      const theirsAccess = this.node.spaceAccess(link.key, id);
      // Its operation not here yet: tried again once it may have come.
      if (mineAccess === 'unknown' || theirsAccess === 'unknown') {
        retry = true;
        continue;
      }
      if (mineAccess === 'no' || theirsAccess === 'no') continue;
      try {
        if (await this.bringSpace(id, branch, oid, link, forwardOnly, key)) retry = true;
      } catch (e) {
        if (e instanceof NotBrought) {
          if (this.notBrought.get(key) !== oid) this.host.log(`peers: ${remote}'s history of a space ${e.message}`);
          this.notBrought.set(key, oid);
          continue;
        }
        this.host.log(`peers: bringing in a space's ${branch} from ${remote} failed: ${(e as Error).message}`);
        retry = true;
      }
    }
    return retry;
  }

  /** Whether `mine` holds `theirs` already (nothing to bring in), or the commit is not here. */
  private async holds(mine: string, theirs: string): Promise<boolean> {
    return !!mine && (mine === theirs || (await isAncestor(this.host.git, theirs, mine)));
  }

  /** Bring a device's history of a space in (Host.bringSpace), as a branch is (bringBranch). Whether it waits for the policy. */
  private async bringSpace(id: string, branch: string, oid: string, link: PeerLink, forwardOnly: boolean, key: string): Promise<boolean> {
    const own = spaceRef(id, branch);
    const mineNow = async () => (await this.host.git.run(['rev-parse', '-q', '--verify', `${own}^{commit}`], { allowFail: true })).stdout.trim();
    if (await this.holds(await mineNow(), oid)) return false;
    return this.host.serial(async () => {
      // Closing: brought in no more (the write rules are let go of once syncs have stopped).
      if (this.closed) return false;
      const mine = await mineNow();
      if (await this.holds(mine, oid)) return false;
      // Merging differently (0071): as for branches, only the other makes the merges.
      if (forwardOnly && mine && !(await isAncestor(this.host.git, mine, oid))) {
        if (!this.waiting.has(key) && this.node.mergesDiffer(link.key)) this.host.log(`peers: ${link.remote} merges differently from this device (another version of kuraa?); its work in a space comes in once it has merged this device's`);
        this.waiting.add(key);
        return false;
      }
      this.waiting.delete(key);
      const waits = await this.policyWaits(mine || null, oid, link.key);
      try {
        if (waits.length) throw new WaitingForPolicy(waits);
        this.bringing = link.key;
        const outcome = await this.host.bringSpace(id, branch, oid).finally(() => void (this.bringing = null));
        this.waitingForPolicy.delete(key);
        this.notBrought.delete(key);
        if (outcome.kind !== 'same') this.host.log(`peers: brought in a space's ${branch} from ${link.remote}${describeOutcome(outcome)}`);
        return false;
      } catch (e) {
        if (!(e instanceof WaitingForPolicy)) throw e;
        this.askFor(link, e.heads);
        if (!this.waitingForPolicy.has(key)) this.host.log(`peers: ${link.remote}'s work in a space is ${e.message}`);
        this.waitingForPolicy.add(key);
        return true;
      }
    });
  }

  /**
   * Bring a device's commit into a branch (Host.bringBranch). `forwardOnly`: only
   * if no merge is needed (the other device will make it, and this one take it then).
   * The commit as checked, not its ref again (a fetch may move that meanwhile).
   * Whether it waits for the workspace's policy (tried again).
   */
  private async bringBranch(branch: string, oid: string, link: PeerLink, forwardOnly: boolean): Promise<boolean> {
    const mineNow = async () => (await this.host.git.run(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true })).stdout.trim();
    // Held already: nothing to do, and nothing waits in the queue for it (0071).
    if (await this.holds(await mineNow(), oid)) return false;
    return this.host.serial(async () => {
      if (this.closed) return false;
      const current = await this.host.git.branch();
      const mine = await mineNow();
      if (await this.holds(mine, oid)) return false;
      const from = link.remote ?? branch;
      if (forwardOnly && mine && !(await isAncestor(this.host.git, mine, oid))) {
        if (!this.waiting.has(`${from}/${branch}`) && this.node.mergesDiffer(link.key)) this.host.log(`peers: ${from} merges differently from this device (another version of kuraa?); its work on ${branch} comes in once it has merged this device's`);
        this.waiting.add(`${from}/${branch}`);
        return false;
      }
      this.waiting.delete(`${from}/${branch}`);
      let outcome;
      try {
        // Waiting for the policy is known before the room's edits are committed for it (0071).
        const waits = await this.policyWaits(mine || null, oid, link.key);
        if (waits.length) throw new WaitingForPolicy(waits);
        this.bringing = link.key;
        outcome = await this.host.bringBranch(branch, oid).finally(() => void (this.bringing = null));
      } catch (e) {
        if (!(e instanceof WaitingForPolicy)) throw e;
        this.askFor(link, e.heads);
        // The policy travels with the records, which come with every hello: soon (retryLater, retryNow).
        if (!this.waitingForPolicy.has(`${from}/${branch}`)) this.host.log(`peers: ${from}'s work on ${branch} is ${e.message}`);
        this.waitingForPolicy.add(`${from}/${branch}`);
        return true;
      }
      this.waitingForPolicy.delete(`${from}/${branch}`);
      if (branch === current && outcome.kind !== 'same') this.host.log(`peers: brought in ${branch} from ${from}${describeOutcome(outcome)}`);
      return false;
    });
  }

  /**
   * Make an invite link (CLI: kuraa-host invite): for one person (`once`: the
   * first device it lets in uses it up) or anyone with it, until it expires
   * (`hours`; null: never) or is revoked.
   */
  async inviteLink(o: { hours: number | null; once: boolean; role?: JoinRole; group?: string }): Promise<string> {
    // With the ways in besides the DHT this device knows: relays named, servers that take TCP (0053).
    // Putting its holder in a group, signed by this person (0066): the workspace, as a member, unless it says otherwise.
    const person = await this.node.person();
    const grant = person ? { key: await this.node.signingKeyNow(), group: o.group, role: o.role } : undefined;
    // A link for a server (0099) lets one in.
    const link = await this.node.identity.createLink(o.hours, o.role === 'server' || o.once, await this.node.linkHints(), grant);
    // On record, so every member announces its topic while it lets people in (0050).
    await this.node.membersChanged();
    return link;
  }

  /** The invite links this device made, and whether each still lets people in. */
  async links(): Promise<LinkInfo[]> {
    const revoked = await this.node.identity.revokedLinks();
    const used = await this.node.identity.usedLinks();
    return (await this.node.identity.links()).map((l) => ({
      id: l.id,
      created: l.created,
      expires: l.expires,
      once: !!l.once,
      state: used.includes(l.id) ? 'used' : revoked.includes(l.id) ? 'revoked' : l.expires && l.expires < Date.now() ? 'expired' : 'active',
    }));
  }

  /** Revoke an invite link, on record, and tell the other devices. */
  async revokeLink(id: string): Promise<void> {
    // Unlinked in the policy too (0066): no join by it counts after, whoever holds its grant.
    await this.node.identity.revokeLink(id, await this.node.signingKeyNow());
    await this.node.membersChanged();
  }

  /**
   * Remove a device from the workspace, for good, and tell the others: its own
   * person (or an admin; the owner, for an admin's computer). It keeps its copy.
   * Its signing key is revoked (one's own, where this computer keeps one's
   * identity: in every workspace) or dropped here (0072), with the commits this
   * device has; what it signs from now on counts for nothing. The workspace's
   * secret is made anew, so the device, which knew the old one, can no longer
   * find the others (0050).
   */
  async removeDevice(key: string): Promise<{ revoked: boolean }> {
    if (key === this.node.myKey) throw new Error('This is this device: another device removes it');
    if (!(await this.node.identity.members()).some((m) => m.key === key)) throw new Error('No such device in this workspace');
    // An admin, or the same person: one's own lost or retired computer (0068).
    if (!(await this.node.identity.mayRemove(this.node.myKey, key))) throw new NotAllowed('Only an admin of this workspace (the owner, for an admin’s), or whoever it is, can remove a computer');
    // One's own: its signing key revoked too, if this computer keeps one's identity, so what it signs from now on is no one's.
    const revoked = await this.revokeOwn(key);
    const target = await this.node.identity.signingKeyOf(key);
    if (!revoked && target) await this.node.identity.dropKey(target, await this.node.branchTips(), await this.node.signingKeyNow());
    await this.node.newSecret();
    // Told first, with the others (it stops syncing once it takes the record); then let go of, in any case.
    const link = this.node.links.get(key);
    await this.node.membersChanged();
    if (link) setTimeout(() => link.close(), 1000).unref();
    return { revoked };
  }

  /**
   * Revoke the signing key of one of this person's own other computers (a lost
   * or retired one), where this computer keeps their identity (person.ts), and
   * say so in this workspace at once (with its cutoff); the person's other
   * workspaces say so as they next sync. Whether it was revoked.
   */
  private async revokeOwn(device: string): Promise<boolean> {
    const id = this.node.identity;
    const me = (await this.node.person())?.id;
    const key = await id.signingKeyOf(device);
    if (!me || !key || (await id.personIdOf(device)) !== me || this.opts.person !== undefined) return false;
    const { readPerson, revokeKey } = await import('./person.js');
    const p = await readPerson();
    if (!p || p.id !== me) return false;
    try {
      await revokeKey(key);
    } catch {
      return false;
    }
    await this.node.signingKey();
    return true;
  }

  /**
   * Take a server out of the workspace (0099), the owner's to do: as a person is
   * taken out (a revoke, with the commits this device has), to be invited back
   * by a new link if the owner chooses; or, `forGood` (its key lost or stolen), a
   * drop of its key, after which no link lets that key in again. Either way the
   * workspace's secret is made anew, so its devices can no longer find the others.
   */
  async removeServer(key: string, o: { forGood?: boolean } = {}): Promise<void> {
    const { policy, me } = await this.node.policy();
    if (!policy.isServer(key)) throw new Error('No such server in this workspace');
    if (!policy.isOwner(me)) throw new NotAllowed('Only the workspace’s owner removes a server');
    const devices = (await this.node.identity.servers()).find((s) => s.key === key)?.devices.map((d) => d.key) ?? [];
    if (o.forGood) await this.node.identity.dropKey(key, await this.node.branchTips(), await this.node.signingKeyNow());
    else await this.adminOp({ t: 'revoke', group: WORKSPACE, who: key, cutoff: await this.node.branchTips() });
    await this.node.newSecret();
    await this.node.membersChanged();
    for (const d of devices) {
      const link = this.node.links.get(d);
      if (link) setTimeout(() => link.close(), 1000).unref();
    }
  }

  /** What this device is called, to people and to the devices that pair with it from now on. */
  async rename(name: string): Promise<void> {
    if (!name.trim()) throw new Error('A device needs a name');
    await this.node.identity.setDeviceName(name);
    this.node.name = await this.node.identity.deviceName();
    await this.node.membersChanged();
  }

  /**
   * The people of the workspace (0066), as its policy says: each with their role,
   * their name as their identity says it, and their devices here; and whether
   * this person may change who is in it.
   */
  async people(): Promise<PeopleInfo> {
    const id = this.node.identity;
    const { policy, me } = await this.node.policy();
    const known = new Map((await id.people()).map((p) => [p.key, p]));
    const servers = (await id.servers()).map((s) => ({ key: s.key, name: s.devices.map((d) => d.name).find(Boolean) ?? `${s.key.slice(0, 8)}…`, devices: s.devices.map((d) => d.key), you: s.key === me }));
    // A person by their name; a server (0099), now or before, by what its devices call themselves.
    const names = new Map([...[...known].map(([k, p]) => [k, p.name] as const), ...(await id.serverNames())]);
    const nameOf = (k: string) => names.get(k) || `${k.slice(0, 8)}…`;
    return {
      founded: policy.founded,
      admin: policy.founded ? policy.isAdmin(me) : true,
      // The owner (0070), and whether this person makes and unmakes admins (the owner).
      owner: policy.owner,
      assignsAdmins: policy.founded ? policy.mayAssignAdmins(me) : true,
      people: policy.people().map((p) => ({ id: p.id, role: (p.id === policy.owner ? 'owner' : p.role) as Role | 'owner', name: known.get(p.id)?.name ?? null, devices: known.get(p.id)?.devices ?? [], you: p.id === me })),
      servers,
      managesServers: policy.founded && policy.isOwner(me),
      removals: (await id.confirmations()).map((r) => ({ kind: r.kind, who: nameOf(r.who), by: r.by ? nameOf(r.by) : null, confirmedBy: r.confirmedBy.map(nameOf) })),
    };
  }


  /** Give the owner's role to someone in the workspace (the owner's to do, 0070): they stay an admin. */
  async makeOwner(person: string): Promise<void> {
    await this.adminOp({ t: 'owner', who: person });
  }

  /** Make a person of the workspace an admin, or a member (an admin's to do). */
  async setRole(person: string, role: Role): Promise<void> {
    await this.adminOp({ t: 'grant', group: WORKSPACE, who: person, role });
  }

  /**
   * Take a person out of the workspace (an admin's to do; or anyone, themselves):
   * their devices are out with them (0072), and the secret is made anew (0050).
   */
  async removePerson(person: string): Promise<void> {
    const devices = (await this.node.identity.people()).find((p) => p.key === person)?.devices ?? [];
    // With the commits this device has: what they made among them still counts, and nothing else (their cutoff).
    await this.adminOp({ t: 'revoke', group: WORKSPACE, who: person, cutoff: await this.node.branchTips() });
    if (devices.some((d) => d !== this.node.myKey)) await this.node.newSecret();
    await this.node.membersChanged();
  }

  /**
   * Who may change a file (0066), for the editor: whether this person may, the
   * rule that says so (its path, and who it names, in words). A file this
   * person may not change opens read only.
   */
  async access(path: string): Promise<FileAccess> {
    const { policy, me } = await this.node.policy();
    const space = this.host.spaceOf(path);
    const rule = policy.founded ? policy.ruleFor(path) : null;
    const names = new Map((await this.node.identity.people()).map((p) => [p.key, p.name]));
    const words = (w: string) => (w === 'admins' ? 'admins' : w.startsWith('group:') ? w.slice(6) : names.get(w) ?? `${w.slice(0, 8)}…`);
    return {
      canWrite: !policy.founded || policy.mayWrite(me, path),
      // In words, and as the policy says it (for the document's Permissions… to show and change: 0067).
      rule: rule && { path: rule.path, by: rule.by.map(words), who: rule.by },
      // Whether this person may say who changes it (make a rule): the workspace's admins (0066).
      admin: policy.founded && policy.isAdmin(me),
      you: me,
      // Who reads it: everyone in the workspace (null), or a space's audience (0066).
      readers: space ? { audience: policy.spaces.get(space)?.audience ?? [], words: audienceWords(policy.spaces.get(space)?.audience ?? [], me, names) } : null,
      notKept: await this.notKeptOf(path, me),
    };
  }

  /** A person's changes to a file that were not kept (Host.notKept), the latest few: whose each is, by its signature. */
  private async notKeptOf(path: string, me: string | null): Promise<{ commit: string; date: string }[]> {
    if (!me) return [];
    const out: { commit: string; date: string }[] = [];
    for (const { commit } of (await this.host.notKept(path)).slice(0, 20)) {
      const key = await commitSigner(this.host.git, commit);
      if (!key || (await this.node.identity.personIdOf(key)) !== me) continue;
      const date = (await this.host.git.run(['show', '-s', '--format=%aI', commit], { allowFail: true })).stdout.trim();
      if (date) out.push({ commit, date });
      if (out.length >= 5) break;
    }
    return out;
  }

  /**
   * What the file list marks (0069): for each file, who reads it (if not
   * everyone) and who may change it (if not anyone), in words; and each folder
   * with permissions of its own.
   */
  async marks(paths: string[]): Promise<{ files: Map<string, { readers?: string; writers?: string }>; folders: { path: string; readers?: string; writers?: string }[] }> {
    const { policy, me } = await this.node.policy();
    const names = new Map((await this.node.identity.people()).map((p) => [p.key, p.name]));
    const words = (who: string[]) => audienceWords(who, me, names);
    const readers = await this.readersInWords();
    const files = new Map<string, { readers?: string; writers?: string }>();
    const folders = new Set<string>();
    for (const path of paths) {
      const space = this.host.spaceOf(path);
      const rule = policy.founded ? policy.ruleFor(path) : null;
      const m = { ...(space ? { readers: readers.get(space) ?? '' } : {}), ...(rule ? { writers: words(rule.by) } : {}) };
      if (m.readers !== undefined || m.writers !== undefined) files.set(path, m);
      for (const f of pathsAbove(path).slice(1)) if (f) folders.add(f);
    }
    const marked: { path: string; readers?: string; writers?: string }[] = [];
    for (const f of [...folders].sort()) {
      const own = policy.permAt(f)?.perm;
      if (own) marked.push({ path: f, ...(own.read ? { readers: words(own.read) } : {}), ...(own.write ? { writers: words(own.write) } : {}) });
    }
    return { files, folders: marked };
  }

  /** Who reads each space, in words ("Only you", "Ada and Bo", "editors"), for the file list (0066). */
  async readersInWords(): Promise<Map<string, string>> {
    const { policy, me } = await this.node.policy();
    const names = new Map((await this.node.identity.people()).map((p) => [p.key, p.name]));
    const out = new Map<string, string>();
    for (const [id, s] of policy.spaces) out.set(id, audienceWords(s.audience, me, names));
    return out;
  }

  /**
   * Who may read a file (0066, 0072): everyone in the workspace (`null`), or
   * an audience (people's IDs, `group:<name>`, `admins`), which must include
   * this person. The audience its folder has puts it in the folder's space.
   * Any other is a space of the file's own: where it has one already (it alone
   * is in it, and it is no folder's), that space's readers change, its history
   * going to whoever is added; else one is made, and the file moves there as
   * it is now, its history staying with those who read it then.
   */
  async setAudience(path: string, audience: string[] | null): Promise<void> {
    const { policy, me } = await this.node.policy();
    if (!policy.founded || !me) throw new NotAllowed('Who reads what is for a workspace shared with other people, once it has a policy');
    if (!(await this.access(path)).canWrite) throw new NotAllowed('Only someone who may change this file says who reads it');
    const wanted = audience && this.cleanAudience(audience);
    const current = this.host.spaceOf(path);
    const folder = policy.readFor(path);
    let target: string | null;
    if (!wanted) target = null;
    else if (folder && folder.audience.join() === wanted.join()) target = folder.space ?? (await this.spaceFor(wanted));
    else if (current && this.ownSpace(policy, current, path)) {
      await this.changeSpace(current, wanted);
      if (!(await this.node.policy()).policy.mayRead(me, current)) throw new NotAllowed('You would not be able to read it yourself: include yourself');
      return;
    } else target = await this.newSpace(wanted);
    if (target && !(await this.node.policy()).policy.mayRead(me, target)) throw new NotAllowed('You would not be able to read it yourself: include yourself');
    await this.host.moveToSpace(path, target);
  }

  /** An audience as the policy names one: sorted, each entry someone it can name. */
  private cleanAudience(audience: string[]): string[] {
    const wanted = [...new Set(audience)].sort();
    if (!wanted.length || !wanted.every(isWriter)) throw new NotAllowed('An audience names people, groups or admins');
    return wanted;
  }

  /** Whether a space is a file's own (0072): it alone is in it, and it is no folder's. */
  private ownSpace(policy: Policy, space: string, path: string): boolean {
    return !policy.isFolderSpace(space) && this.host.spaces.entries().every(([p, s]) => s !== space || p === path);
  }

  /** A new space for an audience (0072: a folder's own, or a file's). */
  private async newSpace(audience: string[]): Promise<string> {
    const id = randomBytes(16).toString('hex');
    await this.node.identity.makeSpace(id, this.cleanAudience(audience), await this.node.signingKeyNow());
    await this.node.membersChanged();
    return id;
  }

  /** Who reads a space, changed (0072): no file moves; whoever is added is sent its history. */
  private async changeSpace(space: string, audience: string[]): Promise<void> {
    await this.node.identity.makeSpace(space, this.cleanAudience(audience), await this.node.signingKeyNow());
    await this.node.membersChanged();
  }

  /**
   * The space with an audience, for a folder's permission from before 0072,
   * which names none: one that has it, or one made for it now; null for
   * everyone in the workspace.
   */
  private async spaceFor(audience: string[] | null): Promise<string | null> {
    if (!audience) return null;
    const wanted = this.cleanAudience(audience);
    const { policy } = await this.node.policy();
    const same = [...policy.spaces].find(([, s]) => s.audience.join() === wanted.join());
    return same ? same[0] : this.newSpace(wanted);
  }

  /** Who reads a file now: its space's audience; null for everyone in the workspace. */
  private audienceOf(policy: Policy, path: string): string[] | null {
    const space = this.host.spaceOf(path);
    return space ? policy.spaces.get(space)?.audience ?? [] : null;
  }

  /** Every file this device holds (the workspace's and its spaces'), and every folder they are in (`dir/`). */
  private async knownPaths(): Promise<{ files: string[]; folders: string[] }> {
    const listed = (await this.host.git.run(['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { allowFail: true })).stdout.split('\0').filter(Boolean);
    const files = [...new Set([...listed, ...this.host.spaces.entries().map(([p]) => p)])];
    const folders = new Set<string>();
    for (const f of files) for (const p of pathsAbove(f).slice(1)) if (p) folders.add(p);
    return { files, folders: [...folders] };
  }

  /**
   * A file's or folder's permissions (0069), for its Permissions… dialog: its
   * own (who may change it; a folder's, who reads what is made in it), what it
   * has from above (the nearest folder's, or the workspace's), who reads it (a
   * file: its space), and what this person may say.
   */
  async permissions(path: string): Promise<PermissionsInfo> {
    const { policy, me } = await this.node.policy();
    const folder = path === '' || path.endsWith('/');
    const parent = path === '' ? null : pathsAbove(path)[1] ?? null;
    const own = policy.permAt(path);
    const access = folder ? null : await this.access(path);
    return {
      path,
      folder,
      own: own ? { write: own.perm.write ?? null, read: own.perm.read ?? null } : null,
      fromAbove: {
        write: parent === null ? null : policy.ruleFor(parent),
        read: parent === null ? null : folder ? policy.readFor(parent) : policy.readFor(path),
      },
      readers: folder ? null : this.audienceOf(policy, path),
      admin: policy.founded && policy.isAdmin(me),
      canWrite: access ? access.canWrite : policy.founded && policy.isAdmin(me),
    };
  }

  /**
   * Say a file's or folder's permissions (0069): who may change it (`write`:
   * people, groups, admins; null takes its own away, so it follows its folder's),
   * and who reads it (`read`: a file moves to that audience's space, whoever may
   * change it says; a folder's is who reads what is made in it, its files that
   * followed it moving with it). What it says of changing, and a folder's of
   * reading, is an admin's to say. A private path is named by its hash.
   */
  async setPermissions(path: string, change: { write?: string[] | null; read?: string[] | null }): Promise<void> {
    const { policy, me } = await this.node.policy();
    if (!policy.founded || !me) throw new NotAllowed('Permissions are for a workspace shared with other people, once it has a policy');
    if (path !== '' && !isRulePath(path)) throw new NotAllowed('Not a file or folder');
    const folder = path === '' || path.endsWith('/');
    const clean = (list: string[] | null | undefined) => (list === undefined ? undefined : list && list.length ? [...new Set(list)].sort() : null);
    const write = clean(change.write);
    const read = clean(change.read);
    for (const l of [write, read]) if (l && !l.every(isWriter)) throw new NotAllowed('Name people, groups or admins');
    if (write !== undefined || (folder && read !== undefined)) {
      if (!policy.isAdmin(me)) throw new NotAllowed('Only an admin of this workspace says who can change what, and who reads a folder');
      const own = policy.permAt(path);
      const nextWrite = write === undefined ? own?.perm.write : write ?? undefined;
      const nextRead = folder ? (read === undefined ? own?.perm.read : read ?? undefined) : undefined;
      const parent = path === '' ? null : pathsAbove(path)[1] ?? null;
      // Named by its hash where it is private: in a space, under a folder fewer read, or a folder fewer read itself.
      const hidden = !!this.host.spaceOf(path) || !!nextRead || (parent !== null && !!policy.readFor(folder ? parent : path));
      const key = hidden && path !== '' ? hashedPath(policy.workspace, path) : path;
      // A folder read by fewer has a space of its own (0072): who reads it is that space's audience.
      const hadSpace = folder && own?.perm.space && policy.spaces.has(own.perm.space) ? own.perm.space : undefined;
      const before = folder ? (own?.perm.read ? policy.readFor(path)?.audience ?? own.perm.read : (parent !== null ? policy.readFor(parent)?.audience : undefined) ?? null) : null;
      let space = folder && nextRead ? hadSpace : undefined;
      // Readers changed: the same space, its readers changed; no file moves, whoever is added is sent its history.
      if (folder && read && hadSpace) await this.changeSpace(hadSpace, read);
      // Read by fewer from now: a space of its own, which its files that read as it did move into.
      if (folder && read && !hadSpace) space = await this.newSpace(read);
      if (own && own.key !== key) await this.adminOp({ t: 'perm', path: own.key });
      await this.adminOp({ t: 'perm', path: key, ...(nextWrite ? { write: nextWrite } : {}), ...(nextRead ? { read: nextRead } : {}), ...(nextRead && space ? { space } : {}) });
      if (folder && read !== undefined && !(read && hadSpace)) {
        // Its files that followed it (who read them was who read the folder) follow it still.
        const now = (await this.node.policy()).policy;
        const above = parent !== null ? now.readFor(parent) : null;
        const target = read ? space! : above?.space ?? (await this.spaceFor(above?.audience ?? null));
        const after = read ?? above?.audience ?? null;
        if ((before ?? []).join() !== (after ?? []).join() || hadSpace) {
          for (const f of (await this.knownPaths()).files.filter((x) => x.startsWith(path))) {
            const followed = hadSpace ? this.host.spaceOf(f) === hadSpace : (this.audienceOf(now, f) ?? []).join() === (before ?? []).join();
            if (!followed || !now.mayWrite(me, f)) continue;
            await this.host.moveToSpace(f, target);
          }
        }
      }
    }
    if (!folder && read !== undefined) await this.setAudience(path, read);
  }

  /**
   * What a new file is made into (0069): the space of who reads what is made in
   * its folder (made for that audience if none has it), or null for everyone.
   * Not one this person could not read.
   */
  async spaceForNew(path: string): Promise<string | null> {
    const { policy, me } = await this.node.policy();
    const folder = policy.founded ? policy.readFor(path) : null;
    if (!folder) return null;
    const id = folder.space ?? (await this.spaceFor(folder.audience));
    return id && (await this.node.policy()).policy.mayRead(me, id) ? id : null;
  }

  /** The permissions of a path (a folder's, with those under it) that a move would take with it. */
  private async ownPermissions(from: string, isFolder: boolean): Promise<{ path: string; key: string; perm: Perm }[]> {
    const { policy } = await this.node.policy();
    const known = await this.knownPaths();
    const paths = isFolder ? [`${from}/`, ...known.files.filter((f) => f.startsWith(`${from}/`)), ...known.folders.filter((f) => f.startsWith(`${from}/`) && f !== `${from}/`)] : [from];
    const out: { path: string; key: string; perm: Perm }[] = [];
    for (const p of new Set(paths)) {
      const at = policy.permAt(p);
      if (at) out.push({ path: p, ...at });
    }
    return out;
  }

  /** Why a move may not be made (a path with permissions of its own, moved by someone who cannot carry them: 0069); null if it may. */
  async whyNotMove(from: string, isFolder: boolean): Promise<string | null> {
    const { policy, me } = await this.node.policy();
    if (!policy.founded || policy.isAdmin(me) || !(await this.ownPermissions(from, isFolder)).length) return null;
    return isFolder ? 'This folder, or something in it, has permissions of its own: only an admin can move it, so they go with it' : 'This file has permissions of its own: only an admin can move it, so they go with it';
  }

  /**
   * After a move (0069): its permissions go with it (an admin's: whyNotMove
   * refused anyone else's), and a file that read as its folder said reads as
   * its new folder says.
   */
  async moved(from: string, to: string, isFolder: boolean): Promise<void> {
    const before = (await this.node.policy()).policy;
    const carried = await this.ownPermissions(from, isFolder);
    for (const c of carried) {
      const path = isFolder ? `${to}/${c.path.slice(from.length + 1)}`.replace(/\/\/$/, '/') : to;
      const key = c.key.startsWith('h:') ? hashedPath(before.workspace, path) : path;
      await this.adminOp({ t: 'perm', path: c.key });
      await this.adminOp({ t: 'perm', path: key, ...c.perm });
    }
    if (isFolder) return;
    const was = before.readFor(from)?.audience ?? null;
    const now = (await this.node.policy()).policy;
    const next = now.readFor(to)?.audience ?? null;
    const has = this.audienceOf(now, to);
    // It followed its old folder: it follows its new one.
    if ((has ?? []).join() === (was ?? []).join() && (next ?? []).join() !== (has ?? []).join() && now.mayWrite((await this.node.policy()).me, to)) {
      await this.host.moveToSpace(to, now.readFor(to)?.space ?? (await this.spaceFor(next)));
    }
  }

  /** Say who may change a path (an admin's to do): people's IDs, `group:<name>`, or `admins`; none takes the rule away (as setPermissions). */
  async setRule(path: string, by: string[]): Promise<void> {
    if (!isRulePath(path)) throw new NotAllowed('Not a path a rule can name: a file, a folder ending in /, or nothing for the whole workspace');
    await this.setPermissions(path, { write: by.length ? by : null });
  }

  /** Put someone in a group, or take them out (role null): an admin's of the group, or the workspace's. */
  async setGroupRole(group: string, who: string, role: Role | null): Promise<void> {
    if (!isGroupName(group)) throw new NotAllowed('A group’s name is lowercase letters, digits and dashes');
    await this.adminOp(role ? { t: 'grant', group, who, role } : { t: 'revoke', group, who });
  }

  /** The workspace's groups and rules, as its policy says, for those who manage them; with its clashes, and whether it is to be founded again. */
  async rules(): Promise<RulesInfo> {
    const { policy, me } = await this.node.policy();
    const id = this.node.identity;
    const names = new Map((await id.people()).map((p) => [p.key, p.name]));
    // Private paths by their hash: shown as the path where this device knows it, else as private.
    const known = await this.knownPaths();
    const byHash = new Map(['', ...known.files, ...known.folders].map((p) => [hashedPath(policy.workspace, p), p]));
    const shown = (key: string) => (key.startsWith('h:') ? byHash.get(key) ?? null : key);
    return {
      admin: policy.founded ? policy.isAdmin(me) : false,
      rules: [...policy.rules].map(([key, by]) => ({ path: shown(key) ?? key, by })).filter((r) => !r.path.startsWith('h:')).sort((a, b) => (a.path < b.path ? -1 : 1)),
      permissions: [...policy.perms].map(([key, p]) => ({ path: shown(key), private: key.startsWith('h:'), write: p.write ?? null, read: p.read ?? null }))
        .sort((a, b) => ((a.path ?? '\uffff') < (b.path ?? '\uffff') ? -1 : 1)),
      groups: [...policy.groups].filter(([g]) => g !== WORKSPACE).map(([name, entries]) => ({
        name,
        entries: [...entries].map(([who, role]) => ({ who, role, name: who.startsWith('group:') ? who.slice(6) : names.get(who) ?? null })),
      })),
      // Everyone sees them (every device holds the operations anyway); admins may make the one that lost again (0078).
      clashes: await clashWords(policy, await id.policyEntries(), (key) => id.personOfKey(key), names, me, shown),
      refound: await this.refoundInfo(me, names),
    };
  }

  /** A workspace from before 0066 (0078): who may found it again, as this device's last legacy policy says; null once it is founded. */
  private async refoundInfo(me: string | null, names: Map<string, string>): Promise<RulesInfo['refound']> {
    const snap = await this.node.identity.legacySnapshot();
    if (!snap) return null;
    return { owner: snap.owner ? names.get(snap.owner) ?? `${snap.owner.slice(0, 8)}…` : null, may: await this.node.identity.mayRefound(me) };
  }

  /** Make a clash's losing change again, on purpose, after both (0078): as this person's, if they may. */
  async redo(op: string): Promise<void> {
    if (!(await this.node.person())) throw new NotAllowed('This computer has no identity');
    try {
      await this.node.identity.redo(op, await this.node.signingKeyNow(), await this.node.branchTips());
    } catch (e) {
      throw new NotAllowed((e as Error).message);
    }
    await this.node.membersChanged();
  }

  /** Found a workspace from before 0066 again (0078): this person its owner, everyone as they were here. */
  async refound(): Promise<void> {
    const person = await this.node.person();
    if (!person) throw new NotAllowed('This computer has no identity');
    try {
      await this.node.identity.refound(person.id, await this.node.signingKeyNow());
    } catch (e) {
      throw new NotAllowed((e as Error).message);
    }
    await this.node.membersChanged();
  }

  private async adminOp(op: Extract<PolicyOp, { t: 'grant' | 'revoke' | 'rule' | 'perm' | 'owner' }>): Promise<void> {
    if (!(await this.node.person())) throw new NotAllowed('This computer has no identity');
    try {
      await this.node.identity.adminOp(op, await this.node.signingKeyNow());
    } catch (e) {
      throw new NotAllowed((e as Error).message);
    }
    await this.node.membersChanged();
  }

  async status(): Promise<PeersStatus> {
    const id = this.node.identity;
    const devices: DeviceInfo[] = [];
    for (const m of await id.devicesToMeet()) {
      const link = this.node.links.get(m.key);
      devices.push({
        name: m.name,
        key: m.key,
        person: (await id.personOf(m.key))?.name ?? null,
        server: await id.isServerDevice(m.key),
        online: !!link?.accepted,
        through: this.node.through(m.key).map((l) => l.key),
        otherVersion: this.node.mergesDiffer(m.key),
        related: !!link?.hello && link.hello.workspace !== this.node.ws.id,
        kuraa: versionOf(this.node.versions.get(m.key)),
        via: this.node.via(m.key),
        lastSeen: this.node.lastSeen(m.key),
      });
    }
    const connected = devices.some((d) => d.online);
    return {
      device: { name: this.node.name, key: this.node.myKey, person: (await id.personOf(this.node.myKey))?.name ?? null },
      network: this.node.network(),
      workspace: { id: this.node.ws.id, forkedFrom: this.node.ws.forkedFrom },
      devices,
      removed: (await id.removed()).includes(this.node.myKey),
      people: await this.people(),
      noContactSince: connected || !devices.length ? null : Math.max(this.started, ...devices.map((d) => d.lastSeen ?? 0)),
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.announceTimer);
    for (const t of this.retries.values()) clearTimeout(t);
    this.retries.clear();
    this.stopRefs?.();
    this.stopOutputs?.();
    this.outputs?.close();
    // Let fetches under way finish, but not hold closing up for long.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.fetching.values(), ...this.fetchingOutputs.values()]), new Promise((r) => (timer = setTimeout(r, 5000)))]);
    clearTimeout(timer);
    // Only now (0071): work a sync still brings in is judged by the write rules as ever.
    this.host.gate = null;
    this.rooms.close();
    await this.node.close();
  }
}
