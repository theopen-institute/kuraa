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
import { WaitingForPolicy, describeOutcome, type Host } from '../host.js';
import { RESOLVED_TRAILER, gate, type GateResult } from './gate.js';
import { suggestions, type Suggestion } from './suggestions.js';
import { emailOf } from './attest.js';
import { MERGE_VERSION, isAncestor } from '../merging.js';
import { randomBytes } from 'node:crypto';
import { PEER_SPACES } from './node.js';
import { spaceRef } from '../spaces.js';
import { PROTOCOL, type PeerLink } from './link.js';
import { PeerNode, type NodeEvents, type Via } from './node.js';
import { Rooms } from './rooms.js';
import { SharedOutputs, liveRun, outputRefs } from './outputs.js';
import type { Person } from './person.js';
import { WORKSPACE, hashedPath, isGroupName, isRulePath, isWriter, pathsAbove, type Perm, type Policy, type PolicyOp, type Role } from './policy.js';
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
  suggestions: Suggestion[];
  /** This person (identity ID). */
  you: string | null;
  /** Who reads it: null for everyone in the workspace; else its space's audience, and that in words (0066). */
  readers: { audience: string[]; words: string } | null;
}

/** An audience in words: "Only you", "Ada and Bo", "editors", "admins". */
export function audienceWords(audience: string[], me: string | null, names: Map<string, string>): string {
  if (audience.length === 1 && audience[0] === me) return 'Only you';
  // You first: "You and Bo".
  const ordered = [...audience].sort((x, y) => Number(y === me) - Number(x === me));
  const words = ordered.map((w, i) => (w === me ? (i === 0 ? 'You' : 'you') : w === 'admins' ? 'admins' : w.startsWith('group:') || w.startsWith('email:') ? w.slice(6) : names.get(w) ?? `${w.slice(0, 8)}…`));
  return words.length < 2 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`;
}

/** The workspace's groups and write rules (0066). */
export interface RulesInfo {
  /** Whether this person may change them. */
  admin: boolean;
  rules: { path: string; by: string[] }[];
  groups: { name: string; entries: { who: string; role: Role; name: string | null }[] }[];
  /** Verifiers whose attestations count here (0066, step 6). */
  verifiers: { key: string; url: string }[];
  /** Every file's and folder's permission (0069): its path (null: private, not one this device knows), who may change it, who reads what is made there. */
  permissions: { path: string | null; private: boolean; write: string[] | null; read: string[] | null }[];
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
  /** The workspace's owner (0070); null: one from before that has none yet. */
  owner: string | null;
  /** Whether this person makes, unmakes and takes out admins: the owner (any admin, where there is none yet). */
  assignsAdmins: boolean;
  people: { id: string; role: Role | 'owner'; name: string | null; devices: string[]; you: boolean; emails: string[] }[];
  /** People invited by email who are not in yet (0066, step 6). */
  invited: { email: string; role: Role }[];
  /** Admins who took each other out at the same time, which would have left none, so neither removal stood: their names. */
  disputes: string[][];
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
  private announceTimer: NodeJS.Timeout | undefined;
  private stopRefs: (() => void) | null = null;
  private closed = false;
  /** When syncing started here (ms since 1970): no device connected since then, at the most, for noContactSince. */
  private readonly started = Date.now();

  private readonly events: NodeEvents = {
    accepted: (link) => {
      this.rooms.connected(link);
      this.syncFrom(link);
      this.syncOutputs(link);
    },
    closed: (link) => {
      this.rooms.disconnected(link);
      this.outputs?.disconnected(link.key);
    },
    refs: (link) => {
      this.syncFrom(link);
      this.syncOutputs(link);
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
    host.gate = (x, y) => this.gate(x, y);
  }

  private readonly stateDir: string;

  /** The workspace's write rules, applied to the commits `y` brings to `x` (gate.ts). */
  private async gate(x: string, y: string): Promise<GateResult> {
    const id = this.node.identity;
    const records = await id.records();
    const policy = await id.policy(records);
    if (!policy.founded) return { keeps: new Map(), refused: [], waitFor: [] };
    const people = await id.people();
    const byKey = new Map(people.flatMap((p) => p.keys.map((k) => [k, p.key] as const)));
    const names = new Map(people.map((p) => [p.key, p.name]));
    const known = new Set(records.filter((r) => r.kind === 'policy').map((r) => r.subject));
    return gate(this.host.git, x, y, {
      policy,
      known,
      personOf: (k) => byKey.get(k) ?? null,
      nameOf: (p) => names.get(p) ?? null,
      cutKeys: await id.cutKeys(),
      remake: (a, b) => this.host.remakeMergeTree(a, b),
      mergeVersion: MERGE_VERSION,
    });
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
    const moves = Object.entries(theirs).filter(([b, oid]) => tracking.get(b) !== oid).map(([b, oid]) => `update refs/remotes/${remote}/${b} ${oid}\n`);
    if (moves.length) await this.host.git.run(['update-ref', '--stdin'], { input: moves.join(''), allowFail: true });
    return true;
  }

  /** Fetch from a device and bring its work in; one at a time per device, again if asked meanwhile. */
  syncFrom(link: PeerLink): Promise<void> {
    if (this.closed) return Promise.resolve();
    const remote = link.remote!;
    const running = this.fetching.get(remote);
    if (running) {
      this.again.add(remote);
      return running;
    }
    const run = (async () => {
      do {
        this.again.delete(remote);
        if (await this.upToDate(link)) continue;
        const asked = Date.now();
        if (!(await this.node.fetch(remote))) return;
        this.outputs?.timing(`fetched branches from ${remote} in ${Date.now() - asked} ms`);
        if (link.hello?.workspace !== this.node.ws.id) return; // a fork: fetched, never merged on its own
        await this.rooms.settle(link);
        await this.bringIn(link);
      } while (this.again.has(remote) && !this.closed);
    })().catch((e: Error) => this.host.log(`peers: syncing with ${remote} failed: ${e.message}`)).finally(() => this.fetching.delete(remote));
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
   * Bring a device's branches in. Two devices that merge differently would each
   * make their own merge of the same work, and their histories would part: the
   * one with the lower key makes the merges, and the other only fast-forwards.
   */
  private async bringIn(link: PeerLink): Promise<void> {
    const remote = link.remote!;
    const forwardOnly = this.node.mergesDiffer(link.key) && link.key < this.node.myKey;
    for (const { branch, oid } of await this.branchesOf(remote)) await this.bringBranch(branch, `refs/remotes/${remote}/${branch}`, oid, link, forwardOnly);
    // Its spaces this person may read (0066): only those come, as it judged (node.ts serves no others), so
    // a space whose operation has not reached this device yet is not held back.
    const out = await this.host.git.run(['for-each-ref', '--format=%(refname)', `${PEER_SPACES}${remote}/`], { allowFail: true });
    for (const ref of out.stdout.split('\n').filter(Boolean)) {
      const m = new RegExp(`^${PEER_SPACES}${remote}/([0-9a-f]{32})/heads/(.+)$`).exec(ref);
      if (!m) continue;
      const [, id, branch] = m;
      await this.host.serial(async () => {
        try {
          const outcome = await this.host.bringSpace(id!, branch!, ref, this.rooms.override(link));
          this.waitingForPolicy.delete(`${remote}/${ref}`);
          if (outcome.kind !== 'same') this.host.log(`peers: brought in a space's ${branch} from ${remote}${describeOutcome(outcome)}`);
        } catch (e) {
          if (!(e instanceof WaitingForPolicy)) throw e;
          if (!this.waitingForPolicy.has(`${remote}/${ref}`)) this.host.log(`peers: ${remote}'s work in a space is ${e.message}`);
          this.waitingForPolicy.add(`${remote}/${ref}`);
          setTimeout(() => void this.syncFrom(link), 2000).unref();
        }
      });
    }
  }

  /**
   * Bring a device's commit into a branch (Host.bringBranch). `forwardOnly`: only
   * if no merge is needed (the other device will make it, and this one take it then).
   */
  private async bringBranch(branch: string, ref: string, oid: string, link: PeerLink, forwardOnly: boolean): Promise<void> {
    await this.host.serial(async () => {
      const current = await this.host.git.branch();
      const mine = (await this.host.git.run(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true })).stdout.trim();
      const from = link.remote ?? ref;
      if (forwardOnly && mine && !(await isAncestor(this.host.git, mine, oid))) {
        if (!this.waiting.has(`${from}/${branch}`)) this.host.log(`peers: ${from} merges differently from this device (another version of kuraa?); its work on ${branch} comes in once it has merged this device's`);
        this.waiting.add(`${from}/${branch}`);
        return;
      }
      this.waiting.delete(`${from}/${branch}`);
      let outcome;
      try {
        outcome = await this.host.bringBranch(branch, ref, this.rooms.override(link));
      } catch (e) {
        if (!(e instanceof WaitingForPolicy)) throw e;
        // The policy travels with the records, which come with every hello: soon.
        if (!this.waitingForPolicy.has(`${from}/${branch}`)) this.host.log(`peers: ${from}'s work on ${branch} is ${e.message}`);
        this.waitingForPolicy.add(`${from}/${branch}`);
        setTimeout(() => void this.syncFrom(link), 2000).unref();
        return;
      }
      this.waitingForPolicy.delete(`${from}/${branch}`);
      if (branch === current && outcome.kind !== 'same') this.host.log(`peers: brought in ${branch} from ${from}${describeOutcome(outcome)}`);
    });
  }

  /**
   * Make an invite link (CLI: kuraa-host invite): for one person (`once`: the
   * first device it lets in uses it up) or anyone with it, until it expires
   * (`hours`; null: never) or is revoked.
   */
  async inviteLink(o: { hours: number | null; once: boolean; role?: Role; group?: string; email?: string }): Promise<string> {
    // For someone by their email (0066, step 6): their place in the group waits for an attestation of that address.
    if (o.email) {
      const email = emailOf(o.email);
      if (!email) throw new NotAllowed('Not an email address');
      await this.adminOp({ t: 'grant', group: o.group ?? WORKSPACE, who: `email:${email}`, role: o.role ?? 'member' });
    }
    // With the ways in besides the DHT this device knows: relays named, servers that take TCP (0053).
    // Putting its holder in a group, signed by this person (0066): the workspace, as a member, unless it says otherwise.
    const person = await this.node.person();
    const grant = person ? { key: await this.node.signingKeyNow(), group: o.group, role: o.role } : undefined;
    const link = await this.node.identity.createLink(o.hours, o.once, await this.node.linkHints(), grant);
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
    await this.node.identity.revokeLink(id);
    await this.node.membersChanged();
  }

  /**
   * Remove a device from the workspace, for good, on record, and tell the others
   * (any member may). It keeps its copy. The workspace's secret is made anew, so
   * the device, which knew the old one, can no longer find the others (0050).
   */
  async removeDevice(key: string): Promise<{ revoked: boolean }> {
    if (key === this.node.myKey) throw new Error('This is this device: another device removes it');
    if (!(await this.node.identity.members()).some((m) => m.key === key)) throw new Error('No such device in this workspace');
    // An admin, or the same person: one's own lost or retired computer (0068).
    if (!(await this.node.identity.mayRemove(this.node.myKey, key))) throw new NotAllowed('Only an admin of this workspace (the owner, for an admin’s), or whoever it is, can remove a computer');
    // One's own: its signing key revoked too, if this computer keeps one's identity, so what it signs from now on is no one's.
    const revoked = await this.revokeOwn(key);
    await this.node.identity.removeMember(key);
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
    return {
      founded: policy.founded,
      admin: policy.founded ? policy.isAdmin(me) : true,
      // The owner (0070), and whether this person makes and unmakes admins (the owner; any admin, where there is none yet).
      owner: policy.owner,
      assignsAdmins: policy.founded ? policy.mayAssignAdmins(me) : true,
      people: await Promise.all(policy.people().map(async (p) => ({ id: p.id, role: (p.id === policy.owner ? 'owner' : p.role) as Role | 'owner', name: known.get(p.id)?.name ?? null, devices: known.get(p.id)?.devices ?? [], you: p.id === me, emails: await id.emailsOf(p.id) }))),
      // Invited by email, and not in yet (no one attested to have that address): step 6.
      invited: policy.invited(),
      // Admins who took each other out at once, which would have left none: neither stood (step 4).
      disputes: policy.disputes.map((d) => d.people.map((id) => known.get(id)?.name ?? `${id.slice(0, 8)}…`)),
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
   * Take a person out of the workspace (an admin's to do; or anyone, themselves),
   * and remove their devices, as removing a device does (0050: a new secret).
   */
  async removePerson(person: string): Promise<void> {
    const devices = (await this.node.identity.people()).find((p) => p.key === person)?.devices ?? [];
    // With the commits this device has: what they made among them still counts, and nothing else (their cutoff).
    await this.adminOp({ t: 'revoke', group: WORKSPACE, who: person, cutoff: await this.node.branchTips() });
    const members = new Set((await this.node.identity.members()).map((m) => m.key));
    const theirs = devices.filter((d) => members.has(d) && d !== this.node.myKey);
    for (const d of theirs) await this.node.identity.removeMember(d);
    if (theirs.length) await this.node.newSecret();
    await this.node.membersChanged();
  }

  /**
   * Who may change a file (0066), for the editor: whether this person may, the
   * rule that says so (its path, and who it names, in words), and the file's
   * open suggestions.
   */
  async access(path: string): Promise<FileAccess> {
    const { policy, me } = await this.node.policy();
    const space = this.host.spaceOf(path);
    const rule = policy.founded ? policy.ruleFor(path) : null;
    const names = new Map((await this.node.identity.people()).map((p) => [p.key, p.name]));
    const words = (w: string) => (w === 'admins' ? 'admins' : w.startsWith('group:') ? w.slice(6) : w.startsWith('email:') ? w.slice(6) : names.get(w) ?? `${w.slice(0, 8)}…`);
    return {
      canWrite: !policy.founded || policy.mayWrite(me, path),
      // In words, and as the policy says it (for the document's Permissions… to show and change: 0067).
      rule: rule && { path: rule.path, by: rule.by.map(words), who: rule.by },
      // Whether this person may say who changes it (make a rule): the workspace's admins (0066).
      admin: policy.founded && policy.isAdmin(me),
      suggestions: await this.suggestions(path),
      you: me,
      // Who reads it: everyone in the workspace (null), or a space's audience (0066).
      readers: space ? { audience: policy.spaces.get(space)?.audience ?? [], words: audienceWords(policy.spaces.get(space)?.audience ?? [], me, names) } : null,
    };
  }

  /** The open suggestions on the current branch (of one file, if given). */
  async suggestions(path?: string): Promise<Suggestion[]> {
    const branch = await this.host.git.branch();
    if (!branch) return [];
    const { policy } = await this.node.policy();
    const people = await this.node.identity.people();
    const byKey = new Map(people.flatMap((p) => p.keys.map((k) => [k, p.key] as const)));
    const names = new Map(people.map((p) => [p.key, p.name]));
    const ctx = { personOf: (k: string) => byKey.get(k) ?? null, nameOf: (p: string) => names.get(p) ?? null, mayWrite: (p: string | null, f: string) => !policy.founded || policy.mayWrite(p, f) };
    // The workspace's own history, and each space's (0066): a space's file's suggestions are in its space's.
    const refs = path !== undefined
      ? [this.host.refFor(path) === 'HEAD' ? branch : this.host.refFor(path)]
      : [branch, ...this.host.spaces.ids().map((id) => this.host.spaces.refOf(id)!)];
    const all: Suggestion[] = [];
    for (const ref of refs) all.push(...(await suggestions(this.host.git, ref, ctx, path)));
    return all.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
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
   * Who may read a file (0066): everyone in the workspace (`null`), or an
   * audience (people's IDs, `group:<name>`, `admins`), which must include this
   * person. Files with the same audience share a space: one is made for an
   * audience no space has yet. The file moves there as it is now; its history
   * stays where it was, with those who read it then.
   */
  async setAudience(path: string, audience: string[] | null): Promise<void> {
    const { policy, me } = await this.node.policy();
    if (!policy.founded || !me) throw new NotAllowed('Who reads what is for a workspace shared with other people, once it has a policy');
    if (!(await this.access(path)).canWrite) throw new NotAllowed('Only someone who may change this file says who reads it');
    const target = await this.spaceFor(audience);
    if (target && !(await this.node.policy()).policy.mayRead(me, target)) throw new NotAllowed('You would not be able to read it yourself: include yourself');
    await this.host.moveToSpace(path, target);
  }

  /** The space for an audience (0066): one that has it, or one made for it now; null for everyone in the workspace. */
  private async spaceFor(audience: string[] | null): Promise<string | null> {
    if (!audience) return null;
    const wanted = [...new Set(audience)].sort();
    if (!wanted.length || !wanted.every(isWriter)) throw new NotAllowed('An audience names people, groups, admins or email addresses');
    const { policy } = await this.node.policy();
    const same = [...policy.spaces].find(([, s]) => s.audience.join() === wanted.join());
    if (same) return same[0];
    const id = randomBytes(16).toString('hex');
    await this.node.identity.makeSpace(id, wanted, await this.node.signingKeyNow());
    await this.node.membersChanged();
    return id;
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
    for (const l of [write, read]) if (l && !l.every(isWriter)) throw new NotAllowed('Name people, groups, admins or email addresses');
    if (write !== undefined || (folder && read !== undefined)) {
      if (!policy.isAdmin(me)) throw new NotAllowed('Only an admin of this workspace says who can change what, and who reads a folder');
      const own = policy.permAt(path);
      const nextWrite = write === undefined ? own?.perm.write : write ?? undefined;
      const nextRead = folder ? (read === undefined ? own?.perm.read : read ?? undefined) : undefined;
      const parent = path === '' ? null : pathsAbove(path)[1] ?? null;
      // Named by its hash where it is private: in a space, under a folder fewer read, or a folder fewer read itself.
      const hidden = !!this.host.spaceOf(path) || !!nextRead || (parent !== null && !!policy.readFor(folder ? parent : path));
      const key = hidden && path !== '' ? hashedPath(policy.workspace, path) : path;
      if (own && own.key !== key) await this.adminOp({ t: 'perm', path: own.key });
      await this.adminOp({ t: 'perm', path: key, ...(nextWrite ? { write: nextWrite } : {}), ...(nextRead ? { read: nextRead } : {}) });
      if (folder && read !== undefined) {
        // Its files that followed it (who read them was who read the folder) follow it still.
        const before = own?.perm.read ?? (parent !== null ? policy.readFor(parent)?.audience : undefined) ?? null;
        const after = nextRead ?? (parent !== null ? (await this.node.policy()).policy.readFor(parent)?.audience : undefined) ?? null;
        if ((before ?? []).join() !== (after ?? []).join()) {
          const target = await this.spaceFor(after);
          const now = (await this.node.policy()).policy;
          for (const f of (await this.knownPaths()).files.filter((x) => x.startsWith(path))) {
            if ((this.audienceOf(now, f) ?? []).join() !== (before ?? []).join() || !now.mayWrite(me, f)) continue;
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
    const audience = policy.founded ? policy.readFor(path)?.audience ?? null : null;
    if (!audience) return null;
    const id = await this.spaceFor(audience);
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
      await this.host.moveToSpace(to, await this.spaceFor(next));
    }
  }

  /** Suggest a text for a file this person may not change (Host.suggest); one they may, they change. */
  async suggest(path: string, text: string): Promise<string> {
    if ((await this.access(path)).canWrite) throw new NotAllowed('You may change this document: edit it instead');
    const commit = await this.host.suggest(path, text);
    await this.node.membersChanged();
    return commit;
  }

  /**
   * A suggestion seen to (accepted, its text put in the document as an edit; or
   * dismissed): on record, for every device. By someone who may change the file,
   * or whoever suggested it.
   */
  async resolveSuggestion(commit: string, path: string, accepted: boolean): Promise<void> {
    const s = (await this.suggestions(path)).find((x) => x.commit === commit);
    if (!s) throw new Error('No such suggestion is open');
    const { me } = await this.node.policy();
    if (!(await this.access(path)).canWrite && s.person !== me) throw new NotAllowed('Only someone who may change this document, or who suggested it, sees to a suggestion');
    await this.host.commitNote(`${accepted ? 'Took' : 'Left'} ${s.name ?? 'someone'}’s suggestion for ${path}`, [`${RESOLVED_TRAILER}: ${commit} ${path}`]);
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

  /** The workspace's groups and rules, as its policy says, for those who manage them. */
  async rules(): Promise<RulesInfo> {
    const { policy, me } = await this.node.policy();
    const names = new Map((await this.node.identity.people()).map((p) => [p.key, p.name]));
    // Private paths by their hash: shown as the path where this device knows it, else as private.
    const known = await this.knownPaths();
    const byHash = new Map(['', ...known.files, ...known.folders].map((p) => [hashedPath(policy.workspace, p), p]));
    const shown = (key: string) => (key.startsWith('h:') ? byHash.get(key) ?? null : key);
    return {
      admin: policy.founded ? policy.isAdmin(me) : false,
      rules: [...policy.rules].map(([key, by]) => ({ path: shown(key) ?? key, by })).filter((r) => !r.path.startsWith('h:')).sort((a, b) => (a.path < b.path ? -1 : 1)),
      permissions: [...policy.perms].map(([key, p]) => ({ path: shown(key), private: key.startsWith('h:'), write: p.write ?? null, read: p.read ?? null }))
        .sort((a, b) => ((a.path ?? '\uffff') < (b.path ?? '\uffff') ? -1 : 1)),
      verifiers: [...policy.verifiers].map(([key, url]) => ({ key, url })),
      groups: [...policy.groups].filter(([g]) => g !== WORKSPACE).map(([name, entries]) => ({
        name,
        entries: [...entries].map(([who, role]) => ({ who, role, name: who.startsWith('group:') ? who.slice(6) : names.get(who) ?? null })),
      })),
    };
  }

  /** Count a verifier's attestations here (an admin's to do): its key, asked of it at its address (verifier.ts). */
  async addVerifier(url: string): Promise<RulesInfo> {
    const clean = url.trim().replace(/\/+$/, '');
    if (!/^https?:\/\/\S+$/.test(clean)) throw new NotAllowed('A verifier is a server’s address (https://…)');
    let key: unknown;
    try {
      key = ((await (await fetch(`${clean}/verify`)).json()) as { key?: unknown }).key;
    } catch (e) {
      throw new NotAllowed(`Could not ask ${clean}: ${(e as Error).message}`);
    }
    if (typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) throw new NotAllowed(`${clean} is not a verifier`);
    await this.adminOp({ t: 'verifier', key, url: clean });
    return this.rules();
  }

  /** Stop counting a verifier's attestations here. */
  async removeVerifier(key: string): Promise<RulesInfo> {
    await this.adminOp({ t: 'verifier', key, url: '' });
    return this.rules();
  }

  private async adminOp(op: Extract<PolicyOp, { t: 'grant' | 'revoke' | 'rule' | 'verifier' | 'perm' | 'owner' }>): Promise<void> {
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
    for (const m of await id.members()) {
      const link = this.node.links.get(m.key);
      devices.push({
        name: m.name,
        key: m.key,
        person: (await id.personOf(m.key))?.name ?? null,
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
    this.host.gate = null;
    clearTimeout(this.announceTimer);
    this.stopRefs?.();
    this.stopOutputs?.();
    this.outputs?.close();
    // Let fetches under way finish, but not hold closing up for long.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.fetching.values(), ...this.fetchingOutputs.values()]), new Promise((r) => (timer = setTimeout(r, 5000)))]);
    clearTimeout(timer);
    this.rooms.close();
    await this.node.close();
  }
}
