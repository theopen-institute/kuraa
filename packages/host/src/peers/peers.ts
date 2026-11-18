// The host as one of a workspace's devices (see docs/decisions/0028-peers.md).
//
// Git between devices: when a device connects, or says its branches moved, this
// one fetches them (into `<device>/<branch>`) and brings them into its own
// branches: a fast-forward, or a merge made as every device makes it (0025), so
// devices converge without merging each other's merges. When this device's
// branches move, it tells the others. Rooms across devices: rooms.ts.
//
// The upstream, by convention (`kuraa.upstream`): with none, every device brings
// in every other's work. With an upstream device, it brings in everyone's work,
// except on gated branches (`kuraa.gated`), where other devices' work waits as a
// proposal until someone there accepts it; the other devices take the
// upstream's work, and each other's only while the upstream is away (and never
// on gated branches). With an ordinary git remote as upstream (GitHub, say),
// devices also sync with it, after their commits and every few minutes.
import { describeOutcome, type Host } from '../host.js';
import type { PeerLink } from './link.js';
import { PeerNode } from './node.js';
import { encodeInvitation } from './identity.js';
import { Rooms } from './rooms.js';

export interface PeerOptions {
  /** DHT bootstrap nodes (`host:port`): a private network, or tests. Default: Hyperswarm's public ones. */
  bootstrap?: (string | { host: string; port: number })[];
  /** The most one fetch from a device may bring, in bytes. */
  maxFetchBytes?: number;
  /** How often to sync with an ordinary upstream remote, in ms (default 5 minutes). */
  remoteSyncMs?: number;
}

export interface DeviceInfo {
  name: string;
  key: string;
  online: boolean;
  upstream: boolean;
  /** A fork of this workspace, or the workspace this one was forked from: fetched from, never merged on its own. */
  related: boolean;
}

export interface Proposal {
  device: string;
  branch: string;
  /** Commits it has that this device's branch does not. */
  commits: number;
  subject: string;
}

export interface PeersStatus {
  device: { name: string; key: string };
  workspace: { id: string; forkedFrom: string | null };
  upstream: { name: string; kind: 'self' | 'device' | 'remote' } | null;
  gated: string[];
  devices: DeviceInfo[];
  proposals: Proposal[];
}

type Policy = 'merge' | 'hold';

