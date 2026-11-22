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
import { SharedOutputs, outputRefs } from './outputs.js';
import type { Person } from './person.js';
import type { KeyPair } from '../keys.js';

export interface PeerOptions {
  /** DHT bootstrap nodes (`host:port`): a private network, or tests. Default: Hyperswarm's public ones. */
  bootstrap?: (string | { host: string; port: number })[];
  /** The most one fetch from a device may bring, in bytes. */
  maxFetchBytes?: number;
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
  /** Work waiting on a device that merges differently, already logged: `remote/branch`. */
  private readonly waiting = new Set<string>();
  private announceTimer: NodeJS.Timeout | undefined;
  private stopRefs: (() => void) | null = null;
  private closed = false;

  private readonly events: NodeEvents = {
    accepted: (link) => {
      this.rooms.connected(link);
      this.syncFrom(link);
    },
    closed: (link) => this.rooms.disconnected(link),
    refs: (link) => this.syncFrom(link),
    room: (link, m) => this.rooms.message(link, m),
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
      announce: () => this.announce(),
      log: (m) => this.host.log(m),
    });
    this.stopOutputs = this.host.runner.onCacheChanged(() => this.outputs?.publish());
    await this.outputs.start();
  }

  /**
   * Tell the other devices this one's branches moved (soon, once for a burst),
   * and to what: a device that has those commits already (it brought them in
   * from another) does not fetch.
   */
  private announce(): void {
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => {
      void Promise.all([this.node.heads(), outputRefs(this.host.git)]).then(([heads, outputs]) => this.node.broadcast({ type: 'refs', heads, outputs })).catch((e: Error) => this.host.log(`peers: ${e.message}`));
    }, 200);
  }

  /**
   * Whether this device has every branch the device says it has, as far as it
   * goes or further, and every run output it has (or a newer one): then
   * fetching from it would bring nothing. Its tracking branches
   * (`<device>/<branch>`) are moved to what it said, as a fetch would.
   */
  private async upToDate(link: PeerLink): Promise<boolean> {
    const theirs = link.heads;
    if (!theirs) return false;
    if (await this.outputs?.lacks(link.outputs)) return false;
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
        if (!(await this.node.fetch(remote))) return;
        if (link.hello?.workspace !== this.node.ws.id) return; // a fork: fetched, never merged on its own
        await this.outputs?.adopt(remote, link.key).catch((e: Error) => this.host.log(`peers: taking ${remote}’s run outputs failed: ${e.message}`));
        await this.rooms.settle(link);
        await this.bringIn(link);
      } while (this.again.has(remote) && !this.closed);
    })().catch((e: Error) => this.host.log(`peers: syncing with ${remote} failed: ${e.message}`)).finally(() => this.fetching.delete(remote));
    this.fetching.set(remote, run);
    return run;
  }

  /** Sync with every connected device now. */
  async syncAll(): Promise<string> {
    const links = [...this.node.links.values()].filter((l) => l.accepted);
    await Promise.all(links.map((l) => this.syncFrom(l)));
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
  async inviteLink(o: { hours: number | null; once: boolean }): Promise<string> {
    // With the ways in besides the DHT this device knows: relays named, servers that take TCP (0053).
    const link = await this.node.identity.createLink(o.hours, o.once, await this.node.linkHints());
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
    return {
      device: { name: this.node.name, key: this.node.myKey, person: (await id.personOf(this.node.myKey))?.name ?? null },
      network: this.node.network(),
      workspace: { id: this.node.ws.id, forkedFrom: this.node.ws.forkedFrom },
      devices,
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
    await Promise.race([Promise.allSettled([...this.fetching.values()]), new Promise((r) => (timer = setTimeout(r, 5000)))]);
    clearTimeout(timer);
    this.rooms.close();
    await this.node.close();
  }
}
