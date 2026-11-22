// This device among the workspace's devices: finding them (Hyperswarm, by the
// workspace's topic), checking who they are, pairing new ones by invite link,
// sharing who the members are, and letting paired devices fetch from it.
//
// Who is let in: a paired device that has not been removed, and a device not
// yet paired that presents an invite link a member made (any member checks it).
// A device joining pairs with one the link's maker vouches for: the maker, or
// one its pairing records trace back to it (records.ts, traced). Records go
// only to paired devices. Membership spreads: a device paired with one member
// is paired by the others once that member vouches for it; every member has the
// same say (see docs/decisions/0028-peers.md and 0038).
import { createHash } from 'node:crypto';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { writeAllowedSigners } from '../signing.js';
import { personFile, readPerson, revokedFile, revokedKeys, signingKey, type Person } from './person.js';
import type { KeyPair } from '../keys.js';
import { stat } from 'node:fs/promises';
import { pipeline, type Duplex } from 'node:stream';
import Hyperswarm, { type Discovery, type SwarmConnection } from 'hyperswarm';
import { gitEnv, gitPath, spawnGit, type Git } from '../git.js';
import { GitBridge } from './bridge.js';
import { useDht } from './dht.js';
import { Relay, isRelayKey } from './relay.js';
import { Identity, TOPIC_WEEK, checkLink, decodeLink, lanKeyFor, topicsFor, type Member, type WorkspaceIdentity } from './identity.js';
import { joinLan } from './lan.js';
import NoiseSecretStream from '@hyperswarm/secret-stream';
import type { Socket } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { dialTcp, listenTcp, parseAddress } from './tcp.js';
import { traced } from './records.js';
import { outputRefs, outputsRefspec } from './outputs.js';
import { EventEmitter } from 'node:events';
import { PROTOCOL, PeerLink, readHeads, readOutputs, type ControlMessage, type OutputsFrame, type TunnelAsk } from './link.js';

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
  /** Joining: the invite link to present to the workspace's devices. */
  ticket?: string;
  /** Joining: any device the link's maker vouches for lets this one in. */
  joining?: boolean;
  /**
   * Joining by a link that does not carry the workspace's secret (0050): the
   * workspace, the topic to look its members up by, and the devices to dial
   * (the link's maker, and those it came in through). The secret comes with the
   * welcome.
   */
  joinAs?: { id: string; forkedFrom: string | null; topic: string; dial: string[]; /** `key@host:port`: servers taking TCP connections (the link's hints). */ tcp?: string[] };
  /** How this device merges, told to the others (merging.ts, mergeSignature). */
  merges?: string;
  /** This computer's person's identity (person.ts); undefined: the one this computer keeps, if any. Tests give theirs. */
  person?: Person | null;
  /** This computer's signing key for its person; undefined: the one this computer keeps (made on first use). Tests give theirs. */
  signing?: KeyPair;
  /** How long a device is dialled for, when there is reason to (dial), in ms. Default a minute. */
  dialMs?: number;
  /** When to look the workspace up again while a member is missing, in ms after it went (lookAgain). */
  lookupsMs?: number[];
  /** Relays run by someone (relay.ts, `kuraa-host relay`), by key: gone through when no member offers one. */
  relays?: string[];
  /** Offer the workspace's other members a relay (relay.ts) when this network allows. Default: yes. */
  offerRelay?: boolean;
  /** Find devices on the local network too (lan.ts). Default: yes. */
  lan?: boolean;
  /**
   * A server's: take connections over TCP on this port (tcp.ts), for devices on
   * networks that block the DHT's UDP. With `publicAddress`, said to the members.
   */
  peerPort?: number;
  /** Where others reach this device over TCP (`host:port`, or `host`, with peerPort): told to the members, and put in invite links. */
  publicAddress?: string;
  /** Run this computer's DHT node on this port (dht.ts): with publicAddress, the members can start from it (a server). */
  dhtPort?: number;
  /** false: never serve the public DHT (a node with a public address does after a while, by default). */
  serveDht?: boolean;
  /** Tests: whether this device can reach a device directly (DHT, local network, TCP); default: every one. Tunnels are not direct. */
  direct?: (key: string) => boolean;
  /** Tests: which computer this device is on (devices of one computer reach each other's workspaces over one link). Default: this one. */
  computer?: string;
  /** How long a device another one reaches is dialled before going through that one instead (tunnels). Default 20 s. */
  tunnelAfterMs?: number;
}

/** What a node joining a workspace (join.ts) takes on when it goes on as the workspace's device for its host. */
export type MemberOptions = Pick<NodeOptions, 'git' | 'branch' | 'log' | 'merges' | 'person' | 'signing'>;

/**
 * How long a device is dialled for (Hyperswarm's own tries, backing off) when
 * there is reason to think it is there: this device just started, it was just
 * paired, or another device says it is connected to it. Then it is let be.
 */
const DIAL_MS = 60_000;

/**
 * While a member is missing, the workspace's topic is looked up again this long
 * after it went (or after this device started, or the network changed): one
 * lookup finds every device of the workspace that is online, however many are
 * missing. Each waits up to a quarter more at random, so two devices that lost
 * each other at once do not both look, and dial, at the same moment. After the
 * last, Hyperswarm's own lookup every ten minutes goes on.
 */
const LOOKUPS_MS = [15_000, 60_000, 120_000, 240_000, 480_000];

/**
 * News for whoever runs this process (the desktop app updates itself on it):
 * 'newer', when a device of a workspace speaks a newer protocol than this one
 * (PROTOCOL), so this kuraa is out of date.
 */
export const versionNews = new EventEmitter();

/** Which records a device holds, as one hash: the same records, the same hash, in any order. */
export function digestOf(records: { sig: string }[]): string {
  return createHash('sha256').update(records.map((r) => r.sig).sort().join('\n')).digest('hex');
}

/**
 * The records to give a device: all, but the workspace's secret never to a
 * removed one (told it was removed, it must not learn where the others are).
 */
function forDevice<R extends { kind: string }>(records: R[], key: string, removed: Set<string>): R[] {
  return removed.has(key) ? records.filter((r) => r.kind !== 'secret') : records;
}

/** Two buffers of the same length, xored. */
function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i % b.length]!;
  return out;
}

/** A record named by the start of its signature, to say which records a device has. */
const shortSig = (sig: string) => sig.slice(0, 16);

/** How long a connection of this layer's own (local network, TCP, tunnel) may stay quiet before it counts as gone: three keepalives. */
const QUIET_MS = 15_000;

/** How long a device another one reaches is dialled directly before this one goes through that one (a tunnel). */
const TUNNEL_AFTER_MS = 20_000;

/** The most tunnels a device passes on for one other device at once. */
const MAX_PASSED_ON = 16;

/** How a device is connected here: on the local network, over TCP to a public address, through another device, or by the DHT. */
export type Via = 'lan' | 'tcp' | 'tunnel' | 'internet';

/**
 * This computer's devices: every workspace's node in this process, by key, for
 * each computer (tests run several in one process). A tunnel for one of them
 * ends here; and over one link to another computer, the others find the
 * workspaces they share with it (also).
 */
const computers = new Map<string, Map<string, PeerNode>>();
const localNodes = (computer: string) => computers.get(computer) ?? computers.set(computer, new Map()).get(computer)!;

/** Addresses on a local network (private, link-local, this computer): a TCP connection from one is on the local network. */
const LOCAL_ADDRESS = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.|::1$|f[cd][0-9a-f]{2}:|fe80:|::ffff:(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|127\.))/i;

