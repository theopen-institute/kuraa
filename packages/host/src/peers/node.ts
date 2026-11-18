// This device among the workspace's devices: finding them (Hyperswarm, by the
// workspace's topic), checking who they are, pairing new ones by invitation,
// sharing who the members are, and letting paired devices fetch from it.
//
// Who is let in: a paired device that has not been removed, and a device not
// yet paired that presents an invitation this one made.
// Membership spreads: a device paired with one member is accepted by the others
// once that member vouches for it, unless the workspace has an upstream device,
// whose word alone counts (see docs/decisions/0028-peers.md).
import { spawn } from 'node:child_process';
import type { Duplex } from 'node:stream';
import Hyperswarm, { type SwarmConnection } from 'hyperswarm';
import type { Git } from '../git.js';
import { GitBridge } from './bridge.js';
import { Identity, topicFor, type DeviceKey, type Member, type WorkspaceIdentity } from './identity.js';
import { PeerLink, type ControlMessage } from './link.js';

export interface NodeOptions {
  /** The repository's working tree. */
  dir: string;
  git: Git;
  /** .git/kuraa */
  stateDir: string;
  /** DHT bootstrap nodes: a private network, or tests. Default: Hyperswarm's public ones. */
  bootstrap?: unknown[];
  /** The most one fetch from a device may bring, in bytes. Default 2 GiB. */
  maxFetchBytes?: number;
  /** The branch a joining device should start on. */
  branch(): Promise<string>;
  log(m: string): void;
  /** Joining: the invitation to present to the inviting device. */
  invite?: { key: string; token: string };
}

/** A DHT node, from `host:port` or as given. */
const bootstrapNode = (b: unknown) => (typeof b === 'string' ? { host: b.slice(0, b.lastIndexOf(':')), port: Number(b.slice(b.lastIndexOf(':') + 1)) } : b);

export interface NodeEvents {
  /** A device's hello was accepted: it can be fetched from, and talked to. */
  accepted?(link: PeerLink): void;
  closed?(link: PeerLink): void;
  /** A device says its branches changed. */
  refs?(link: PeerLink): void;
  /** A message about rooms. */
  room?(link: PeerLink, m: Extract<ControlMessage, { type: 'room' }>): void;
  /** The inviting device's answer, when joining. */
  welcome?(link: PeerLink, m: Extract<ControlMessage, { type: 'welcome' }>): void;
  /** The members changed (a device paired or removed). */
  members?(): void;
}

export class PeerNode {
  readonly identity: Identity;
  ws!: WorkspaceIdentity;
  key!: DeviceKey;
  name = '';
  readonly links = new Map<string, PeerLink>();
  private swarm: Hyperswarm | null = null;
  readonly bridge: GitBridge;
  // Kept for the firewall, which must answer at once.
  private removedKeys = new Set<string>();
  private closing = false;

  constructor(private readonly o: NodeOptions, readonly events: NodeEvents = {}) {
    this.identity = new Identity(o.git, o.stateDir);
    this.bridge = new GitBridge({
      stateDir: o.stateDir,
      maxBytes: o.maxFetchBytes ?? 2 * 1024 ** 3,
      log: o.log,
      open: (key, service, protocol) => {
        const link = this.links.get(key);
        if (!link?.accepted) return `the device ${key.slice(0, 8)}… is not connected`;
        return link.openGit(service, protocol);
      },
    });
  }

  get myKey(): string {
    return this.key.publicKey.toString('hex');
  }

  /** Start, as a device of the workspace this repository belongs to; `found` makes it one if it is not yet. */
  async start(found: boolean): Promise<void> {
    const ws = await this.identity.workspace();
    if (!ws && !found) throw new Error('This repository is not a workspace shared between devices yet');
    this.ws = ws ?? (await this.identity.found());
    this.key = await this.identity.deviceKey();
    this.name = await this.identity.deviceName();
    await this.refresh();
    await this.bridge.start();
    this.swarm = new Hyperswarm({
      keyPair: this.key,
      ...(this.o.bootstrap ? { bootstrap: this.o.bootstrap.map(bootstrapNode) } : {}),
      firewall: (remote) => this.refuse(remote.toString('hex')),
    });
    this.swarm.on('connection', (conn) => this.connected(conn));
    // Paired devices are dialled directly too, as well as found by the topic.
    for (const m of await this.identity.members()) this.swarm.joinPeer(Buffer.from(m.key, 'hex'));
    this.swarm.join(topicFor(this.ws.secret), { server: true, client: true });
    // A fork still meets the devices of the workspace it came from, to fetch from them by hand.
    const origin = await this.identity.originSecret();
    if (origin) this.swarm.join(topicFor(origin), { server: true, client: true });
    this.o.log(`peers: this device is ${this.name} (${this.myKey.slice(0, 8)}…) in workspace ${this.ws.id.slice(0, 8)}…`);
  }

