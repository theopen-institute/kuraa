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
import type { PeerLink } from './link.js';
import { PeerNode } from './node.js';
import { Rooms } from './rooms.js';
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
}

export interface DeviceInfo {
  name: string;
  key: string;
  /** Whose device it is, as their identity says (0035); null if it does not say. */
  person: string | null;
  online: boolean;
  /**
   * It merges differently from this device (another version of kuraa, say).
   * Between the two, only the one with the lower key makes merges; the other
   * takes them, so their histories never part.
   */
  otherVersion: boolean;
  /** A fork of this workspace, or the workspace this one was forked from: fetched from, never merged on its own. */
  related: boolean;
}

export interface PeersStatus {
  /** This device, and whose it is (null if no identity says). */
  device: { name: string; key: string; person: string | null };
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

export class Peers {
  readonly node: PeerNode;
  readonly rooms: Rooms;
  private readonly fetching = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  /** Work waiting on a device that merges differently, already logged: `remote/branch`. */
  private readonly waiting = new Set<string>();
  private announceTimer: NodeJS.Timeout | undefined;
  private stopRefs: (() => void) | null = null;
  private closed = false;

  constructor(private readonly host: Host, private readonly opts: PeerOptions, stateDir: string) {
    this.node = new PeerNode({
      dir: host.dir,
      git: host.git,
      stateDir,
      bootstrap: opts.bootstrap,
      maxFetchBytes: opts.maxFetchBytes,
      branch: () => host.git.branch(),
      log: (m) => host.log(m),
      merges: host.mergeSignature,
      person: opts.person,
      signing: opts.signing,
    }, {
      accepted: (link) => {
        this.rooms.connected(link);
        this.syncFrom(link);
      },
      closed: (link) => this.rooms.disconnected(link),
      refs: (link) => this.syncFrom(link),
      room: (link, m) => this.rooms.message(link, m),
    });
    this.rooms = new Rooms(host, this.node);
  }

  async start(): Promise<void> {
    await this.node.start(true);
    this.stopRefs = this.host.onRefsChanged(() => this.announce());
  }

  /** Tell the other devices this one's branches moved (soon, once for a burst). */
  private announce(): void {
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => this.node.broadcast({ type: 'refs' }), 200);
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
        if (!(await this.node.fetch(remote))) return;
        if (link.hello?.workspace !== this.node.ws.id) return; // a fork: fetched, never merged on its own
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
  inviteLink(o: { hours: number | null; once: boolean }): Promise<string> {
    return this.node.identity.createLink(o.hours, o.once);
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

  /** Remove a device from the workspace, for good, on record, and tell the others (any member may). It keeps its copy. */
  async removeDevice(key: string): Promise<void> {
    if (key === this.node.myKey) throw new Error('This is this device: another device removes it');
    if (!(await this.node.identity.members()).some((m) => m.key === key)) throw new Error('No such device in this workspace');
    await this.node.identity.removeMember(key);
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
        otherVersion: this.node.mergesDiffer(m.key),
        related: !!link?.hello && link.hello.workspace !== this.node.ws.id,
      });
    }
    return {
      device: { name: this.node.name, key: this.node.myKey, person: (await id.personOf(this.node.myKey))?.name ?? null },
      workspace: { id: this.node.ws.id, forkedFrom: this.node.ws.forkedFrom },
      devices,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.announceTimer);
    this.stopRefs?.();
    // Let fetches under way finish, but not hold closing up for long.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([Promise.allSettled([...this.fetching.values()]), new Promise((r) => (timer = setTimeout(r, 5000)))]);
    clearTimeout(timer);
    this.rooms.close();
    await this.node.close();
  }
}