export class Peers {
  readonly node: PeerNode;
  readonly rooms: Rooms;
  private readonly fetching = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private announceTimer: NodeJS.Timeout | undefined;
  private remoteTimer: NodeJS.Timeout | undefined;
  private remoteSoon: NodeJS.Timeout | undefined;
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
    const every = this.opts.remoteSyncMs ?? 5 * 60_000;
    this.remoteTimer = setInterval(() => void this.syncRemoteQuietly(), every);
    this.remoteTimer.unref();
  }

  /** Tell the other devices this one's branches moved (soon, once for a burst), and an upstream remote. */
  private announce(): void {
    clearTimeout(this.announceTimer);
    this.announceTimer = setTimeout(() => this.node.broadcast({ type: 'refs' }), 200);
    clearTimeout(this.remoteSoon);
    this.remoteSoon = setTimeout(() => void this.syncRemoteQuietly(), 30_000);
    this.remoteSoon.unref();
  }

  private async syncRemoteQuietly(): Promise<void> {
    if (this.closed) return;
    const up = await this.node.identity.upstream();
    const remote = await this.host.gitUpstream();
    if (!up || !remote || up !== remote) return;
    await this.host.serial(() => this.host.syncRemote(remote)).catch((e: Error) => this.host.log(`peers: syncing with ${remote} failed: ${e.message}`));
  }

  /** Fetch from a device and bring its work in; one at a time per device, again if asked meanwhile. */
  syncFrom(link: PeerLink): Promise<void> {
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

  /** What to do with a device's branch: bring it in, or hold it (a proposal). */
  private async policy(device: string, branch: string): Promise<Policy> {
    const upstream = await this.node.upstreamKey();
    if (!upstream) return 'merge';
    const gated = (await this.node.identity.gated()).includes(branch);
    if (upstream === this.node.myKey) return gated ? 'hold' : 'merge';
    if (upstream === device) return 'merge';
    // Another device: only while the upstream is away, and never on a gated branch.
    return gated || this.node.links.get(upstream)?.accepted ? 'hold' : 'merge';
  }

  /** The branches a device has, from what was fetched. */
  private async branchesOf(remote: string): Promise<{ branch: string; oid: string }[]> {
    const out = await this.host.git.out(['for-each-ref', '--format=%(refname)%00%(objectname)', `refs/remotes/${remote}/`]);
    return out.split('\n').filter(Boolean).map((l) => {
      const [ref, oid] = l.split('\0');
      return { branch: ref!.slice(`refs/remotes/${remote}/`.length), oid: oid! };
    }).filter((b) => b.branch !== 'HEAD');
  }

  private async bringIn(link: PeerLink): Promise<void> {
    const remote = link.remote!;
    for (const { branch, oid } of await this.branchesOf(remote)) {
      if ((await this.policy(link.key, branch)) === 'hold') continue;
      await this.bringBranch(branch, `refs/remotes/${remote}/${branch}`, oid, link);
    }
  }

  /** Bring a commit into a branch: the checked-out one through the working tree, others by their ref alone. */
  private async bringBranch(branch: string, ref: string, oid: string, link: PeerLink | null): Promise<void> {
    await this.host.serial(async () => {
      const current = await this.host.git.branch();
      if (branch === current) {
        const outcome = await this.host.integrate(ref, link ? this.rooms.override(link) : undefined);
        if (outcome.kind !== 'same') this.host.log(`peers: brought in ${branch} from ${link?.remote ?? ref}${describeOutcome(outcome)}`);
        return;
      }
      const local = await this.host.git.run(['rev-parse', '--verify', '-q', `refs/heads/${branch}`], { allowFail: true });
      if (local.code !== 0) {
        await this.host.git.run(['update-ref', `refs/heads/${branch}`, oid, '']);
        this.host.refsChanged();
        return;
      }
      const mine = local.stdout.trim();
      const outcome = await this.host.merge(mine, oid);
      if (outcome.commit !== mine) {
        await this.host.git.run(['update-ref', `refs/heads/${branch}`, outcome.commit, mine]);
        this.host.refsChanged();
      }
    });
  }

  /** Accept a device's held work on a branch (a proposal): bring it in. */
  async accept(device: string, branch: string): Promise<void> {
    const ref = `refs/remotes/${device}/${branch}`;
    const oid = await this.host.git.out(['rev-parse', '--verify', ref]);
    const link = [...this.node.links.values()].find((l) => l.remote === device) ?? null;
    await this.bringBranch(branch, ref, oid, link);
  }

  /** Make an invitation for another device to join (CLI: kuraa-host invite). */
  async invitation(hours = 24): Promise<string> {
    const token = await this.node.identity.invite(hours);
    await this.node.refresh();
    return encodeInvitation({ workspace: this.node.ws, inviter: { key: this.node.myKey, name: this.node.name }, token });
  }

  async status(): Promise<PeersStatus> {
    const id = this.node.identity;
    const members = await id.members();
    const upName = await id.upstream();
    const upKey = await this.node.upstreamKey();
    const proposals: Proposal[] = [];
    for (const m of members) {
      const link = this.node.links.get(m.key);
      if (link?.hello && link.hello.workspace !== this.node.ws.id) continue;
      for (const { branch, oid } of await this.branchesOf(m.name)) {
        if ((await this.policy(m.key, branch)) !== 'hold') continue;
        const count = await this.host.git.run(['rev-list', '--count', `refs/heads/${branch}..${oid}`], { allowFail: true });
        const commits = count.code === 0 ? Number(count.stdout.trim()) : Number((await this.host.git.out(['rev-list', '--count', oid])) || 0);
        if (commits > 0) proposals.push({ device: m.name, branch, commits, subject: await this.host.git.out(['log', '-1', '--format=%s', oid]) });
      }
    }
    return {
      device: { name: this.node.name, key: this.node.myKey },
      workspace: { id: this.node.ws.id, forkedFrom: this.node.ws.forkedFrom },
      upstream: upName ? { name: upName === 'self' ? this.node.name : upName, kind: upName === 'self' ? 'self' : upKey ? 'device' : 'remote' } : null,
      gated: await id.gated(),
      devices: members.map((m) => {
        const link = this.node.links.get(m.key);
        return {
          name: m.name,
          key: m.key,
          online: !!link?.accepted,
          upstream: m.key === upKey,
          related: !!link?.hello && link.hello.workspace !== this.node.ws.id,
        };
      }),
      proposals,
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    clearTimeout(this.announceTimer);
    clearTimeout(this.remoteSoon);
    clearInterval(this.remoteTimer);
    this.stopRefs?.();
    // Let fetches under way finish, but not hold closing up for long.
    await Promise.race([Promise.allSettled([...this.fetching.values()]), new Promise((r) => setTimeout(r, 5000))]);
    this.rooms.close();
    await this.node.close();
  }
}