/** What a device remembers of the others between runs (.git/kuraa/hints.json): where servers take TCP, relays named, when each was last seen. */
interface Hints {
  tcp: Record<string, string[]>;
  relays: string[];
  seen: Record<string, number>;
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
  /** Run outputs as they happen on the device (outputs.ts, 0062). */
  outputs?(link: PeerLink, frame: OutputsFrame): void;
  /** The answer of the device that let this one in, when joining. */
  welcome?(link: PeerLink, m: Extract<ControlMessage, { type: 'welcome' }>): void;
  /** The members changed (a device paired or removed). */
  members?(): void;
  /** A device turned this one away, saying why. */
  refused?(link: PeerLink, reason: string): void;
}

export class PeerNode {
  readonly identity: Identity;
  /** Replaced when a joining node goes on as the workspace's device (becomeMember). */
  events: NodeEvents;
  ws!: WorkspaceIdentity;
  key!: KeyPair;
  name = '';
  readonly links = new Map<string, PeerLink>();
  private swarm: Hyperswarm | null = null;
  readonly bridge: GitBridge;
  // Kept for the firewall, which must answer at once.
  private removedKeys = new Set<string>();
  private closing = false;
  /** This computer's person's key as last read (from its file, unless given). */
  private personRead: { stamp: string; person: Person | null } | null = null;
  /** What this device last said in this workspace about its signing key and its person (syncPerson). */
  private saidFor: string | null = null;
  /** The topics this device is on (by hex): the workspace's, this week's and last; its origin's; the live invite links'. */
  private readonly discoveries = new Map<string, { d: Discovery; client: boolean }>();
  /** When the topics change next: a new week, or a link expiring. */
  private topicTimer: NodeJS.Timeout | undefined;
  private topicsChanging: Promise<void> = Promise.resolve();
  private lookupTimer: NodeJS.Timeout | undefined;
  private lookupStep = 0;
  /** Devices being dialled, until they are let be (dial). */
  private readonly dialling = new Map<string, NodeJS.Timeout>();
  private presenceTimer: NodeJS.Timeout | undefined;
  /** Devices met that speak another protocol (PROTOCOL), and which: they do not sync until updated. */
  readonly versions = new Map<string, number>();
  /** The relay this device offers the other members (relay.ts), if any. */
  private relay: Relay | null = null;
  /** The local network (lan.ts): how this device says where it is, and its codes. */
  private lan: { say(ask: boolean): void; leave(): void } | null = null;
  private lanKeys: Buffer[] = [];
  /** Taking connections over TCP (tcp.ts): the process's port, and how to stop. */
  private tcp: { port: number; stop(): void } | null = null;
  /** Connections of this layer's own, and how each came: local network, TCP, a tunnel. */
  private readonly kinds = new WeakMap<object, Exclude<Via, 'internet'>>();
  /** Devices being connected to over TCP, or through a tunnel, now. */
  private readonly ownDialling = new Set<string>();
  /** When to go through another device to one not reached directly (reach), by key. */
  private readonly tunnelTimers = new Map<string, NodeJS.Timeout>();
  /** Tunnels this device passes on now, for each device that asked. */
  private readonly passing = new Map<string, number>();
  private hints: Hints = { tcp: {}, relays: [], seen: {} };
  /** Links this device has answered an `also` on, so the device there connects (heardAlso). */
  private readonly alsoAnswered = new WeakSet<PeerLink>();
  private hintsTimer: NodeJS.Timeout | undefined;
  /** Records this device has passed on to the devices connected (membersChanged); a device connecting later asks (want). */
  private readonly told = new Set<string>();

