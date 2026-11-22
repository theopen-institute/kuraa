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
import { describeOutcome, type Host } from '../host.js';
import { isAncestor } from '../merging.js';
import { PROTOCOL, type PeerLink } from './link.js';
import { PeerNode, type NodeEvents, type Via } from './node.js';
import { Rooms } from './rooms.js';
import { SharedOutputs, liveRun, outputRefs } from './outputs.js';
import type { Person } from './person.js';
import { WORKSPACE, type PolicyOp, type Role } from './policy.js';
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

/** The workspace's people, by its policy (0066). */
export interface PeopleInfo {
  /** Whether the workspace has a policy yet (no: every member has the same say, 0038). */
  founded: boolean;
  /** Whether this person may invite people, remove devices and change who is in it. */
  admin: boolean;
  people: { id: string; role: Role; name: string | null; devices: string[]; you: boolean }[];
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
  }

  private readonly stateDir: string;

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
      cached: () => this.host.runner.cached(),
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
      void Promise.all([this.node.heads(), outputRefs(this.host.git)]).then(([heads, outputs]) => this.node.broadcast({ type: 'refs', heads, outputs })).catch((e: Error) => this.host.log(`peers: ${e.message}`));
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
      const outcome = await this.host.bringBranch(branch, ref, this.rooms.override(link));
      if (branch === current && outcome.kind !== 'same') this.host.log(`peers: brought in ${branch} from ${from}${describeOutcome(outcome)}`);
    });
  }

  /**
   * Make an invite link (CLI: kuraa-host invite): for one person (`once`: the
   * first device it lets in uses it up) or anyone with it, until it expires
   * (`hours`; null: never) or is revoked.
   */
  async inviteLink(o: { hours: number | null; once: boolean; role?: Role; group?: string }): Promise<string> {
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
  async removeDevice(key: string): Promise<void> {
    if (key === this.node.myKey) throw new Error('This is this device: another device removes it');
    if (!(await this.node.identity.members()).some((m) => m.key === key)) throw new Error('No such device in this workspace');
    if (!(await this.node.identity.mayManage(this.node.myKey))) throw new NotAllowed('Only an admin of this workspace can remove devices');
    await this.node.identity.removeMember(key);
    await this.node.newSecret();
    // Told first, with the others (it stops syncing once it takes the record); then let go of, in any case.
    const link = this.node.links.get(key);
    await this.node.membersChanged();
    if (link) setTimeout(() => link.close(), 1000).unref();
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
      people: policy.people().map((p) => ({ id: p.id, role: p.role, name: known.get(p.id)?.name ?? null, devices: known.get(p.id)?.devices ?? [], you: p.id === me })),
    };
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
    await this.adminOp({ t: 'revoke', group: WORKSPACE, who: person });
    const members = new Set((await this.node.identity.members()).map((m) => m.key));
    const theirs = devices.filter((d) => members.has(d) && d !== this.node.myKey);
    for (const d of theirs) await this.node.identity.removeMember(d);
    if (theirs.length) await this.node.newSecret();
    await this.node.membersChanged();
  }

  private async adminOp(op: Extract<PolicyOp, { t: 'grant' | 'revoke' }>): Promise<void> {
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