  /** Read the removed devices again (after a change). */
  async refresh(): Promise<void> {
    this.removedKeys = new Set(await this.identity.removed());
  }

  /**
   * Whether to turn a device away before it says anything: a removed one. Only
   * devices that know the workspace's secret find it at all; any other device
   * not paired is turned away after its hello, unless it brings an invitation.
   */
  private refuse(key: string): boolean {
    return this.closing || this.removedKeys.has(key);
  }

  private connected(conn: SwarmConnection): void {
    const key = conn.remotePublicKey.toString('hex');
    this.links.get(key)?.close();
    const link: PeerLink = new PeerLink(conn, () => {
      if (this.links.get(key) === link) this.links.delete(key);
      if (link.accepted) this.events.closed?.(link);
    });
    this.links.set(key, link);
    link.onMessage((m) => void this.message(link, m).catch((e: Error) => this.o.log(`peers: ${e.message}`)));
    link.onGit((service, protocol, stream) => this.serveGit(link, service, protocol, stream));
    void this.helloFor(link).then((h) => link.send(h));
  }

  private async helloFor(link: PeerLink): Promise<ControlMessage> {
    const members = await this.identity.members();
    return {
      type: 'hello',
      workspace: this.ws.id,
      forkedFrom: this.ws.forkedFrom,
      name: this.name,
      members: members.map((m) => ({ key: m.key, name: m.name })),
      removed: [...this.removedKeys],
      upstream: await this.upstreamKey(),
      ...(this.o.invite && this.o.invite.key === link.key ? { invite: this.o.invite.token } : {}),
    };
  }

  /** The upstream device's key, if the upstream is a device. */
  async upstreamKey(): Promise<string | null> {
    const up = await this.identity.upstream();
    if (!up) return null;
    return (await this.identity.members()).find((m) => m.name === up)?.key ?? (up === 'self' ? this.myKey : null);
  }

  private async message(link: PeerLink, m: ControlMessage): Promise<void> {
    if (m.type === 'hello') return this.hello(link, m);
    if (!link.accepted) return;
    if (m.type === 'refs') this.events.refs?.(link);
    else if (m.type === 'room') this.events.room?.(link, m);
    else if (m.type === 'welcome') this.events.welcome?.(link, m);
    else if (m.type === 'bye') {
      this.o.log(`peers: ${link.remote ?? link.key.slice(0, 8)} left: ${m.reason}`);
      link.close();
    }
  }

  private async hello(link: PeerLink, h: Extract<ControlMessage, { type: 'hello' }>): Promise<void> {
    // Again, from a device already accepted: what it now knows of the members.
    if (link.accepted) {
      link.hello = h;
      if (h.workspace === this.ws.id) await this.gossip(link, h);
      return;
    }
    const bye = (reason: string) => {
      link.send({ type: 'bye', reason });
      setTimeout(() => link.close(), 100);
    };
    if (this.removedKeys.has(link.key)) return bye('this device was removed from the workspace');
    const same = h.workspace === this.ws.id;
    // A fork and the workspace it came from may fetch from each other; neither brings the other's work in on its own.
    const related = (h.forkedFrom ?? '').startsWith(`${this.ws.id}@`) || (this.ws.forkedFrom ?? '').startsWith(`${h.workspace}@`);
    if (!same && !related) return bye('another workspace');
    let member: Member | undefined = (await this.identity.members()).find((x) => x.key === link.key);
    if (!member) {
      if (!same || typeof h.invite !== 'string' || !(await this.identity.redeem(h.invite))) return bye('not paired with this device');
      const name = await this.identity.addMember(link.key, h.name);
      if (!name) return bye('this device was removed from the workspace');
      member = { key: link.key, name };
      await this.refresh();
      this.o.log(`peers: paired with ${name} (${link.key.slice(0, 8)}…), by invitation`);
      const members = (await this.identity.members()).filter((x) => x.key !== link.key);
      link.send({ type: 'welcome', name: this.name, members: members.map((x) => ({ key: x.key, name: x.name })), upstream: await this.upstreamKey(), branch: await this.o.branch() });
      void this.membersChanged(link);
    }
    link.accepted = true;
    link.remote = member.name;
    link.hello = h;
    if (same) await this.gossip(link, h);
    this.events.accepted?.(link);
  }