  constructor(private readonly o: NodeOptions, events: NodeEvents = {}) {
    this.events = events;
    this.identity = new Identity(o.git, o.stateDir);
    this.bridge = new GitBridge({
      stateDir: o.stateDir,
      maxBytes: o.maxFetchBytes ?? 2 * 1024 ** 3,
      log: (m) => this.o.log(m),
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

  /** Which computer this device is on (tests run several in one process). */
  private get computer(): string {
    return this.o.computer ?? 'this';
  }

  /** This computer's DHT node, where members can start from it: a server's, on its public address and fixed DHT port. */
  private get dhtAddress(): string | null {
    const at = parseAddress(this.publicAddress) ?? (this.o.publicAddress ? { host: this.o.publicAddress.trim(), port: 0 } : null);
    if (!at || !this.o.dhtPort || this.o.serveDht === false) return null;
    return `${at.host.includes(':') ? `[${at.host}]` : at.host}:${this.o.dhtPort}`;
  }

  /** Start, as a device of the workspace this repository belongs to; `found` makes it one if it is not yet. */
  async start(found: boolean): Promise<void> {
    const ws = await this.identity.workspace();
    const joinAs = this.o.joinAs;
    if (!ws && !found && !joinAs) throw new Error('This repository is not a workspace shared between devices yet');
    // Joining by a link without the secret: the workspace is known by its id until the welcome brings the secret.
    this.ws = ws ?? (joinAs ? { id: joinAs.id, secret: '', forkedFrom: joinAs.forkedFrom } : await this.identity.found());
    this.key = await this.identity.deviceKey();
    this.name = await this.identity.deviceName();
    // Whose this device is, if this computer keeps a person's key: said in this workspace, with their signature.
    await this.syncPerson();
    // What the records say, applied, in case a record was kept and this device stopped before applying it.
    await this.identity.reconcile();
    for (const r of await this.identity.records()) this.told.add(r.sig);
    await this.refresh();
    await this.bridge.start();
    this.hints = await this.readHints();
    localNodes(this.computer).set(this.myKey, this);
    // The process's DHT node, shared with every other workspace's swarm (dht.ts); this workspace's own key.
    const dht = await useDht(this.o.bootstrap?.map(bootstrapNode), { port: this.o.dhtPort, ephemeral: this.o.serveDht === false ? true : undefined });
    this.swarm = new Hyperswarm({
      keyPair: this.key,
      dht,
      // A device connected on the local network or over TCP is not connected to again through the DHT.
      firewall: (remote) => {
        const key = remote.toString('hex');
        return this.refuse(key) || this.keepsOwn(key) || this.o.direct?.(key) === false;
      },
      relayThrough: (force) => this.relayFor(force),
    });
    if (this.o.offerRelay !== false) {
      this.relay = new Relay(dht);
      await this.relay.start().catch((e: Error) => {
        this.relay = null;
        this.o.log(`peers: no relay offered: ${e.message}`);
      });
    }
    this.swarm.on('connection', (conn) => this.connected(conn));
    // Just started: this device dials the others, found by the topic and directly (the others do not
    // know it is back). Hyperswarm looks the topic up again when the network changes; so does this, on its schedule.
    for (const m of await this.identity.members()) this.dial(m.key);
    for (const k of joinAs?.dial ?? []) this.dial(k);
    await this.retopic();
    if (this.o.lan !== false || this.o.peerPort) await this.startTcp();
    // Servers this device knows take TCP: for when the DHT cannot be reached (and joining, the link's).
    await this.dialKnown();
    for (const hint of joinAs?.tcp ?? []) {
      const at = hint.indexOf('@');
      if (at <= 0) continue;
      const key = hint.slice(0, at);
      const address = hint.slice(at + 1);
      // Kept too: once joined, this device goes on reaching that server the same way.
      this.hints.tcp[key] = [...new Set([address, ...(this.hints.tcp[key] ?? [])])].slice(0, 4);
      this.saveHints();
      this.dialTcpTo(key, address);
    }
    this.swarm.dht.on('network-change', () => {
      this.lan?.say(true);
      this.lookAgain();
    });
    // What this network is like is learned after starting: the relay offered, and how good, follows it.
    let relaySaid = this.relayOffered + String(this.relayPublic);
    this.swarm.dht.on('network-update', () => {
      const now = this.relayOffered + String(this.relayPublic);
      if (now === relaySaid) return;
      relaySaid = now;
      for (const l of this.links.values()) if (l.accepted) void this.helloFor(l).then((h) => l.send(h), (e: Error) => this.logUnlessClosing(e));
    });
    // The other workspaces of this computer that devices connected here share with it: over the same links.
    for (const other of localNodes(this.computer).values()) if (other !== this) for (const l of other.links.values()) if (l.accepted) other.sayAlso(l);
    this.lookAgain();
    this.o.log(`peers: this device is ${this.name} (${this.myKey.slice(0, 8)}…) in workspace ${this.ws.id.slice(0, 8)}…`);
  }

  /**
   * Dial a device for a while (DIAL_MS): Hyperswarm tries, and tries again
   * backing off, until it connects or the time is up, and then lets it be.
   * Dialling every member for good would cost each device a lookup for each
   * member missing, again and again, for as long as it is gone.
   */
  private dial(key: string): void {
    const swarm = this.swarm;
    if (!swarm || this.closing || key === this.myKey || this.links.has(key) || this.dialling.has(key)) return;
    const pk = Buffer.from(key, 'hex');
    swarm.joinPeer(pk);
    const t = setTimeout(() => {
      this.dialling.delete(key);
      swarm.leavePeer(pk);
    }, this.o.dialMs ?? DIAL_MS);
    t.unref();
    this.dialling.set(key, t);
  }

  /** Whether a member has no connection here that it was let in on. */
  private async missing(): Promise<boolean> {
    return (await this.identity.members()).some((m) => !this.links.get(m.key)?.accepted);
  }

  /** Look the workspace up again on the schedule (LOOKUPS_MS), from its start: a member went, this device started, the network changed. */
  private lookAgain(): void {
    clearTimeout(this.lookupTimer);
    this.lookupStep = 0;
    this.nextLookup();
  }

  private nextLookup(): void {
    const delays = this.o.lookupsMs ?? LOOKUPS_MS;
    if (this.closing || this.lookupStep >= delays.length) return;
    const ms = delays[this.lookupStep++]!;
    this.lookupTimer = setTimeout(() => void this.lookup().catch((e: Error) => this.o.log(`peers: looking for the workspace's devices: ${e.message}`)), ms + Math.random() * (ms / 4));
    this.lookupTimer.unref();
  }

  /**
   * One lookup of the workspace's topics (Hyperswarm dials whom it finds), while
   * anyone is missing; the schedule stops once no one is. With no member here at
   * all, the members are dialled too: if the workspace's secret was made anew
   * while this device was away, no one is on the topics it knows.
   */
  private async lookup(): Promise<void> {
    if (this.closing || !(await this.missing())) return;
    if (!this.connectedHere().length) for (const m of await this.identity.members()) this.dial(m.key);
    await this.dialKnown();
    this.lan?.say(true);
    for (const [hex, { d, client }] of [...this.discoveries]) {
      if (!client) continue;
      // A topic Hyperswarm let go of (it does, when its DHT node cannot announce): joined again.
      await d.refresh().catch(() => {
        this.discoveries.delete(hex);
        void this.retopic();
      });
    }
    this.nextLookup();
  }

  /**
   * Take connections over TCP (tcp.ts): on the local network, where this device
   * says it is (lan.ts), and from anywhere on a server's --peer-port. Encrypted
   * and checked with this device's key, as the DHT's connections are.
   */
  private async startTcp(): Promise<void> {
    this.tcp = await listenTcp(this.myKey, this.o.peerPort, (sock) => this.tcpAccept(sock), (m) => this.o.log(m));
    if (!this.tcp || this.closing || this.o.lan === false) return;
    const port = this.tcp.port;
    this.lan = await joinLan({
      key: this.myKey,
      port: () => port,
      keys: () => this.lanKeys,
      found: (key, host, p) => this.lanFound(key, host, p),
    }, (m) => this.o.log(m));
    this.lan.say(true);
  }

  /** Whether a device has a link here that is not to be replaced by one through the DHT: on the local network, or over TCP. */
  private keepsOwn(key: string): boolean {
    const link = this.links.get(key);
    const kind = link && !link.closed ? this.kinds.get(link.conn) : undefined;
    return kind === 'lan' || kind === 'tcp';
  }

  /** A link to the device, not closed. */
  private live(key: string): boolean {
    const link = this.links.get(key);
    return !!link && !link.closed;
  }

  /** A device of the workspace said where it is on the local network: connected to, if this one has the lower key and is not connected to it. */
  private lanFound(key: string, host: string, port: number): void {
    if (this.myKey > key) return;
    this.dialTcpTo(key, `${host.includes(':') ? `[${host}]` : host}:${port}`, 'lan');
  }

  /** Connect to a device over TCP (on the local network, or to a server), unless connected or connecting to it. */
  private dialTcpTo(key: string, address: string, kind: 'lan' | 'tcp' = 'tcp'): void {
    const at = parseAddress(address);
    if (!at || this.closing || key === this.myKey || this.removedKeys.has(key) || this.live(key) || this.ownDialling.has(key) || this.o.direct?.(key) === false) return;
    this.ownDialling.add(key);
    this.ownOpened(dialTcp(at.host, at.port, key, this.key), kind, () => this.ownDialling.delete(key));
  }

  /** Members' servers this device knows take TCP (hints), for those not connected. */
  private async dialKnown(): Promise<void> {
    for (const m of await this.identity.members()) for (const a of this.hints.tcp[m.key] ?? []) this.dialTcpTo(m.key, a);
  }

  private tcpAccept(sock: Socket): void {
    const kind = LOCAL_ADDRESS.test(sock.remoteAddress ?? '') ? 'lan' : 'tcp';
    this.ownOpened(new NoiseSecretStream(false, sock, { keyPair: this.key, keepAlive: 5000 }), kind, () => undefined);
  }

  /**
   * A connection of this layer's own (local network, TCP, a tunnel): once the
   * other end has proved its key (`expect`, if known), a link like any other,
   * unless there is one.
   */
  private ownOpened(stream: NoiseSecretStream, kind: Exclude<Via, 'internet'>, done: () => void, expect?: string): void {
    stream.on('error', () => undefined);
    // Gone quiet (both ends send keepalives every 5 s): the other end is asleep or off the network, and the
    // link closes, rather than seeming open until TCP gives up many minutes later. The handshake too.
    stream.setTimeout(QUIET_MS);
    void stream.opened.then((ok) => {
      done();
      const key = stream.remotePublicKey?.toString('hex');
      if (!ok || !key || (expect && key !== expect) || this.closing || this.refuse(key) || this.live(key) || (kind !== 'tunnel' && this.o.direct?.(key) === false)) return void stream.destroy();
      (stream as unknown as { rawStream?: { setTimeout?(ms: number): void } }).rawStream?.setTimeout?.(0);
      this.kinds.set(stream, kind);
      this.connected(stream as unknown as SwarmConnection);
    }, () => {
      done();
      stream.destroy();
    });
  }

  // Tunnels: another device's connection, carried on a link (link.ts) -----------

  /**
   * Go through `via` to a device: `via` passes the bytes on to it (it is
   * connected to both), or, for another workspace of the computer at the other
   * end, takes them itself. End to end, the two run Noise inside: `via` reads
   * nothing. A connection made directly later takes its place (connected).
   */
  tunnelTo(key: string, via: PeerLink): void {
    if (this.closing || key === this.myKey || this.removedKeys.has(key) || this.live(key) || this.ownDialling.has(key) || via.closed) return;
    this.ownDialling.add(key);
    const raw = via.openTunnel({ to: key, from: this.myKey });
    const stream = new NoiseSecretStream(true, raw, { keyPair: this.key, remotePublicKey: Buffer.from(key, 'hex'), keepAlive: 5000 });
    this.ownOpened(stream, 'tunnel', () => this.ownDialling.delete(key), key);
  }

  /**
   * A tunnel asked for on a link to this device: for a device of this computer
   * (this workspace's or another's), taken here; for one this device is
   * connected to in this workspace, passed on, for a member of it.
   */
  private tunnelAsked(link: PeerLink, ask: TunnelAsk, stream: Duplex): void {
    if (!link.accepted || this.closing) return void stream.destroy();
    const here = localNodes(this.computer).get(ask.to);
    if (here) return here.tunnelArrived(ask.from, stream);
    const next = this.links.get(ask.to);
    const passing = this.passing.get(link.key) ?? 0;
    if (ask.from !== link.key || link.hello?.workspace !== this.ws.id || !next?.accepted || next.hello?.workspace !== this.ws.id || passing >= MAX_PASSED_ON) return void stream.destroy();
    this.passing.set(link.key, passing + 1);
    const onward = next.openTunnel(ask);
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.passing.set(link.key, (this.passing.get(link.key) ?? 1) - 1);
    };
    pipeline(stream, onward, end);
    pipeline(onward, stream, end);
  }

  /** A tunnel from another device has reached this one: a link like any other, once it proves it is `from`. */
  tunnelArrived(from: string, stream: Duplex): void {
    if (this.closing || this.refuse(from) || this.live(from)) return void stream.destroy();
    this.ownOpened(new NoiseSecretStream(false, stream, { keyPair: this.key, keepAlive: 5000 }), 'tunnel', () => undefined, from);
  }

  /**
   * Tell a device connected here which of this computer's other workspaces this
   * computer is in (also), so that if its computer is in one too, the two
   * connect for it over this link instead of finding each other anew. Each is
   * told as a code from that workspace's secret: only a device that knows it
   * can tell which, and learn this computer's device in it.
   */
  sayAlso(link: PeerLink): void {
    const entries = [];
    for (const n of localNodes(this.computer).values()) {
      if (n === this || !n.ws?.secret) continue;
      const k = lanKeyFor(n.ws.secret);
      const pad = createHmac('sha256', k).update(`kuraa also key\0${this.myKey}\0${link.key}`).digest();
      entries.push({ t: createHmac('sha256', k).update(`kuraa also\0${this.myKey}\0${link.key}`).digest('hex').slice(0, 32), k: xor(Buffer.from(n.myKey, 'hex'), pad).toString('hex') });
    }
    if (entries.length) link.send({ type: 'also', entries: entries.slice(0, 64) });
  }

  /** A device said which other workspaces its computer is in: for each this computer is in too, the lower key connects, through this link. */
  private heardAlso(link: PeerLink, entries: unknown[]): void {
    const said = new Map<string, string>();
    for (const e of entries.slice(0, 64)) {
      const x = e as { t?: unknown; k?: unknown };
      if (typeof x.t === 'string' && typeof x.k === 'string' && /^[0-9a-f]{64}$/.test(x.k)) said.set(x.t, x.k);
    }
    for (const n of localNodes(this.computer).values()) {
      if (n === this || !n.ws?.secret || n.closing) continue;
      const k = lanKeyFor(n.ws.secret);
      const enc = said.get(createHmac('sha256', k).update(`kuraa also\0${link.key}\0${this.myKey}`).digest('hex').slice(0, 32));
      if (!enc) continue;
      const pad = createHmac('sha256', k).update(`kuraa also key\0${link.key}\0${this.myKey}`).digest();
      const theirs = xor(Buffer.from(enc, 'hex'), pad).toString('hex');
      if (theirs === n.myKey || n.live(theirs)) continue;
      if (n.myKey < theirs) n.tunnelTo(theirs, link);
      // The other connects: it hears of this computer's workspaces in turn (once a link).
      else if (!this.alsoAnswered.has(link)) {
        this.alsoAnswered.add(link);
        this.sayAlso(link);
      }
    }
  }

  /**
   * Be on the topics this device should be on, and on no others: the
   * workspace's (from its secret: this week's and last week's, topicsFor), the
   * workspace it was forked from (a fork still meets its devices, to fetch from
   * by hand), and every invite link that still lets people in, announced so its
   * holder finds a member (from the link records; this device need not have
   * made it). Joining by a link without the secret: only the link's topic,
   * looked up. Again at the next week, the next link expiring, and when the
   * secret or the links change.
   */
  retopic(): Promise<void> {
    this.topicsChanging = this.topicsChanging.then(() => this.retopicNow()).catch((e: Error) => this.o.log(`peers: topics: ${e.message}`));
    return this.topicsChanging;
  }

  private async retopicNow(): Promise<void> {
    const swarm = this.swarm;
    if (!swarm || this.closing) return;
    const want = new Map<string, { server: boolean; client: boolean }>();
    let next = (Math.floor(Date.now() / TOPIC_WEEK) + 1) * TOPIC_WEEK;
    if (!this.ws.secret) {
      if (this.o.joinAs) want.set(this.o.joinAs.topic, { server: false, client: true });
    } else {
      for (const t of topicsFor(this.ws.secret)) want.set(t.toString('hex'), { server: true, client: true });
      const origin = await this.identity.originSecret();
      if (origin) for (const t of topicsFor(origin)) want.set(t.toString('hex'), { server: true, client: true });
      if (!this.o.joining) {
        const links = await this.identity.linkTopics();
        for (const t of links.topics) if (!want.has(t)) want.set(t, { server: true, client: false });
        if (links.next && links.next < next) next = links.next;
      }
    }
    for (const [hex] of this.discoveries) {
      if (want.has(hex)) continue;
      this.discoveries.delete(hex);
      void swarm.leave(Buffer.from(hex, 'hex')).catch(() => undefined);
    }
    for (const [hex, o] of want) if (!this.discoveries.has(hex)) this.discoveries.set(hex, { d: swarm.join(Buffer.from(hex, 'hex'), o), client: o.client });
    // The local network's codes (lan.ts): the secret's, and each link's topic (a link's holder knows only that).
    const lanKeys = [...(this.ws.secret ? [lanKeyFor(this.ws.secret)] : []), ...[...want].filter(([, o]) => !o.client || !this.ws.secret).map(([hex]) => Buffer.from(hex, 'hex'))];
    const changed = lanKeys.map((k) => k.toString('hex')).join() !== this.lanKeys.map((k) => k.toString('hex')).join();
    this.lanKeys = lanKeys;
    if (changed) this.lan?.say(true);
    clearTimeout(this.topicTimer);
    this.topicTimer = setTimeout(() => void this.retopic(), Math.min(Math.max(next - Date.now(), 0) + 1000, 2 ** 31 - 1));
    this.topicTimer.unref();
  }

  /** The workspace's secret on file now (a record made it anew): the topics follow it. */
  private async secretChanged(): Promise<void> {
    const ws = await this.identity.workspace();
    if (!ws || ws.secret === this.ws.secret) return;
    this.ws = ws;
    this.o.log('peers: the workspace\'s secret was made anew; finding the devices by the new one');
    await this.retopic();
  }

  /**
   * Make the workspace's secret anew (Peers.removeDevice: a device removed knew
   * the old one) and go on by it; the members get it with the records, and a
   * removed device never does (membersChanged).
   */
  async newSecret(): Promise<void> {
    await this.identity.newSecret();
    await this.secretChanged();
  }

  /** The devices of this workspace connected here, let in. */
  private connectedHere(): PeerLink[] {
    return [...this.links.values()].filter((l) => l.accepted && l.hello?.workspace === this.ws.id);
  }

  /** Tell the devices connected here whom this one is connected to (soon, once for a burst of changes). */
  private tellPresence(): void {
    clearTimeout(this.presenceTimer);
    this.presenceTimer = setTimeout(() => {
      const here = this.connectedHere();
      for (const l of here) l.send({ type: 'present', keys: here.map((x) => x.key).filter((k) => k !== l.key) });
    }, 200);
    this.presenceTimer.unref();
  }

  /**
   * Members another device is connected to and this one is not: dialled, for a
   * while. Of the two, only the one with the lower key dials, so they do not
   * both spend the few tries a hard router allows at the same moment (each hears
   * of the other through the same device).
   */
  private async reach(): Promise<void> {
    const members = new Set((await this.identity.members()).map((m) => m.key));
    for (const l of this.connectedHere()) {
      for (const k of l.present) {
        if (!members.has(k) || this.myKey > k || this.live(k)) continue;
        this.dial(k);
        // Not reached directly in a while (both on hard networks, or one where the DHT cannot go): through a device that is.
        if (this.tunnelTimers.has(k)) continue;
        const t = setTimeout(() => {
          this.tunnelTimers.delete(k);
          const via = this.through(k)[0];
          if (via && !this.live(k)) this.tunnelTo(k, via);
        }, this.o.tunnelAfterMs ?? TUNNEL_AFTER_MS);
        t.unref();
        this.tunnelTimers.set(k, t);
      }
    }
  }

  /** Members not connected here that a device connected here says it is connected to. */
  through(key: string): PeerLink[] {
    return this.links.get(key)?.accepted ? [] : this.connectedHere().filter((l) => l.present.has(key));
  }

  /**
   * The relay to go through to a device that cannot be reached directly (relay.ts):
   * when the last try failed in a way a relay helps with (`force`), or always
   * when this computer's network is the kind that makes direct connections hard
   * (Hyperswarm tries directly too, and keeps whichever works). One of those the
   * members connected here offer, else one named in the settings; null if none.
   */
  private relayFor(force: boolean): Buffer | null {
    if (!force && !this.swarm?.dht.randomized) return null;
    const keys = this.relayCandidates();
    if (!keys.length) return null;
    return Buffer.from(keys[Math.floor(Math.random() * keys.length)]!, 'hex');
  }

  /**
   * Relays to go through, best first: those members with a public address offer
   * (anyone can reach them), else any members offer; else those named in the
   * settings, here or by a member (hello, relays).
   */
  private relayCandidates(): string[] {
    const mine = this.relay?.key;
    const offering = [...this.links.values()].filter((l) => l.accepted && l.hello?.workspace === this.ws.id && isRelayKey(l.hello.relay) && l.hello.relay !== mine);
    const open = offering.filter((l) => l.hello?.relayPublic).map((l) => l.hello!.relay!);
    if (open.length) return open;
    if (offering.length) return offering.map((l) => l.hello!.relay!);
    return [...new Set([...(this.o.relays ?? []), ...this.hints.relays])].filter(isRelayKey);
  }

  /** The relay this device offers members, if it does (a network where it is of use: not randomized). */
  get relayOffered(): string | null {
    return this.relay && !this.swarm?.dht.randomized ? this.relay.key : null;
  }

  /** Whether the relay offered is on a public address (no router in the way): the best kind. */
  get relayPublic(): boolean {
    return !!this.relayOffered && this.swarm?.dht.firewalled === false;
  }

  /** Where others reach this device over TCP, as said (with peerPort for a host given alone); null if nowhere. */
  get publicAddress(): string | null {
    const a = this.o.publicAddress?.trim();
    if (!a || !this.tcp) return null;
    return parseAddress(a) ? a : `${a}:${this.tcp.port}`;
  }

  /**
   * What an invite link made here says about reaching the workspace, besides
   * the DHT (identity.ts, hints): relays named (here or by members), and servers
   * that take TCP, this one's or members', as `key@host:port`. A device joining
   * from a network the DHT cannot cross, or both ends on hard networks, gets in
   * through them.
   */
  async linkHints(): Promise<{ relays: string[]; tcp: string[] }> {
    const tcp: string[] = [];
    if (this.publicAddress) tcp.push(`${this.myKey}@${this.publicAddress}`);
    const members = new Set((await this.identity.members()).map((m) => m.key));
    for (const [key, addresses] of Object.entries(this.hints.tcp)) if (members.has(key)) for (const a of addresses) tcp.push(`${key}@${a}`);
    return { relays: [...new Set([...(this.o.relays ?? []), ...this.hints.relays])].filter(isRelayKey).slice(0, 4), tcp: tcp.slice(0, 4) };
  }

  /** How a device is connected here, if it is. */
  via(key: string): Via | null {
    const link = this.links.get(key);
    if (!link?.accepted || link.closed) return null;
    return this.kinds.get(link.conn) ?? 'internet';
  }

  /** When a device was last connected here (ms since 1970), if ever (kept between runs). */
  lastSeen(key: string): number | null {
    return this.hints.seen[key] ?? null;
  }

  /**
   * What this computer's network is like, as far as connecting goes: open (a
   * public address), behind a router (connects directly), hard (a router that
   * changes ports: slow, or through a relay), or unreachable (the DHT cannot be
   * reached: UDP blocked, or no network; only the local network and servers
   * over TCP then).
   */
  network(): { kind: 'starting' | 'open' | 'router' | 'hard' | 'unreachable'; tcp: string | null; lan: boolean } {
    const dht = this.swarm?.dht as unknown as { online?: boolean; bootstrapped?: boolean; firewalled: boolean; randomized: boolean; toArray?(): unknown[] } | undefined;
    const tcp = this.publicAddress;
    const lan = !!this.lan;
    if (!dht) return { kind: 'starting', tcp, lan };
    if (dht.online === false || (dht.bootstrapped && !(dht.toArray?.().length ?? 1))) return { kind: 'unreachable', tcp, lan };
    if (!dht.bootstrapped) return { kind: 'starting', tcp, lan };
    return { kind: dht.randomized ? 'hard' : dht.firewalled ? 'router' : 'open', tcp, lan };
  }

  private get hintsFile(): string {
    return join(this.o.stateDir, 'hints.json');
  }

  private async readHints(): Promise<Hints> {
    try {
      const h = JSON.parse(await readFile(this.hintsFile, 'utf8')) as Partial<Hints>;
      return { tcp: h.tcp ?? {}, relays: h.relays ?? [], seen: h.seen ?? {} };
    } catch {
      return { tcp: {}, relays: [], seen: {} };
    }
  }

  /** Kept soon (once for a burst of changes). */
  private saveHints(): void {
    clearTimeout(this.hintsTimer);
    this.hintsTimer = setTimeout(() => void writeFile(this.hintsFile, JSON.stringify(this.hints), { mode: 0o600 }).catch(() => undefined), 1000);
    this.hintsTimer.unref();
  }

  /** What a member's hello says about reaching it: its servers' TCP addresses, relays named in its settings, its DHT node to start from. */
  private noteHints(key: string, h: Extract<ControlMessage, { type: 'hello' }>): void {
    const before = JSON.stringify([this.hints.tcp[key] ?? [], this.hints.relays]);
    // Said only to devices it is paired with: a hello without it says nothing either way.
    if (Array.isArray(h.tcp)) {
      const tcp = h.tcp.filter((a) => parseAddress(a)).slice(0, 4);
      if (tcp.length) this.hints.tcp[key] = tcp;
      else delete this.hints.tcp[key];
    }
    const relays = (Array.isArray(h.relays) ? h.relays : []).filter(isRelayKey);
    if (relays.length) this.hints.relays = [...new Set([...relays, ...this.hints.relays])].slice(0, 8);
    if (JSON.stringify([this.hints.tcp[key] ?? [], this.hints.relays]) !== before) this.saveHints();
    // A server's DHT node: started from, as from the bootstrap servers (and kept, dht.ts).
    const node = parseAddress(h.dht);
    if (node) (this.swarm?.dht as unknown as { addNode?(n: { host: string; port: number }): void } | undefined)?.addNode?.(node);
  }

  /**
   * Whether this computer is behind a router that changes its port for each
   * connection: connecting directly through one takes a few tries, one every
   * 20 s or so. Known once the network has been reached.
   */
  get slowNetwork(): boolean {
    return !!this.swarm?.dht.randomized;
  }

  /**
   * Joining is over (join.ts): go on as this workspace's device for good, for
   * its host, on the connections the join made. Starting again instead would
   * mean connecting to every device anew, which on a network that is slow to
   * connect through takes as long as the join did. Devices already let in are
   * told to `events` as if they had just been; those that said hello while this
   * device was being let in are answered now, as a member.
   */
  async becomeMember(o: MemberOptions, events: NodeEvents): Promise<void> {
    Object.assign(this.o, o, { joining: false, ticket: undefined });
    this.events = events;
    await this.syncPerson();
    // The members the join learned of: just paired, so dialled.
    for (const m of await this.identity.members()) this.dial(m.key);
    // How it merges, and the records, which the join's hello did not carry.
    await this.membersChanged();
    for (const link of [...this.links.values()]) {
      if (link.accepted) events.accepted?.(link);
      else if (link.hello) await this.hello(link, link.hello);
    }
    this.tellPresence();
    await this.retopic();
    this.lookAgain();
  }

  /**
   * This computer's person's key, if it keeps one (person.ts): read again when
   * its file changes, so a key made or imported while the host runs is used from
   * its next commit. Tests give theirs (NodeOptions.person).
   */
  async person(): Promise<Person | null> {
    if (this.o.person !== undefined) return this.o.person;
    const file = personFile();
    let stamp = '';
    try {
      const st = await stat(file);
      stamp = `${st.mtimeMs}:${st.size}`;
    } catch { /* none */ }
    if (this.personRead?.stamp !== stamp) this.personRead = { stamp, person: stamp ? await readPerson(file) : null };
    return this.personRead.person;
  }

  /** This computer's signing key, for its person (person.ts: made on first use, never copied; read each time, as importing an identity replaces it). Tests give theirs. */
  private signingKeyNow(): Promise<KeyPair> {
    return this.o.signing ? Promise.resolve(this.o.signing) : signingKey();
  }

  /**
   * Say in this workspace which key this device's commits are signed with (with
   * that key's signature) and, if this computer keeps its person's identity,
   * that the key is theirs and which of their keys they revoked (with their
   * signature): again when any of that changes. Whether anything was said.
   */
  private async syncPerson(): Promise<boolean> {
    const key = await this.signingKeyNow();
    const person = await this.person();
    let revokedStamp = '';
    try {
      const st = await stat(revokedFile());
      revokedStamp = `${st.mtimeMs}:${st.size}`;
    } catch { /* none */ }
    const said = `${key.publicKey.toString('hex')}:${person ? `${person.publicKey.toString('hex')}:${person.name}` : ''}:${revokedStamp}`;
    if (said === this.saidFor) return false;
    await this.identity.signsWith(key);
    if (person) {
      await this.identity.vouch(person, key);
      const p = person.publicKey.toString('hex');
      for (const r of await revokedKeys()) await this.identity.revokeKey(p, r.key, r.proof);
    }
    this.saidFor = said;
    return true;
  }

  /**
   * The key the commits made here are signed with (0035): this computer's
   * signing key for its person, vouched for by their identity if this computer
   * keeps it. A host is one person, whoever edits through it.
   */
  async signingKey(): Promise<KeyPair> {
    if (await this.syncPerson()) void this.membersChanged().catch(() => undefined);
    return this.signingKeyNow();
  }

  /** Read the removed devices again (after a change), and tell git which keys sign for which devices. */
  async refresh(): Promise<void> {
    this.removedKeys = new Set(await this.identity.removed());
    // The keys commits here are signed with, named by their person (or device), as git checks them.
    const signers: { name: string; key: string }[] = [];
    for (const d of [{ key: this.myKey, name: this.name }, ...(await this.identity.members())]) {
      const key = await this.identity.signingKeyOf(d.key);
      if (key) signers.push({ name: (await this.identity.personOf(key))?.name || d.name, key });
    }
    await writeAllowedSigners(this.o.git, join(this.o.stateDir, 'allowed_signers'), signers).catch((e: Error) => this.o.log(`peers: allowed signers: ${e.message}`));
  }

  /** Pair with a device this one lets in (by an invite link), on record so the others pair with it too. */
  private async admit(key: string, name: string): Promise<string | null> {
    if ((await this.identity.removed()).includes(key)) return null;
    await this.identity.decide('add', key, { name });
    return (await this.identity.members()).find((m) => m.key === key)?.name ?? null;
  }

  /**
   * Whether to turn a device away before it says anything: a removed one. Only
   * devices that know the workspace's secret find it at all; any other device
   * not paired is turned away after its hello, unless it brings an invite link.
   */
  private refuse(key: string): boolean {
    return this.closing || this.removedKeys.has(key);
  }

  private connected(conn: SwarmConnection): void {
    const key = conn.remotePublicKey.toString('hex');
    this.links.get(key)?.close();
    const link: PeerLink = new PeerLink(conn, () => {
      if (this.links.get(key) === link) this.links.delete(key);
      if (!link.accepted || this.closing) return;
      this.hints.seen[key] = Date.now();
      this.saveHints();
      this.events.closed?.(link);
      // Gone: the others hear it, and the workspace is looked up again on the schedule from its start.
      this.tellPresence();
      this.lookAgain();
    });
    this.links.set(key, link);
    // One message at a time, in the order sent: a room message never overtakes the hello before it.
    let inbox = Promise.resolve();
    link.onMessage((m) => {
      inbox = inbox.then(() => this.message(link, m)).catch((e: Error) => this.o.log(`peers: ${e.message}`));
    });
    link.onGit((service, protocol, stream) => this.serveGit(link, service, protocol, stream));
    link.onTunnel((ask, stream) => this.tunnelAsked(link, ask, stream));
    // This device's hello goes first: nothing it says on this link (room messages, once it has let the
    // other in) may reach the other before it, or the other, not having let this one in yet, would drop it.
    link.said = this.helloFor(link).then((h) => link.send(h), (e: Error) => this.o.log(`peers: ${e.message}`));
  }

  private async helloFor(link: PeerLink): Promise<ControlMessage> {
    const shown = await this.linkToShow();
    const paired = link.accepted || (await this.identity.members()).some((m) => m.key === link.key);
    return {
      type: 'hello',
      protocol: PROTOCOL,
      workspace: this.ws.id,
      forkedFrom: this.ws.forkedFrom,
      name: this.name,
      // Which records it holds (who is in, and who people are), as a hash: a device that holds
      // others asks for what it lacks (want). Nothing for a device not known yet (it may never be let in).
      digest: paired ? digestOf(await this.identity.records()) : '',
      merges: this.o.merges ?? '',
      heads: await this.heads(),
      ...(paired ? { outputs: await outputRefs(this.o.git) } : {}),
      // For members only: how to reach this device besides the DHT (a device not known yet learns
      // nothing of it): the relay it offers and whether it is on a public address, the relays named in
      // its settings, where it takes TCP (a server), and its DHT node to start from.
      ...(paired && this.relayOffered ? { relay: this.relayOffered, relayPublic: this.relayPublic } : {}),
      ...(paired && this.o.relays?.length ? { relays: this.o.relays.filter(isRelayKey).slice(0, 4) } : {}),
      ...(paired ? { tcp: this.publicAddress ? [this.publicAddress] : [] } : {}),
      ...(paired && this.dhtAddress ? { dht: this.dhtAddress } : {}),
      // A device that came in by a link shows it to devices that may not know it yet.
      ...(shown ? { link: shown } : {}),
    };
  }

  /** This device's branches: name → commit. */
  async heads(): Promise<Record<string, string>> {
    const out = await this.o.git.out(['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads/']);
    const heads: Record<string, string> = {};
    for (const line of out.split('\n').filter(Boolean)) {
      const [ref, oid] = line.split('\0');
      heads[ref!.slice('refs/heads/'.length)] = oid!;
    }
    return heads;
  }

  private async linkToShow(): Promise<string | null> {
    return this.o.ticket ?? this.identity.joinedLink();
  }

  /** Why an invite link does not let a device in here, or null if it does. */
  private async refuseLink(code: string): Promise<string | null> {
    let l;
    try {
      l = decodeLink(code);
    } catch (e) {
      return (e as Error).message;
    }
    // Any member's links (0038).
    const members = [this.myKey, ...(await this.identity.members()).map((m) => m.key)];
    return checkLink(l, { workspace: this.ws.id, members, revoked: await this.identity.revokedLinks() });
  }

  /**
   * Whether a device merges differently from this one (another version of
   * kuraa, or other document types): only one of the two may then make the
   * merges between them. Unknown until it has said hello.
   */
  mergesDiffer(key: string): boolean {
    const hello = this.links.get(key)?.hello;
    return !!hello && hello.merges !== (this.o.merges ?? '');
  }

  private async message(link: PeerLink, m: ControlMessage): Promise<void> {
    await link.said;
    if (m.type === 'hello') return this.hello(link, m);
    if (m.type === 'welcome') return this.welcomed(link, m);
    if (!link.accepted) return;
    if (m.type === 'refs') {
      link.heads = readHeads(m.heads);
      link.outputs = readOutputs(m.outputs);
      this.events.refs?.(link);
    }
    else if (m.type === 'room') this.events.room?.(link, m);
    else if (m.type === 'outputs') {
      if (link.hello?.workspace === this.ws.id) this.events.outputs?.(link, m.frame);
    }
    else if (m.type === 'records') {
      if (link.hello?.workspace === this.ws.id && Array.isArray(m.records)) await this.takeRecords(link, m.records);
    }
    else if (m.type === 'want') {
      if (link.hello?.workspace === this.ws.id && Array.isArray(m.have)) await this.answerWant(link, m.have);
    }
    else if (m.type === 'also') {
      if (Array.isArray(m.entries)) this.heardAlso(link, m.entries);
    }
    else if (m.type === 'present') {
      link.present = new Set((Array.isArray(m.keys) ? m.keys : []).filter((k): k is string => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)));
      await this.reach();
    }
    else if (m.type === 'bye') {
      this.o.log(`peers: ${link.remote ?? link.key.slice(0, 8)} left: ${m.reason}`);
      this.events.refused?.(link, String(m.reason));
      link.close();
    }
  }

  private async hello(link: PeerLink, h: Extract<ControlMessage, { type: 'hello' }>): Promise<void> {
    // Another version of what devices say: no syncing, and each says why (an older device, which
    // does not know of this, sees only that it was turned away). The newer one's kuraa is the one to have.
    const theirs = typeof h.protocol === 'number' && Number.isInteger(h.protocol) ? h.protocol : 1;
    if (theirs !== PROTOCOL) {
      const known = this.versions.get(link.key);
      this.versions.set(link.key, theirs);
      if (known !== theirs) this.o.log(`peers: ${h.name} (${link.key.slice(0, 8)}…) runs ${theirs > PROTOCOL ? 'a newer' : 'an older'} kuraa; the two do not sync until ${theirs > PROTOCOL ? 'this one is' : 'it is'} updated`);
      if (theirs > PROTOCOL) versionNews.emit('newer');
      link.send({ type: 'bye', reason: theirs > PROTOCOL ? 'this device runs an older kuraa: update it to sync' : 'the other device runs an older kuraa: update that one to sync' });
      setTimeout(() => link.close(), 100);
      return;
    }
    this.versions.delete(link.key);
    // Again, from a device already accepted: what it now knows of the members.
    if (link.accepted) {
      link.hello = h;
      link.heads = readHeads(h.heads);
      link.outputs = readOutputs(h.outputs);
      if (h.workspace === this.ws.id) this.noteHints(link.key, h);
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
    if (!member && this.o.joining) {
      // Joining: a device of the workspace may let this one in; it is paired with
      // once its welcome shows the link's maker vouches for it (welcomed).
      if (same && this.o.ticket) {
        link.hello = h;
        return;
      }
      return bye('not paired with this device');
    }
    if (!member) {
      if (!same || typeof h.link !== 'string') return bye('not paired with this device');
      const why = await this.refuseLink(h.link);
      if (why) return bye(`not paired with this device, and ${why}`);
      const l = decodeLink(h.link);
      const name = await this.admit(link.key, h.name);
      if (!name) return bye('this device was removed from the workspace');
      // A link for one person lets one device in: used up, on record, so no other device lets anyone else in by it.
      if (l.once) await this.identity.useLink(l.id);
      const how = `by invite link ${l.id}${l.once ? ', now used' : ''}`;
      member = { key: link.key, name };
      await this.refresh();
      this.o.log(`peers: paired with ${name} (${link.key.slice(0, 8)}…), ${how}`);
      const members = (await this.identity.members()).filter((x) => x.key !== link.key);
      // With the workspace's secret, which the link no longer carries (0050).
      link.send({ type: 'welcome', name: this.name, members: members.map((x) => ({ key: x.key, name: x.name })), branch: await this.o.branch(), records: await this.identity.records(), secret: this.ws.secret });
      // Not waited for, and so caught: it may still be going when this device closes (its folder gone, say).
      void this.membersChanged(link).catch((e: Error) => this.logUnlessClosing(e));
    }
    link.accepted = true;
    link.remote = member.name;
    link.hello = h;
    link.heads = readHeads(h.heads);
    link.outputs = readOutputs(h.outputs);
    if (same) await this.gossip(link, h);
    if (same) this.noteHints(link.key, h);
    this.hints.seen[link.key] = Date.now();
    this.events.accepted?.(link);
    this.tellPresence();
    this.sayAlso(link);
  }

  /**
   * A device let this one in (joining). The link's maker is paired already.
   * Any other must show, by the records it sends, that
   * the link's maker vouches for it (traced from the maker and the devices it
   * came in through, as the link says, signed): someone who only knows the
   * workspace's secret, from an old link, say, does not get to be the device
   * this one starts from. Then its records are taken, and the members it names
   * that are vouched for in the same way.
   */
  private async welcomed(link: PeerLink, m: Extract<ControlMessage, { type: 'welcome' }>): Promise<void> {
    if (!this.o.joining) return;
    const records = Array.isArray(m.records) ? m.records : [];
    let members = Array.isArray(m.members) ? m.members : [];
    if (!link.accepted) {
      const t = this.o.ticket;
      if (!t || !link.hello || link.hello.workspace !== this.ws.id) return;
      const l = decodeLink(t);
      const known = traced([l.issuer.key, ...l.through], records, this.ws.id);
      if (!known.has(link.key)) {
        this.o.log(`peers: ${link.hello.name} (${link.key.slice(0, 8)}…) offered to let this device in, but the link's maker does not vouch for it; not joining through it`);
        link.close();
        return;
      }
      const name = await this.identity.addMember(link.key, link.hello.name);
      if (!name) return;
      link.accepted = true;
      link.remote = name;
      members = members.filter((x) => known.has(x.key));
      this.tellPresence();
    }
    // The workspace's secret, from the device that let this one in (the link did not carry it, 0050).
    if (!this.ws.secret) {
      const secret = typeof m.secret === 'string' && /^[0-9a-f]{32,128}$/.test(m.secret) ? m.secret : null;
      if (!secret) {
        this.o.log(`peers: ${link.hello?.name ?? link.key.slice(0, 8)} let this device in without the workspace's secret; not joining through it`);
        link.close();
        return;
      }
      await this.identity.adopt({ id: this.ws.id, secret, forkedFrom: this.ws.forkedFrom });
      this.ws = { ...this.ws, secret };
      void this.retopic();
    }
    await this.takeRecords(link, records);
    this.events.welcome?.(link, { ...m, members });
  }

  /**
   * A member said which records it holds (as a hash): if they are not the ones
   * this device holds, ask for what this one lacks, saying what it has (want).
   */
  private async gossip(link: PeerLink, h: Extract<ControlMessage, { type: 'hello' }>): Promise<void> {
    const mine = await this.identity.records();
    if (typeof h.digest === 'string' && h.digest !== digestOf(mine)) link.send({ type: 'want', have: mine.map((r) => shortSig(r.sig)) });
  }

  /**
   * A member asked for the records it lacks: send them. If it has some this one
   * lacks, ask for those in turn.
   */
  private async answerWant(link: PeerLink, have: unknown[]): Promise<void> {
    const theirs = new Set(have.filter((x): x is string => typeof x === 'string'));
    const mine = await this.identity.records();
    const lacking = forDevice(mine.filter((r) => !theirs.has(shortSig(r.sig))), link.key, new Set(await this.identity.removed()));
    if (lacking.length) link.send({ type: 'records', records: lacking });
    const known = new Set(mine.map((r) => shortSig(r.sig)));
    if ([...theirs].some((x) => !known.has(x))) link.send({ type: 'want', have: [...known] });
  }

  /** Signed records (records.ts): each taken if its signer may make it, whoever passed it on. */
  private async takeRecords(link: PeerLink, records: unknown[]): Promise<void> {
    const taken = await this.identity.takeRecords(records);
    if (!taken.length) return;
    if (taken.some((r) => r.kind === 'remove' && r.subject === this.myKey)) {
      this.o.log('peers: this device was removed from the workspace; not syncing');
      await this.close();
      return;
    }
    for (const r of taken) {
      const who = (await this.identity.members()).find((m) => m.key === r.by)?.name ?? (r.by === this.myKey ? 'this device' : `${r.by.slice(0, 8)}…`);
      if (r.kind === 'add') {
        if (r.subject === this.myKey) continue;
        this.o.log(`peers: ${who} paired ${r.name ?? 'a device'} (${r.subject.slice(0, 8)}…)`);
        this.dial(r.subject);
      } else if (r.kind === 'remove') {
        this.links.get(r.subject)?.close();
        this.o.log(`peers: ${who} removed ${r.subject.slice(0, 8)}…`);
      } else if (r.kind === 'revoke-link') this.o.log(`peers: ${who} ${r.name === 'used' ? 'let someone in by' : 'revoked'} invite link ${r.subject}`);
      else if (r.kind === 'link') this.o.log(`peers: ${who} made invite link ${r.subject}`);
      else if (r.kind === 'secret') this.o.log(`peers: ${who} made the workspace's secret anew`);
      else this.o.log(`peers: ${who} acts for ${r.name ?? 'someone'}`);
    }
    if (taken.some((r) => r.kind === 'secret')) await this.secretChanged();
    await this.membersChanged(link);
  }

  /**
   * The members changed: tell the other devices (not `except`, which told this
   * one): the records taken or made here since this device last told them, and
   * a new hello (which says which records this device holds, so a device still
   * missing one asks for it).
   */
  async membersChanged(except?: PeerLink): Promise<void> {
    await this.refresh();
    // Links made, revoked or used: announced, or no longer.
    await this.retopic();
    const all = await this.identity.records();
    const fresh = all.filter((r) => !this.told.has(r.sig));
    for (const r of fresh) this.told.add(r.sig);
    const removed = new Set(await this.identity.removed());
    for (const l of this.links.values()) {
      if (!l.accepted || l === except) continue;
      const records = forDevice(fresh, l.key, removed);
      if (records.length && l.hello?.workspace === this.ws.id) l.send({ type: 'records', records });
      l.send(await this.helloFor(l));
    }
    this.events.members?.();
  }

  /** Let a paired device fetch: `git upload-pack`, nothing that writes. */
  private serveGit(link: PeerLink, service: string, protocol: string, stream: Duplex): void {
    if (!link.accepted || service !== 'git-upload-pack') return void stream.destroy();
    const child = spawnGit(['upload-pack', '--strict', '--timeout=600', join(this.o.dir, '.git')], {
      env: gitEnv(protocol ? { GIT_PROTOCOL: protocol } : {}),
      detached: false,
    });
    child.stderr.resume();
    stream.pipe(child.stdin);
    child.stdout.pipe(stream);
    child.on('error', () => stream.destroy());
    stream.on('error', () => child.kill());
    stream.on('close', () => child.kill());
  }

  private readonly fetches = new Map<string, Promise<boolean>>();

  /** Fetch a paired device's branches into `<its remote>/…`, one fetch per device at a time. Returns whether it worked. */
  fetch(remote: string): Promise<boolean> {
    return this.queueFetch(remote, `+refs/heads/*:refs/remotes/${remote}/*`);
  }

  /**
   * Fetch the run outputs a paired device has (outputs.ts): not branches, and
   * going nowhere else. In a queue of their own, beside its branches' (0062):
   * other refs, so the two never touch the same ones.
   */
  fetchOutputs(remote: string): Promise<boolean> {
    return this.queueFetch(remote, outputsRefspec(remote));
  }

  private queueFetch(remote: string, refspec: string): Promise<boolean> {
    const queue = `${remote}\0${refspec}`;
    const before = this.fetches.get(queue) ?? Promise.resolve(true);
    const run = before.catch(() => false).then(() => this.fetchNow(remote, refspec));
    this.fetches.set(queue, run);
    // Its failure is the caller's to handle (run is returned): not this bookkeeping's, which would leave it unhandled.
    const forget = () => {
      if (this.fetches.get(queue) === run) this.fetches.delete(queue);
    };
    void run.then(forget, forget);
    return run;
  }

  private async fetchNow(remote: string, refspec: string): Promise<boolean> {
    if (this.closing) return false;
    const r = await this.o.git.run([
      '-c', `core.hooksPath=${devNull}`, '-c', 'fetch.recurseSubmodules=false', '-c', 'protocol.version=2',
      'fetch', '--prune', '--no-write-fetch-head', remote, refspec,
    ], { allowFail: true, timeoutMs: 10 * 60_000, env: { PATH: gitPath(this.bridge.binDir) } });
    if (r.code !== 0 && !this.closing) this.o.log(`peers: fetching from ${remote} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.code === 0;
  }

  /** Something that went wrong in the background, logged; not once this device is closing (what it worked on may be gone). */
  private logUnlessClosing(e: Error): void {
    if (!this.closing) this.o.log(`peers: ${e.message}`);
  }

  /** Tell every connected device something. */
  broadcast(m: ControlMessage): void {
    for (const link of this.links.values()) if (link.accepted) link.send(m);
  }

  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    clearTimeout(this.lookupTimer);
    clearTimeout(this.presenceTimer);
    clearTimeout(this.topicTimer);
    for (const t of this.tunnelTimers.values()) clearTimeout(t);
    if (this.key && localNodes(this.computer).get(this.myKey) === this) localNodes(this.computer).delete(this.myKey);
    this.lan?.leave();
    this.tcp?.stop();
    if (this.hintsTimer) {
      clearTimeout(this.hintsTimer);
      await writeFile(this.hintsFile, JSON.stringify(this.hints), { mode: 0o600 }).catch(() => undefined);
    }
    for (const t of this.dialling.values()) clearTimeout(t);
    for (const link of this.links.values()) link.close();
    await this.relay?.close();
    await this.swarm?.destroy();
    await this.bridge.close();
  }
}