  /** Take in what a member says about who else is (or is no longer) in the workspace. */
  private async gossip(link: PeerLink, h: Extract<ControlMessage, { type: 'hello' }>): Promise<void> {
    const upstream = await this.upstreamKey();
    if (upstream && upstream !== link.key) return;
    let changed = false;
    if (h.removed.includes(this.myKey)) {
      this.o.log('peers: this device was removed from the workspace; not syncing');
      await this.close();
      return;
    }
    for (const key of h.removed) {
      if (this.removedKeys.has(key)) continue;
      await this.identity.removeMember(key);
      this.links.get(key)?.close();
      changed = true;
    }
    const known = new Set((await this.identity.members()).map((m) => m.key));
    for (const m of h.members) {
      if (m.key === this.myKey || known.has(m.key) || this.removedKeys.has(m.key) || h.removed.includes(m.key)) continue;
      const name = await this.identity.addMember(m.key, m.name);
      if (name) {
        this.o.log(`peers: ${link.remote} vouches for ${name} (${m.key.slice(0, 8)}…)`);
        this.swarm?.joinPeer(Buffer.from(m.key, 'hex'));
        changed = true;
      }
    }
    // Which device is the upstream: learnt from a member when none is set here, and changed only by the upstream.
    const mine = await this.identity.upstream();
    if (h.upstream !== upstream && (!mine || upstream === link.key)) {
      const name = h.upstream === null ? null : h.upstream === this.myKey ? 'self' : (await this.identity.members()).find((m) => m.key === h.upstream)?.name;
      if (name !== undefined && !(name === null && !mine)) {
        await this.identity.setUpstream(name);
        this.o.log(`peers: the upstream is now ${name ?? 'none'} (from ${link.remote})`);
        changed = true;
      }
    }
    if (changed) await this.membersChanged(link);
  }

  /** The members changed: tell the other devices (not `except`, which told this one). */
  async membersChanged(except?: PeerLink): Promise<void> {
    await this.refresh();
    for (const l of this.links.values()) if (l.accepted && l !== except) l.send(await this.helloFor(l));
    this.events.members?.();
  }

  /** Let a paired device fetch: `git upload-pack`, nothing that writes. */
  private serveGit(link: PeerLink, service: string, protocol: string, stream: Duplex): void {
    if (!link.accepted || service !== 'git-upload-pack') return void stream.destroy();
    const child = spawn('git', ['upload-pack', '--strict', '--timeout=600', this.o.dir + '/.git'], {
      env: { ...process.env, ...(protocol ? { GIT_PROTOCOL: protocol } : {}) },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    stream.pipe(child.stdin);
    child.stdout.pipe(stream);
    child.on('error', () => stream.destroy());
    stream.on('error', () => child.kill());
    stream.on('close', () => child.kill());
  }

  private readonly fetches = new Map<string, Promise<boolean>>();

  /** Fetch a paired device's branches into `<its remote>/…`, one fetch per device at a time. Returns whether it worked. */
  fetch(remote: string): Promise<boolean> {
    const before = this.fetches.get(remote) ?? Promise.resolve(true);
    const run = before.catch(() => false).then(() => this.fetchNow(remote));
    this.fetches.set(remote, run);
    void run.finally(() => {
      if (this.fetches.get(remote) === run) this.fetches.delete(remote);
    });
    return run;
  }

  private async fetchNow(remote: string): Promise<boolean> {
    const r = await this.o.git.run([
      '-c', 'core.hooksPath=/dev/null', '-c', 'fetch.recurseSubmodules=false', '-c', 'protocol.version=2',
      'fetch', '--prune', '--no-write-fetch-head', remote,
    ], { allowFail: true, timeoutMs: 10 * 60_000, env: { PATH: `${this.bridge.binDir}:${process.env.PATH ?? ''}` } });
    if (r.code !== 0) this.o.log(`peers: fetching from ${remote} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.code === 0;
  }

  /** Tell every connected device something. */
  broadcast(m: ControlMessage): void {
    for (const link of this.links.values()) if (link.accepted) link.send(m);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    for (const link of this.links.values()) link.close();
    await this.swarm?.destroy();
    await this.bridge.close();
  }
}
