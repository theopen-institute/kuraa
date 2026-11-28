// This device among the workspace's devices: finding them (Hyperswarm, by the
// workspace's topic), checking who they are, pairing new ones by invite link,
// sharing who the members are, and letting paired devices fetch from it.
//
// Who is let in: a device in the workspace (0072: one whose person the policy
// has in it, its key vouched for by them and neither dropped nor revoked), and,
// for as long as it is connected, a device that presents an invite link a
// member made (any member checks it). It is in for good once its person's join,
// with an admin's grant, is in the policy. A device joining is let in only by
// the link's maker, or by a device the records it is sent show to be in, under
// the genesis the link names. See docs/decisions/0028-peers.md and 0072.
import { createHash } from 'node:crypto';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { writeAllowedSigners } from '../signing.js';
import type { Policy } from './policy.js';
import { SPACES } from '../spaces.js';
import crypto from 'hypercore-crypto';
import { createPerson, personFile, readPerson, revokedFile, revokedKeys, signingKey, type Person } from './person.js';
import type { KeyPair } from '../keys.js';
import { stat, statfs } from 'node:fs/promises';
import { pipeline, type Duplex } from 'node:stream';
import Hyperswarm, { type Discovery, type SwarmConnection } from 'hyperswarm';
import { gitEnv, gitPath, spawnGit, type Git } from '../git.js';
import { GitBridge } from './bridge.js';
import { useDht } from './dht.js';
import { isRelayKey, useRelay, type Relay } from './relay.js';
import { Identity, MAX_PROOF, TOPIC_WEEK, checkLink, decodeLink, lanKeyFor, linkProofFor, linkProven, topicsFor, withoutSecret, type Member, type WorkspaceIdentity } from './identity.js';
import { joinLan } from './lan.js';
import NoiseSecretStream from '@hyperswarm/secret-stream';
import type { Socket } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { createHmac } from 'node:crypto';
import { addressGroup, dialTcp, listenTcp, parseAddress } from './tcp.js';
import { recordKey, revokeKeyMessage, shortKey, type MemberRecord } from './records.js';
import { outputRefs, outputsRefspec } from './outputs.js';
import { EventEmitter } from 'node:events';
import { compareVersions, isVersion } from '../selfupdate.js';
import { MIN_PROTOCOL, PROTOCOL, PeerLink, protocolsMeet, readHeads, readOutputs, type ControlMessage, type OutputsFrame, type TunnelAsk } from './link.js';

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
  /** How many connections the swarm keeps (Hyperswarm's maxPeers; 64 by default): more for a server (0112). */
  maxPeers?: number;
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
/** Where another device's spaces are fetched to: `<remote>/<id>/heads/<branch>` (0066). */
export const PEER_SPACES = 'refs/kuraa/peer-spaces/';

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
 * last, the last goes on (0071), for as long as anyone is missing: Hyperswarm's
 * own lookup every ten minutes does nothing for a device that reaches its
 * members only over TCP, nor for one whose members' topics changed meanwhile.
 */
const LOOKUPS_MS = [15_000, 60_000, 120_000, 240_000, 480_000];

/** How long a device let in by an invite link is let in again, connecting anew, before its join comes (0072). */
const LET_IN_MS = 10 * 60_000;

/** How long a device that connected may take to be let in (its hello, an invite link) before its link is closed (0071). */
const HELLO_MS = 60_000;

/** Where a connection is from, as limits count it (tcp.ts, addressGroup); '' where it cannot be said (0115). */
function addressOf(conn: unknown): string {
  const raw = (conn as { rawStream?: { remoteHost?: string; remoteAddress?: string } }).rawStream;
  const addr = raw?.remoteHost ?? raw?.remoteAddress ?? '';
  return addr ? addressGroup(addr) : '';
}

/**
 * What another device said, fit to log or show (0112): a string, no control
 * characters (no new lines, no terminal escapes, so no forged log lines), and
 * not long.
 */
export function saidByPeer(x: unknown, max = 200): string {
  const s = String(x ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ');
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
/** On a server, whose port anyone reaches (0112): a stranger's time to be let in, and how many may wait at once. */
const SERVER_HELLO_MS = 15_000;
const MAX_UNACCEPTED = 64;
/** Space a fetch leaves on the disk (0112): below it, a device's work is not fetched until there is more. */
const MIN_FREE_BYTES = 1024 ** 3;
/** Below this room, fetches go one at a time in the process (0115). */
const LOW_FREE_BYTES = 10 * 1024 ** 3;
/** The most one fetch brings, but a server's first copy (2 GiB). */
const DEFAULT_FETCH_BYTES = 2 * 1024 ** 3;
/** The fetch whose turn it is, while room is short (0115). */
let fetchTurn: Promise<void> = Promise.resolve();

/** On the local network, how long the device with the higher key waits for the lower to connect before it does (0071: the lower one's firewall may refuse). */
const LAN_FALLBACK_MS = 5_000;

/** The most devices of another kuraa version remembered (versions), so one that keeps connecting cannot grow it. */
const MAX_VERSIONS = 256;

/**
 * What `git upload-pack` serving a device runs with (0071): the refs it may not
 * fetch hidden, and fetching by id refused however git is configured here. It
 * runs without GIT_PROTOCOL (uploadPackEnv), so it speaks protocol v0 whatever
 * the device asks for: in v2, upload-pack takes a want for any object it holds,
 * shown or not, so a device that learned a hidden commit's id could fetch it;
 * in v0 it takes wants only for what it showed. Left as it is: git answers a
 * device's `have` for any object held here (ACK), shown or not, so a device in
 * can learn whether a commit whose id it already knows is here, though not
 * fetch it. Closing that needs serving each device from objects of its own.
 */
export function uploadPackArgs(hidden: string[]): string[] {
  return [
    ...hidden.flatMap((h) => ['-c', `transfer.hideRefs=${h}`]),
    '-c', 'uploadpack.allowAnySHA1InWant=false',
    '-c', 'uploadpack.allowReachableSHA1InWant=false',
    '-c', 'uploadpack.allowTipSHA1InWant=false',
  ];
}

/** The environment `git upload-pack` serving a device runs in: never with a GIT_PROTOCOL, the device's or this process's (uploadPackArgs). */
export function uploadPackEnv(): NodeJS.ProcessEnv {
  const env = gitEnv({});
  for (const k of Object.keys(env)) if (k.toUpperCase() === 'GIT_PROTOCOL') delete env[k];
  return env;
}

/**
 * News for whoever runs this process (the desktop app updates itself on it):
 * 'newer', when a device of a workspace speaks a newer protocol than this one
 * (PROTOCOL), so this kuraa is out of date.
 */
export const versionNews = new EventEmitter();

/** The version of kuraa this process runs, as released (setKuraaVersion); null: not a release (pnpm dev, tests). */
let ownVersion: string | null = null;

/**
 * Say which version of kuraa this is (the desktop app's, a release's: 0099), in
 * hellos: a device that runs an older one then knows a newer one is out. Not a
 * version (`dev`), said not.
 */
export function setKuraaVersion(version: string | null): void {
  ownVersion = version && isVersion(version) ? version : null;
}

/** A device not seen for this long is away: dialled every AWAY_DIAL_MS at most (lookup). */
const DAY_MS = 24 * 3600_000;
const AWAY_DIAL_MS = 6 * 3600_000;

/** How many of a computer's other workspaces it says it is in, at most (0053, 0099: a server holds many). */
const MAX_ALSO = 1024;

/** When a newer release, or protocol, was last told of (versionNews): once an hour at most, whatever devices say. */
let releaseToldAt = 0;
let protocolToldAt = 0;
const NEWS_MS = 3600_000;

/** Which records a device holds, as one hash: the same records, the same hash, in any order (by what each says, recordKey: 0071). */
export function digestOf(records: MemberRecord[]): string {
  return createHash('sha256').update([...new Set(records.map(recordKey))].sort().join('\n')).digest('hex');
}

/** The most records taken from one message, and the most said to be held in a want (0071): a member cannot make every device do unbounded work. */
const MAX_RECORDS = 5000;
const MAX_HAVE = 100_000;

/** How often a device not known to be in has the records it shows weighed, at most, and how many devices' a minute (node.ts, mayWeigh). */
const PROOF_EACH_MS = 1_000;
const PROOF_PER_MINUTE = 60;

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
  /** The answer of the device that let this one in, when joining; `fromServer`: a server's (0099), its copy to be checked. */
  welcome?(link: PeerLink, m: Extract<ControlMessage, { type: 'welcome' }>, fromServer?: boolean): void;
  /** The members changed (a device paired or removed). */
  members?(): void;
  /** A device turned this one away, saying why. */
  refused?(link: PeerLink, reason: string): void;
  /** Joining, this device is out of the workspace even with its own join counted: why (0099). */
  out?(why: string): void;
  /** A device does not hold these policy operations, asked for as its commits name them (gate.ts). */
  unheld?(link: PeerLink, ids: string[]): void;
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
  /** The relay this device offers the other members (relay.ts): the process's, shared by its workspaces. */
  private relay: Relay | null = null;
  private releaseRelay: (() => Promise<void>) | null = null;
  /** On the local network: devices with a lower key heard of, to connect to if they do not (lanFound). */
  private readonly lanLater = new Map<string, NodeJS.Timeout>();
  /** Tunnels between two computers' devices over a link they have for another workspace (also): kept, as a direct link is (keepsOwn). */
  private readonly alsoStreams = new WeakSet<object>();
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
    this.maxFetchBytes = o.maxFetchBytes ?? DEFAULT_FETCH_BYTES;
    this.bridge = new GitBridge({
      stateDir: o.stateDir,
      // As much as it may, but never past the room on the disk less what is kept free (0115).
      maxBytes: () => Math.max(0, Math.min(this.maxFetchBytes, this.freeBytes - MIN_FREE_BYTES)),
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
    // Whose this device is: said in this workspace, with their signature. A computer with no identity yet is given one (0066).
    await this.ensurePerson();
    await this.syncPerson();
    // The policy written down, if there is none: a workspace made now has its own genesis; one this
    // device was in from before, everyone an admin. A device joining writes none: it takes the workspace's.
    if (!ws && found && !joinAs) await this.ensureGenesis(true);
    else if (ws && !this.o.joining) await this.ensureGenesis(false);
    // Links this device revoked, or made and expired, unlinked in the policy, where their grants could still let someone in.
    if (ws && !this.o.joining) await this.identity.unlinkStale(await this.signingKeyNow()).catch((e: Error) => this.o.log(`peers: could not unlink old invite links: ${e.message}`));
    // What the records say, applied, in case a record was kept and this device stopped before applying it.
    await this.identity.reconcile();
    for (const r of await this.identity.records()) this.told.add(r.sig);
    await this.refresh();
    await this.bridge.start();
    this.hints = await this.readHints();
    if (this.closing) return;
    localNodes(this.computer).set(this.myKey, this);
    // The process's DHT node, shared with every other workspace's swarm (dht.ts); this workspace's own key.
    const dhtOptions = { port: this.o.dhtPort, ephemeral: this.o.serveDht === false ? true : undefined };
    const dht = await useDht(this.o.bootstrap?.map(bootstrapNode), dhtOptions);
    // A fixed port asked for and taken by something else: the DHT node is on another, which members told of the one
    // asked for will not find (0099). Said, so whoever runs it can see why.
    const on = (dht as unknown as { address?: () => { port?: number } | null }).address?.()?.port;
    if (this.o.dhtPort && on && on !== this.o.dhtPort) this.o.log(`peers: UDP port ${this.o.dhtPort} is taken by something else: the DHT node is on ${on} instead`);
    // Closed meanwhile: close() found no swarm to destroy, so this lets go of the node.
    if (this.closing) return void (await dht.destroy());
    this.swarm = new Hyperswarm({
      keyPair: this.key,
      dht,
      // A device connected on the local network or over TCP is not connected to again through the DHT.
      // Hyperswarm bans whomever this refuses, for good: a device let go of when its link closes (unban).
      firewall: (remote) => {
        const key = remote.toString('hex');
        return this.refuse(key) || this.keepsOwn(key) || this.o.direct?.(key) === false;
      },
      relayThrough: (force) => this.relayFor(force),
      // A server connects to every member of a workspace, and strangers can connect to it (0112): more than the 64 a
      // device's swarm keeps, so connections no one lets in yet do not stop it reaching members.
      ...(this.o.maxPeers ? { maxPeers: this.o.maxPeers } : {}),
    });
    if (this.o.offerRelay !== false) {
      // Offered once it is up, never waited for: on a network that blocks the DHT (a school's, say) it takes
      // minutes to give up, and the workspace (and the app's window) would wait as long to open.
      void useRelay(this.o.bootstrap?.map(bootstrapNode), dhtOptions).then(async (r) => {
        if (this.closing) await r.release();
        else {
          this.relay = r.relay;
          this.releaseRelay = r.release;
        }
      }, (e: Error) => this.o.log(`peers: no relay offered: ${e.message}`));
    }
    if (this.closing) return;
    this.swarm.on('connection', (conn) => this.connected(conn));
    // Just started: this device dials the others, found by the topic and directly (the others do not
    // know it is back). Hyperswarm looks the topic up again when the network changes; so does this, on its schedule.
    // The members, and, for a fork, the devices of the workspace it came from (0072).
    for (const m of await this.identity.devicesToMeet()) this.dial(m.key);
    for (const k of joinAs?.dial ?? []) this.dial(k);
    await this.retopic();
    if (this.o.lan !== false || this.o.peerPort) await this.startTcp();
    if (this.closing) return;
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
    if (this.closing || !delays.length) return;
    // After the last, the last again: lookup stops the schedule once no one is missing.
    const ms = delays[Math.min(this.lookupStep++, delays.length - 1)]!;
    this.lookupTimer = setTimeout(() => void this.lookup().catch((e: Error) => this.o.log(`peers: looking for the workspace's devices: ${e.message}`)), ms + Math.random() * (ms / 4));
    this.lookupTimer.unref();
  }

  /**
   * One lookup of the workspace's topics (Hyperswarm dials whom it finds), while
   * anyone is missing; the schedule stops once no one is. The members missing
   * are dialled too, by key (0071): if the workspace's secret was made anew while
   * some were away, those and the others are on different topics, and only
   * dialling brings them together again. Members reached only through another
   * device are tunnelled to again (reach).
   */
  private async lookup(): Promise<void> {
    if (this.closing || !(await this.missing())) return;
    // A device not seen for a day (or never: one left by a join that did not finish) is dialled every six hours at
    // most, not at every look (0099: a server's members are laptops, mostly away, and it held hundreds of such).
    const now = Date.now();
    for (const m of await this.identity.members()) {
      if (this.links.get(m.key)?.accepted) continue;
      // Never seen here: away once it has been missing a day (a device that joined a moment ago is not).
      if (!this.missingSince.has(m.key)) this.missingSince.set(m.key, now);
      const seen = this.hints.seen[m.key] ?? this.missingSince.get(m.key)!;
      if (now - seen > DAY_MS && now - (this.dialledAway.get(m.key) ?? 0) < AWAY_DIAL_MS) continue;
      if (now - seen > DAY_MS) this.dialledAway.set(m.key, now);
      this.dial(m.key);
    }
    await this.dialKnown();
    this.lan?.say(true);
    await this.reach();
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
    this.tcp = await listenTcp(this.myKey, this.o.peerPort, (sock, settled) => this.tcpAccept(sock, settled), (m) => this.o.log(m));
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

  /** Whether a device has a link here that is not to be replaced by one through the DHT: on the local network, over TCP, or through a link between the two computers (also). */
  private keepsOwn(key: string): boolean {
    const link = this.links.get(key);
    if (!link || link.closed) return false;
    const kind = this.kinds.get(link.conn);
    return kind === 'lan' || kind === 'tcp' || this.alsoStreams.has(link.conn);
  }

  /** Let Hyperswarm connect to a device again: it bans whomever the firewall refused while a link of this layer's own was open (0071). */
  private unban(key: string): void {
    if (this.refuse(key)) return;
    (this.swarm as unknown as { peers?: Map<string, { ban(v: boolean): void }> } | null)?.peers?.get(key)?.ban(false);
  }

  /** A link to the device, not closed. */
  private live(key: string): boolean {
    const link = this.links.get(key);
    return !!link && !link.closed;
  }

  /** A device of the workspace said where it is on the local network: connected to, if this one has the lower key and is not connected to it. */
  private lanFound(key: string, host: string, port: number): void {
    const address = `${host.includes(':') ? `[${host}]` : host}:${port}`;
    if (this.myKey < key) return this.dialTcpTo(key, address, 'lan');
    // The other connects; if it has not in a few seconds (its firewall, say, refuses what it sends), this one does.
    if (this.lanLater.has(key) || this.live(key)) return;
    const t = setTimeout(() => {
      this.lanLater.delete(key);
      if (!this.live(key)) this.dialTcpTo(key, address, 'lan');
    }, LAN_FALLBACK_MS);
    t.unref();
    this.lanLater.set(key, t);
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

  private tcpAccept(sock: Socket, settled: () => void): void {
    const kind = LOCAL_ADDRESS.test(sock.remoteAddress ?? '') ? 'lan' : 'tcp';
    const stream = new NoiseSecretStream(false, sock, { keyPair: this.key, keepAlive: 5000 });
    // Counted, by the listener, until it is let in (0115): said so at its hello (hello).
    this.settles.set(stream, settled);
    stream.once('close', () => this.settles.delete(stream));
    this.ownOpened(stream, kind, () => undefined);
  }

  /** TCP connections not let in yet, and how to tell the listener they are (tcp.ts, 0115). */
  private readonly settles = new WeakMap<object, () => void>();

  /**
   * A connection of this layer's own (local network, TCP, a tunnel): once the
   * other end has proved its key (`expect`, if known), a link like any other,
   * unless there is one.
   */
  private ownOpened(stream: NoiseSecretStream, kind: Exclude<Via, 'internet'>, done: () => void, expect?: string, also = false): void {
    stream.on('error', () => undefined);
    // Gone quiet (both ends send keepalives every 5 s): the other end is asleep or off the network, and the
    // link closes, rather than seeming open until TCP gives up many minutes later. The handshake too.
    stream.setTimeout(QUIET_MS);
    void stream.opened.then((ok) => {
      done();
      const key = stream.remotePublicKey?.toString('hex');
      if (!ok || !key || (expect && key !== expect) || this.closing || this.refuse(key) || (this.live(key) && !this.replaces(key, stream, kind)) || (kind !== 'tunnel' && this.o.direct?.(key) === false)) return void stream.destroy();
      (stream as unknown as { rawStream?: { setTimeout?(ms: number): void } }).rawStream?.setTimeout?.(0);
      this.kinds.set(stream, kind);
      if (also) this.alsoStreams.add(stream);
      this.connected(stream as unknown as SwarmConnection);
    }, () => {
      done();
      stream.destroy();
    });
  }

  /**
   * Whether a connection of this layer's own takes the place of the link a
   * device has (0071): when both dialled each other at once over the local
   * network or TCP, each end keeps the same one, the one the lower key started
   * (as Hyperswarm does), rather than each its own, which closes both.
   */
  private replaces(key: string, stream: NoiseSecretStream, kind: Exclude<Via, 'internet'>): boolean {
    const had = this.links.get(key)!.conn as unknown as { isInitiator?: boolean };
    const hadKind = this.kinds.get(had);
    if (kind === 'tunnel' || !hadKind || hadKind === 'tunnel') return false;
    const lowerStarted = (c: { isInitiator?: boolean }) => !!c.isInitiator === this.myKey < key;
    return lowerStarted(stream as unknown as { isInitiator?: boolean }) && !lowerStarted(had);
  }

  // Tunnels: another device's connection, carried on a link (link.ts) -----------

  /**
   * Go through `via` to a device: `via` passes the bytes on to it (it is
   * connected to both), or, for another workspace of the computer at the other
   * end, takes them itself. End to end, the two run Noise inside: `via` reads
   * nothing. A connection made directly later takes its place (connected).
   */
  tunnelTo(key: string, via: PeerLink, also = false): void {
    if (this.closing || key === this.myKey || this.removedKeys.has(key) || this.live(key) || this.ownDialling.has(key) || via.closed) return;
    this.ownDialling.add(key);
    const raw = via.openTunnel({ to: key, from: this.myKey, ...(also ? { also: true } : {}) });
    const stream = new NoiseSecretStream(true, raw, { keyPair: this.key, remotePublicKey: Buffer.from(key, 'hex'), keepAlive: 5000 });
    this.ownOpened(stream, 'tunnel', () => this.ownDialling.delete(key), key, also);
  }

  /**
   * A tunnel asked for on a link to this device: for a device of this computer
   * (this workspace's or another's), taken here; for one this device is
   * connected to in this workspace, passed on, for a member of it.
   */
  private tunnelAsked(link: PeerLink, ask: TunnelAsk, stream: Duplex): void {
    if (!link.accepted || this.closing) return void stream.destroy();
    const here = localNodes(this.computer).get(ask.to);
    if (here) {
      if (here.ws?.id === this.ws.id) return here.tunnelArrived(ask.from, stream, !!ask.also);
      // Another workspace's device on this computer (one link per pair of computers): only for a device that is in
      // that workspace, as its own records say. Else any device let in here would reach every workspace's (0099).
      void here.identity.members().then(
        (ms) => (ms.some((m) => m.key === ask.from) ? here.tunnelArrived(ask.from, stream, !!ask.also) : stream.destroy()),
        () => stream.destroy(),
      );
      return;
    }
    const next = this.links.get(ask.to);
    const passing = this.passing.get(link.key) ?? 0;
    if (ask.from !== link.key || link.hello?.workspace !== this.ws.id || !next?.accepted || next.hello?.workspace !== this.ws.id || passing >= MAX_PASSED_ON) return void stream.destroy();
    this.passing.set(link.key, passing + 1);
    const onward = next.openTunnel({ to: ask.to, from: ask.from });
    // Counted until both ways are done (one way ending first is a half close: bytes still go the other).
    let open = 2;
    const end = () => {
      if (--open) return;
      const left = (this.passing.get(link.key) ?? 1) - 1;
      if (left > 0) this.passing.set(link.key, left);
      else this.passing.delete(link.key);
    };
    pipeline(stream, onward, end);
    pipeline(onward, stream, end);
  }

  /** A tunnel from another device has reached this one: a link like any other, once it proves it is `from`. */
  tunnelArrived(from: string, stream: Duplex, also = false): void {
    if (this.closing || this.refuse(from) || this.live(from)) return void stream.destroy();
    this.ownOpened(new NoiseSecretStream(false, stream, { keyPair: this.key, keepAlive: 5000 }), 'tunnel', () => undefined, from, also);
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
    if (entries.length) link.send({ type: 'also', entries: entries.slice(0, MAX_ALSO) });
  }

  /** A device said which other workspaces its computer is in: for each this computer is in too, the lower key connects, through this link. */
  private heardAlso(link: PeerLink, entries: unknown[]): void {
    const said = new Map<string, string>();
    for (const e of entries.slice(0, MAX_ALSO)) {
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
      if (n.myKey < theirs) n.tunnelTo(theirs, link, true);
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
      // A server too (0099): it lets people in by their links while every member is away, so it announces them.
      if (!this.o.joining) {
        // The owner's device: the workspace judged by the rules this build knows (0115), where it is not yet.
        if (await this.identity.adoptRules(await this.signingKeyNow()).catch(() => false)) {
          this.o.log('peers: this workspace is judged by the rules of kuraa’s policy 13 from now on (0115)');
          void this.membersChanged().catch((e: Error) => this.logUnlessClosing(e));
        }
        // A link from before that has expired since (its grant counts without anyone letting its holder in): unlinked.
        await this.identity.unlinkStale(await this.signingKeyNow()).catch((e: Error) => this.o.log(`peers: could not unlink old invite links: ${e.message}`));
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
  /**
   * Whether to take where to reach others (relays, DHT nodes, addresses) from a
   * device: only one that is someone here, a person's or a server's (0099), not
   * one let in by a link a moment ago; at its first hello and every one after
   * (0112: the second was taken from anyone accepted).
   */
  private hintsFrom(key: string): boolean {
    return !this.access?.policy.founded || this.access.personOf.has(key);
  }

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

  /**
   * A computer that syncs and has no identity is given one (0066: groups, and
   * who may invite and remove, are people's), named as git names whoever runs
   * it, else after the device. Tests that give none (null) have none.
   */
  private async ensurePerson(): Promise<void> {
    if (this.o.person !== undefined || (await this.person())) return;
    const name = (await this.o.git.run(['config', 'user.name'], { allowFail: true })).stdout.trim() || this.name;
    try {
      await createPerson(name);
      this.o.log(`peers: made an identity for whoever runs this, as ${name} (${personFile()})`);
    } catch { /* made meanwhile, by another workspace's host */ }
    this.personRead = null;
  }

  /** The commits this device's branches, and the spaces it holds, are at: a cutoff's heads (0066). */
  async branchTips(): Promise<string[]> {
    const out = await this.o.git.run(['for-each-ref', '--format=%(objectname)', 'refs/heads', SPACES], { allowFail: true });
    return [...new Set(out.stdout.split('\n').map((l) => l.trim()).filter((l) => /^[0-9a-f]{40,64}$/.test(l)))].sort();
  }

  /** Write the workspace's policy down if it has none (Identity.ensureGenesis). */
  private async ensureGenesis(fresh: boolean): Promise<void> {
    const person = await this.person();
    if (!person) return;
    try {
      await this.identity.ensureGenesis(person.id, await this.signingKeyNow(), fresh);
    } catch (e) {
      this.o.log(`peers: could not write the workspace's policy down: ${(e as Error).message}`);
    }
  }

  /**
   * The workspace's policy (policy.ts), and who this device is to it: its
   * person; or, on a server (0099: no person), the server's key, where the
   * policy has it as one.
   */
  async policy(): Promise<{ policy: import('./policy.js').Policy; me: string | null }> {
    const policy = await this.identity.policy();
    const person = await this.person();
    if (person) return { policy, me: person.id };
    const key = (await this.signingKeyNow()).publicKey.toString('hex');
    return { policy, me: policy.isServer(key) ? key : null };
  }

  /** This computer's signing key, for its person (person.ts: made on first use, never copied; read each time, as importing an identity replaces it). Tests give theirs. */
  signingKeyNow(): Promise<KeyPair> {
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
    // An identity recovered on another computer since it was copied here (0066): its key here no
    // longer counts, and vouches for nothing until it is copied here again.
    const there = person && (await this.identity.identityState(person.id));
    if (person && there && there.events.length > person.events.length) {
      this.o.log(`peers: your identity was recovered on another computer; copy it here again for what you save here to be marked as yours`);
    } else if (person) {
      await this.identity.vouch(person, key);
      // Each with the commits this device has: what the key signed among them still counts (its cutoff, 0066).
      const heads = await this.branchTips();
      // Revocations kept before identities had logs were signed by the identity's first key.
      for (const r of await revokedKeys()) await this.identity.revokeKey(person.id, r.by ?? person.events[0]!.key, r.key, r.proof, heads);
      // Keys no longer theirs since their identity was recovered: revoked here too, for their cutoff.
      for (const k of await this.identity.droppedKeys(person.id)) {
        await this.identity.revokeKey(person.id, person.publicKey.toString('hex'), k, crypto.sign(revokeKeyMessage(k), person.secretKey).toString('hex'), heads);
      }
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

  /** Who may write where, as the policy said when the members last changed (mayWrite). */
  private access: { policy: Policy; personOf: Map<string, string> } | null = null;

  /**
   * Whether a device's person may change a file, by the workspace's write rules
   * (0066): for live rooms, which take edits only from devices that may make
   * them. Anyone may where there is no policy, or no rule for the file; a
   * server's device, nowhere (0099).
   */
  mayWrite(device: string, path: string): boolean {
    const a = this.access;
    if (a?.policy.isServer(a.personOf.get(device) ?? null)) return false;
    // A device that is no one yet (0099: let in by a link, its join not come; a server's before its join counts):
    // no edit of it is taken, nor does it lead a room, where there is a policy.
    if (a?.policy.founded && device !== this.myKey && !a.personOf.get(device)) return false;
    if (!a || !a.policy.founded || !a.policy.rules.size) return true;
    return a.policy.mayWrite(a.personOf.get(device) ?? null, path);
  }

  /** Whether a device (this one too) is a server's, as the policy said when the members last changed (0099). */
  isServerDevice(device: string): boolean {
    const a = this.access;
    return !!a?.policy.isServer(a.personOf.get(device) ?? null);
  }

  /** Whose a device is (its person's identity ID; a server's key, for a server's: 0099), as the records said when the members last changed; null if no one's known. */
  personOfDevice(device: string): string | null {
    return this.access?.personOf.get(device) ?? null;
  }

  private async updateAccess(): Promise<void> {
    const personOf = new Map<string, string>();
    for (const d of [this.myKey, ...(await this.identity.members()).map((m) => m.key)]) {
      const id = await this.identity.whoIs(d);
      if (id) personOf.set(d, id);
    }
    this.access = { policy: await this.identity.policy(), personOf };
  }

  /** Read the removed devices again (after a change), and tell git which keys sign for which devices. */
  async refresh(): Promise<void> {
    this.removedKeys = new Set(await this.identity.removed());
    // What is remembered of removed devices: let go of.
    let pruned = false;
    for (const k of this.removedKeys) {
      if (k in this.hints.seen || k in this.hints.tcp) pruned = true;
      delete this.hints.seen[k];
      delete this.hints.tcp[k];
    }
    if (pruned) this.saveHints();
    await this.updateAccess().catch((e: Error) => this.o.log(`peers: could not read the workspace's policy: ${e.message}`));
    // The keys commits here are signed with, named by their person (or device), as git checks them.
    const signers: { name: string; key: string }[] = [];
    for (const d of [{ key: this.myKey, name: this.name }, ...(await this.identity.members())]) {
      const key = await this.identity.signingKeyOf(d.key);
      if (key) signers.push({ name: (await this.identity.personOf(key))?.name || d.name, key });
    }
    await writeAllowedSigners(this.o.git, join(this.o.stateDir, 'allowed_signers'), signers).catch((e: Error) => this.o.log(`peers: allowed signers: ${e.message}`));
  }

  private admitting: Promise<unknown> = Promise.resolve();

  /** When each away device was last dialled (lookup). */
  private readonly dialledAway = new Map<string, number>();
  /** When each device never seen here was first missed (lookup). */
  private readonly missingSince = new Map<string, number>();

  /** Joining: let in, and in the workspace with its own join (welcomed); before, records saying it is out wait for that. */
  private joinedIn = false;

  /**
   * Devices let in by an invite link here, and until when (0072): a device
   * joining may connect again (a second connection, by the workspace's topic,
   * once it has the secret) before its join reaches this device; it is let in
   * again meanwhile, not checked against a link it has used up.
   */
  private readonly letIn = new Map<string, { name: string; until: number }>();

  /** Run `fn` after any other run so has finished. */
  private oneAtATime<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.admitting.then(fn, fn);
    this.admitting = run.catch(() => undefined);
    return run;
  }

  /**
   * Whether to weigh the proof a device not known to be in sends with its hello
   * (Identity.proven): each costs working the policy out anew, and anyone can
   * connect. At most once in PROOF_EACH_MS for each device, and PROOF_PER_MINUTE
   * in all; past that it is turned away, and shows its proof again next time.
   */
  private mayWeigh(key: string): boolean {
    const now = Date.now();
    if ((this.weighed.get(key) ?? 0) > now - PROOF_EACH_MS) return false;
    this.weighings = this.weighings.filter((t) => t > now - 60_000);
    if (this.weighings.length >= PROOF_PER_MINUTE) return false;
    this.weighings.push(now);
    this.weighed.delete(key);
    this.weighed.set(key, now);
    // The oldest forgotten: any device can connect.
    if (this.weighed.size > MAX_VERSIONS) this.weighed.delete(this.weighed.keys().next().value!);
    return true;
  }

  private readonly weighed = new Map<string, number>();
  private weighings: number[] = [];

  /**
   * Let in a device by an invite link (0072): for as long as it is connected,
   * with a remote to fetch from. It is in for good, on every device, once its
   * person's join (the link's grant) is in the policy.
   */
  private async admit(key: string, name: string): Promise<string | null> {
    if ((await this.identity.removed()).includes(key)) return null;
    const remote = await this.identity.addRemote(key, name);
    if (remote) this.letIn.set(key, { name: remote, until: Date.now() + LET_IN_MS });
    // A server lets go of the remote of one whose join never came (0112), once the time to come is over.
    if (remote && this.isServerDevice(this.myKey)) {
      setTimeout(() => {
        if (this.closing) return;
        const now = Date.now();
        for (const [k, v] of this.letIn) if (v.until <= now) this.letIn.delete(k);
        void this.identity.pruneRemotes(new Set(this.letIn.keys())).catch((e: Error) => this.logUnlessClosing(e));
      }, LET_IN_MS + 5000).unref();
    }
    return remote;
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
    // Through the DHT: gone quiet (its keepalives stop) counts as gone, as for this layer's own (QUIET_MS).
    if (!this.kinds.has(conn)) (conn as unknown as { setTimeout?(ms: number): void }).setTimeout?.(QUIET_MS);
    this.links.get(key)?.close();
    // So many not let in yet at once (0112): past that, the one waiting longest makes way, as a device that is in is let in
    // at its hello, a moment after connecting.
    if (!this.o.joining) {
      // Not one that has said hello (0115): it is being let in (a join through a server takes a moment); of the rest, from
      // the address that holds the most places, the one waiting longest.
      const waiting = [...this.links.values()].filter((l) => !l.accepted && !l.closed && !l.hello);
      if (waiting.length >= MAX_UNACCEPTED) {
        const counts = new Map<string, number>();
        for (const l of waiting) counts.set(addressOf(l.conn), (counts.get(addressOf(l.conn)) ?? 0) + 1);
        const most = [...counts].sort((a, b) => b[1] - a[1])[0]![0];
        waiting.find((l) => addressOf(l.conn) === most)?.close();
      }
    }
    // Not let in a while after connecting (no hello, or none that lets it in): closed, not kept up by keepalives for good;
    // on a server, sooner.
    const helloTimer = setTimeout(() => {
      if (!link.accepted && !link.closed && !this.o.joining) link.close();
    }, this.isServerDevice(this.myKey) ? SERVER_HELLO_MS : HELLO_MS);
    helloTimer.unref();
    const link: PeerLink = new PeerLink(conn, () => {
      clearTimeout(helloTimer);
      if (this.links.get(key) === link) this.links.delete(key);
      // Hyperswarm may connect to it again (its firewall refused it while this link was open).
      if (!this.closing && !this.live(key)) this.unban(key);
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

  /**
   * A hello for a device. `same`: what is the same in every device's (branches,
   * spaces listed, outputs, the records' hash), read once for all of them (0099:
   * three git processes a device, a device each, on every change, made a server
   * of many members spend its time on hellos).
   */
  private async helloFor(link: PeerLink, same?: { heads: Record<string, string>; spaces: string; outputs: Record<string, string>; digest: string }): Promise<ControlMessage> {
    const shown = await this.linkToShow();
    const paired = link.accepted || (await this.identity.members()).some((m) => m.key === link.key);
    return {
      type: 'hello',
      protocol: PROTOCOL,
      minProtocol: MIN_PROTOCOL,
      ...(ownVersion ? { version: ownVersion } : {}),
      workspace: this.ws.id,
      forkedFrom: this.ws.forkedFrom,
      name: this.name,
      // Which records it holds (who is in, and who people are), as a hash: a device that holds
      // others asks for what it lacks (want). Nothing for a device not known yet (it may never be let in).
      digest: paired ? same?.digest ?? digestOf(await this.identity.records()) : '',
      merges: this.o.merges ?? '',
      // Its branches, only to a device it is paired with (0071): anyone on the local network can connect.
      ...(paired ? { heads: same?.heads ?? (await this.heads()) } : {}),
      // The spaces its person may read, as this device has them (0066): fetched when they differ.
      ...(paired ? { spaces: await this.spaceHeads(link.key, same?.spaces) } : {}),
      ...(paired ? { outputs: same?.outputs ?? (await outputRefs(this.o.git)) } : {}),
      // For members only: how to reach this device besides the DHT (a device not known yet learns
      // nothing of it): the relay it offers and whether it is on a public address, the relays named in
      // its settings, where it takes TCP (a server), and its DHT node to start from.
      // The relay this device runs: only to someone here (0112), not to a device let in by a link a moment ago.
      ...(paired && this.relayOffered && this.hintsFrom(link.key) ? { relay: this.relayOffered, relayPublic: this.relayPublic } : {}),
      ...(paired && this.o.relays?.length ? { relays: this.o.relays.filter(isRelayKey).slice(0, 4) } : {}),
      ...(paired ? { tcp: this.publicAddress ? [this.publicAddress] : [] } : {}),
      ...(paired && this.dhtAddress ? { dht: this.dhtAddress } : {}),
      // A device joining shows its link to whomever it reaches; one that came in by a link, only to members
      // that may not know it yet (0071): a device not paired must not get a link that may still let people in.
      // Never with the secret half of its key (0115): only this device, its holder, proves it holds it (linkProof).
      ...(shown && (this.o.ticket || paired) ? { link: withoutSecret(shown) } : {}),
      // To a device that may not know this one is in (0072): what shows it is.
      ...(!paired && !this.o.joining ? { proof: await this.identity.proof() } : {}),
      // Joining: the key its join will be signed with, for the device letting it in to say so in the policy (admit).
      ...(this.o.joining && this.o.ticket ? await this.joiningProof(this.o.ticket) : {}),
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

  /** Joining by a link: the signing key its join is signed with, and the link's key's word that it is its holder's (0115). */
  private async joiningProof(ticket: string): Promise<{ signer: string; linkProof?: string }> {
    const signer = (await this.signingKeyNow()).publicKey.toString('hex');
    const proof = linkProofFor(decodeLink(ticket), signer);
    return { signer, ...(proof ? { linkProof: proof } : {}) };
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
    // Any member's links (0038), if an admin's grant lets its holder in (0066).
    const members = [this.myKey, ...(await this.identity.members()).map((m) => m.key)];
    return checkLink(l, { workspace: this.ws.id, members, revoked: await this.identity.revokedLinks() }) ?? this.identity.refuseGrant(l);
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
    // Turned away, whether this device took the other in or not: a device joining has not yet (0072).
    if (m.type === 'bye') {
      // Logged from a device let in, or while joining (whoever turns this one away says why): not a stranger's words (0112).
      const reason = saidByPeer(m.reason);
      if (link.accepted || this.o.joining) this.o.log(`peers: ${saidByPeer(link.remote ?? link.hello?.name ?? link.key.slice(0, 8))} left: ${reason}`);
      this.events.refused?.(link, reason);
      link.close();
      return;
    }
    if (!link.accepted) return;
    if (m.type === 'refs') {
      link.heads = readHeads(m.heads);
      link.spaces = readHeads(m.spaces);
      link.outputs = readOutputs(m.outputs);
      this.events.refs?.(link);
    }
    else if (m.type === 'room') this.events.room?.(link, m);
    else if (m.type === 'outputs') {
      if (link.hello?.workspace === this.ws.id) this.events.outputs?.(link, m.frame);
    }
    else if (m.type === 'records') {
      if (link.hello?.workspace === this.ws.id && Array.isArray(m.records)) await this.takeRecords(link, m.records.slice(0, MAX_RECORDS));
      if (link.hello?.workspace === this.ws.id && Array.isArray(m.unheld)) {
        const ids = m.unheld.slice(0, 100).filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x));
        const held = new Set((await this.identity.records()).filter((r) => r.kind === 'policy').map((r) => r.subject));
        if (ids.length) this.events.unheld?.(link, ids.filter((id) => !held.has(id)));
      }
    }
    else if (m.type === 'ops') {
      if (link.hello?.workspace === this.ws.id && Array.isArray(m.ids)) await this.answerOps(link, m.ids.slice(0, 100));
    }
    else if (m.type === 'want') {
      if (link.hello?.workspace === this.ws.id && Array.isArray(m.have)) await this.answerWant(link, m.have.slice(0, MAX_HAVE), m.reply === true);
    }
    else if (m.type === 'also') {
      if (Array.isArray(m.entries)) this.heardAlso(link, m.entries);
    }
    else if (m.type === 'present') {
      link.present = new Set((Array.isArray(m.keys) ? m.keys : []).filter((k): k is string => typeof k === 'string' && /^[0-9a-f]{64}$/.test(k)));
      await this.reach();
    }
  }

  private async hello(link: PeerLink, h: Extract<ControlMessage, { type: 'hello' }>): Promise<void> {
    // Another version of what devices say: no syncing, and each says why (an older device, which
    // does not know of this, sees only that it was turned away). The newer one's kuraa is the one to have.
    // What a device says of its version is news only from one known to be in the workspace (0099: anyone can reach
    // a server's address and say anything), and once an hour at most, whatever it says.
    const inWorkspace = (await this.identity.members()).some((m) => m.key === link.key);
    // A device on a newer release: told, so this one may update sooner (speaking the same protocol, it need not).
    if (inWorkspace && ownVersion && typeof h.version === 'string' && isVersion(h.version) && compareVersions(h.version, ownVersion) > 0 && Date.now() - releaseToldAt > NEWS_MS) {
      releaseToldAt = Date.now();
      versionNews.emit('release', h.version);
    }
    const theirs = typeof h.protocol === 'number' && Number.isInteger(h.protocol) ? h.protocol : 1;
    const theirMin = typeof h.minProtocol === 'number' && Number.isInteger(h.minProtocol) && h.minProtocol <= theirs ? h.minProtocol : theirs;
    // Another protocol, but one both speak, for rules this workspace is judged by (0115): synced, as the older speaks.
    const rules = this.access?.policy.rulesVersion ?? 12;
    if (theirs !== PROTOCOL && !protocolsMeet({ protocol: PROTOCOL, min: MIN_PROTOCOL }, { protocol: theirs, min: theirMin }, rules)) {
      const known = this.versions.get(link.key);
      this.versions.delete(link.key);
      this.versions.set(link.key, theirs);
      // The oldest forgotten: any device can say hello.
      if (this.versions.size > MAX_VERSIONS) this.versions.delete(this.versions.keys().next().value!);
      if (known !== theirs) this.o.log(`peers: ${saidByPeer(h.name)} (${link.key.slice(0, 8)}…) runs ${theirs > PROTOCOL ? 'a newer' : 'an older'} kuraa; the two do not sync until ${theirs > PROTOCOL ? 'this one is' : 'it is'} updated`);
      if (theirs > PROTOCOL && inWorkspace && Date.now() - protocolToldAt > NEWS_MS) {
        protocolToldAt = Date.now();
        // With the protocol it speaks and the workspace it is in (0115: a server switches only where its devices do).
        versionNews.emit('newer', theirs, this.ws.id);
      }
      link.send({ type: 'bye', reason: theirs > PROTOCOL ? 'this device runs an older kuraa: update it to sync' : 'the other device runs an older kuraa: update that one to sync' });
      setTimeout(() => link.close(), 100);
      return;
    }
    this.versions.delete(link.key);
    // Again, from a device already accepted: what it now knows of the members.
    if (link.accepted) {
      // A device is let in as one workspace's, or a related one's: it does not become another's (0071).
      if (h.workspace !== link.hello?.workspace) return link.close();
      const before = JSON.stringify([link.heads, link.spaces]);
      link.hello = h;
      link.heads = readHeads(h.heads);
      link.spaces = readHeads(h.spaces);
      link.outputs = readOutputs(h.outputs);
      if (h.workspace === this.ws.id && this.hintsFrom(link.key)) this.noteHints(link.key, h);
      if (h.workspace === this.ws.id) await this.gossip(link, h);
      // Its branches or the spaces this device may read changed (it may have been let read one): fetched (0071).
      if (JSON.stringify([link.heads, link.spaces]) !== before) this.events.refs?.(link);
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
    // A fork meeting a device of the workspace it was forked from: in that one, as the records of it here say (0072).
    if (!member && !same && (this.ws.forkedFrom ?? '').startsWith(`${h.workspace}@`) && (await this.identity.devicesOf(h.workspace)).has(link.key)) {
      member = (await this.identity.remotes()).find((x) => x.key === link.key) ?? { key: link.key, name: (await this.identity.addRemote(link.key, h.name)) ?? h.name };
    }
    if (!member && this.o.joining) {
      // Joining: a device of the workspace may let this one in; it is paired with
      // once its welcome shows the link's maker vouches for it (welcomed).
      if (same && this.o.ticket) {
        link.hello = h;
        return;
      }
      return bye('not paired with this device');
    }
    // A device this one does not know to be in, showing it is (0072): of its records, those about it, taken only if
    // they show it is in, and it is judged again. Nothing else a stranger sends is kept, or passed on.
    if (!member && same && Array.isArray(h.proof) && h.proof.length && this.mayWeigh(link.key)) {
      const proven = await this.identity.proven(link.key, h.proof.slice(0, MAX_PROOF));
      if (proven.length) await this.takeRecords(link, proven);
      member = (await this.identity.members()).find((x) => x.key === link.key);
    }
    // A device in already, joining again by a link (0099: a server whose join got as far as its join, then stopped,
    // tried again as the same device): welcomed as one let in is, so its join goes on, rather than waiting for ever.
    if (member && same && typeof h.link === 'string' && typeof h.signer === 'string' && !link.accepted) {
      const others = (await this.identity.members()).filter((x) => x.key !== link.key);
      link.send({ type: 'welcome', name: this.name, members: others.map((x) => ({ key: x.key, name: x.name })), branch: await this.o.branch(), records: await this.identity.records(), secret: this.ws.secret });
    }
    // Let in by a link here a moment ago, connecting again before its join came (0072).
    const recently = this.letIn.get(link.key);
    if (!member && same && recently && recently.until > Date.now()) member = { key: link.key, name: recently.name };
    if (!member) {
      if (!same || typeof h.link !== 'string') return bye('not in this workspace');
      const code = h.link;
      // One device let in by a link at a time here (0071): two at once by a link for one person would both
      // pass the check before either used it up.
      const admitted = await this.oneAtATime(async (): Promise<{ why: string } | { l: ReturnType<typeof decodeLink>; name: string }> => {
        const why = await this.refuseLink(code);
        if (why) return { why: `not paired with this device, and ${why}` };
        const l = decodeLink(code);
        // A server lets people in by a link for one person only (0112): its admit counts for no other (policy.ts), and
        // by a link for anyone, a stranger with fresh keys could be let in, and fetch everything, over and over.
        if (this.isServerDevice(this.myKey) && !l.once) return { why: 'a server lets people in only by a link for one person' };
        // Its holder, not a device it was shown to (0115): the link's key signed the device's signing key. A server lets
        // no one in by a link from before, which has no key: whoever saw one could be let in by it.
        if (!linkProven(l, h.signer, h.linkProof)) return { why: 'the device did not show it holds the link (it may have been shown it by another)' };
        if (this.isServerDevice(this.myKey) && l.grant && !l.grant.linkKey) return { why: 'the link was made by an older kuraa, and a server lets no one in by one: ask for a new link' };
        const name = await this.admit(link.key, h.name);
        if (!name) return { why: 'this device was removed from the workspace' };
        // A link for one person lets one device in: used up, on record, so no other device lets anyone else in by it.
        if (l.once) await this.identity.useLink(l.id);
        // Let in by it, in the policy (admit): its holder's join counts, the link checked here, by this device's clock.
        if (typeof h.signer === 'string') await this.identity.admit(l.id, h.signer, await this.signingKeyNow()).catch((e: Error) => this.o.log(`peers: could not say in the policy who was let in: ${e.message}`));
        return { l, name };
      });
      if ('why' in admitted) return bye(admitted.why);
      const { l, name } = admitted;
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
    // Let in: the listener counts it no longer (0115).
    this.settles.get(link.conn)?.();
    this.settles.delete(link.conn);
    link.remote = member.name;
    link.hello = h;
    link.heads = readHeads(h.heads);
    link.spaces = readHeads(h.spaces);
    link.outputs = readOutputs(h.outputs);
    if (same) await this.gossip(link, h);
    // Where to reach others (relays, DHT nodes, addresses): only from a device that is someone here, a person's or a
    // server's (0099), not from one let in by a link a moment ago.
    if (same && this.hintsFrom(link.key)) this.noteHints(link.key, h);
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
    // Let in by a server (0099): what it hands over is checked.
    let fromServer = false;
    const records = Array.isArray(m.records) ? m.records : [];
    let members = Array.isArray(m.members) ? m.members : [];
    if (!link.accepted) {
      const t = this.o.ticket;
      if (!t || !link.hello || link.hello.workspace !== this.ws.id) return;
      const l = decodeLink(t);
      // In the workspace, as the policy the link's genesis roots says (0072): someone who only knows its secret is not.
      // In the workspace, a person's device or a server's (0099); a server's welcome is checked (its secret here, its
      // first copy as it is fetched: join.ts), as a person's need not be.
      const known = await this.identity.devicesIn(records, this.ws.id);
      known.add(l.issuer.key);
      const people = await this.identity.devicesIn(records, this.ws.id, { people: true });
      people.add(l.issuer.key);
      fromServer = !people.has(link.key);
      if (!known.has(link.key)) {
        this.o.log(`peers: ${link.hello.name} (${link.key.slice(0, 8)}…) offered to let this device in, but the records it sent do not show it to be in the workspace; not joining through it`);
        link.close();
        return;
      }
      const name = await this.identity.addRemote(link.key, link.hello.name);
      if (!name) return;
      link.accepted = true;
      link.remote = name;
      members = members.filter((x) => known.has(x.key));
      this.tellPresence();
    }
    // The workspace's secret, from the device that let this one in (the link did not carry it, 0050).
    if (!this.ws.secret) {
      const secret = typeof m.secret === 'string' && /^[0-9a-f]{32,128}$/.test(m.secret) ? m.secret : null;
      // From a server (0099): the secret a person's device last made, as the records it sent say, where they say one.
      const ticket = this.o.ticket ? (() => { try { return decodeLink(this.o.ticket!); } catch { return undefined; } })() : undefined;
      if (secret && fromServer && !(await this.identity.secretMatches(records, this.ws.id, secret, ticket))) {
        this.o.log(`peers: ${link.hello?.name ?? link.key.slice(0, 8)} (a server) let this device in with a secret none of the workspace's people made; not joining through it`);
        link.close();
        return;
      }
      if (!secret) {
        this.o.log(`peers: ${link.hello?.name ?? link.key.slice(0, 8)} let this device in without the workspace's secret; not joining through it`);
        link.close();
        return;
      }
      await this.identity.adopt({ id: this.ws.id, secret, forkedFrom: this.ws.forkedFrom });
      this.ws = { ...this.ws, secret };
      void this.retopic();
      // Who this device is, said now that it is in a workspace (0072): nothing could be before it had the secret.
      this.saidFor = '';
      await this.syncPerson();
    }
    await this.takeRecords(link, records);
    // Let in by a link that puts this person in a group: said in the policy (0066). A server (0099), by a link for one,
    // says so itself, with its key: no person's.
    const person = await this.person();
    const asServer = !person && !!this.o.ticket && decodeLink(this.o.ticket).grant?.role === 'server';
    if ((person || asServer) && this.o.ticket) {
      await this.identity.joinPolicy(decodeLink(this.o.ticket), await this.signingKeyNow()).catch((e: Error) => this.o.log(`peers: could not join the workspace's policy: ${e.message}`));
    }
    // Out, its own join counted or not (0099): a key removed for good, or a link that did not let it back in.
    if ((await this.identity.removed()).includes(this.myKey)) {
      const key = (await this.signingKeyNow()).publicKey.toString('hex');
      const why = (await this.identity.policy()).dropped.has(key)
        ? 'this computer’s key was removed from the workspace for good (lost or stolen), so it cannot join with it again'
        : 'this computer is out of the workspace, and the link did not let it back in';
      this.o.log(`peers: ${why}`);
      this.events.out?.(why);
      await this.close();
      return;
    }
    this.joinedIn = true;
    if ((person || asServer) && this.o.ticket) void this.membersChanged().catch(() => undefined);
    this.events.welcome?.(link, { ...m, members }, fromServer);
  }

  /**
   * A member said which records it holds (as a hash): if they are not the ones
   * this device holds, ask for what this one lacks, saying what it has (want).
   */
  private async gossip(link: PeerLink, h: Extract<ControlMessage, { type: 'hello' }>): Promise<void> {
    const mine = await this.identity.records();
    if (typeof h.digest === 'string' && h.digest !== digestOf(mine)) link.send({ type: 'want', have: [...new Set(mine.map(shortKey))] });
  }

  /**
   * A member asked for the records it lacks: send them. If it has some this one
   * lacks, ask for those in turn, once (`reply`: this want answers one of this
   * device's, and is not answered with another, 0071). Records one end takes
   * and the other never does (a signer one of them does not know yet) are then
   * asked for again at the next hello, not back and forth for ever.
   */
  private async answerWant(link: PeerLink, have: unknown[], reply: boolean): Promise<void> {
    const theirs = new Set(have.filter((x): x is string => typeof x === 'string'));
    const mine = await this.identity.records();
    const lacking = forDevice(mine.filter((r) => !theirs.has(shortKey(r))), link.key, new Set(await this.identity.removed()));
    if (lacking.length) link.send({ type: 'records', records: lacking });
    if (reply) return;
    const known = new Set(mine.map(shortKey));
    if ([...theirs].some((x) => !known.has(x))) link.send({ type: 'want', have: [...known], reply: true });
  }

  /**
   * A device asked for policy operations that commits this one sent name
   * (gate.ts): those held are sent, and the rest said not to be held here, so
   * it does not wait for them for ever (peers.ts, knownFrom).
   */
  private async answerOps(link: PeerLink, ids: unknown[]): Promise<void> {
    const asked = new Set(ids.filter((x): x is string => typeof x === 'string' && /^[0-9a-f]{64}$/.test(x)));
    if (!asked.size) return;
    const all = (await this.identity.records()).filter((r) => r.kind === 'policy');
    const byId = new Map(all.map((r) => [r.subject, r]));
    const held = all.filter((r) => asked.has(r.subject));
    const unheld = [...asked].filter((id) => !byId.has(id));
    // With their pasts (0115): the device asking counts an operation as held only with all it descends from.
    const sent = new Map(held.map((r) => [r.subject, r]));
    for (let todo = held.flatMap((r) => r.parents ?? []); todo.length && sent.size < 2000;) {
      const id = todo.pop()!;
      if (sent.has(id)) continue;
      const r = byId.get(id);
      if (!r) continue;
      sent.set(id, r);
      todo.push(...(r.parents ?? []));
    }
    link.send({ type: 'records', records: [...sent.values()], unheld });
  }

  /** Signed records (records.ts): each taken if its signer may make it, whoever passed it on. */
  private async takeRecords(link: PeerLink, records: unknown[]): Promise<void> {
    const before = new Set((await this.identity.members()).map((m) => m.key));
    const taken = await this.identity.takeRecords(records);
    if (!taken.length) return;
    // Out (0072): dropped, its key revoked, or its person taken out.
    const removed = new Set(await this.identity.removed());
    // Joining: the records first say what was (a server taken out, someone invited back), before its own join is
    // made; whether it is out is said once it is (welcomed).
    if (removed.has(this.myKey) && this.o.joining && !this.joinedIn) return;
    if (removed.has(this.myKey)) {
      this.o.log('peers: this device is out of the workspace (removed, or its person taken out); not syncing');
      await this.close();
      return;
    }
    for (const m of await this.identity.members()) {
      if (before.has(m.key)) continue;
      this.o.log(`peers: ${m.name} (${m.key.slice(0, 8)}…) is in the workspace`);
      this.dial(m.key);
    }
    for (const k of before) {
      if (!removed.has(k)) continue;
      // Told first, as the device that removed it does (Peers.removeDevice): one reached only through this
      // device would otherwise never hear it is out. Then let go of.
      const l = this.links.get(k);
      if (l?.accepted) l.send({ type: 'records', records: forDevice(taken, k, removed) });
      if (l) setTimeout(() => l.close(), 1000).unref();
      this.o.log(`peers: ${k.slice(0, 8)}… is out of the workspace`);
    }
    for (const r of taken) {
      const who = (await this.identity.members()).find((m) => m.key === r.by)?.name ?? (r.by === this.myKey ? 'this device' : `${r.by.slice(0, 8)}…`);
      if (r.kind === 'revoke-link') this.o.log(`peers: ${who} ${r.name === 'used' ? 'let someone in by' : 'revoked'} invite link ${r.subject}`);
      else if (r.kind === 'link') this.o.log(`peers: ${who} made invite link ${r.subject}`);
      else if (r.kind === 'secret') this.o.log(`peers: ${who} made the workspace's secret anew`);
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
    // One run at a time, and one waiting at most: a call while one waits joins it (0099: each member's acknowledgement
    // of a change comes on its own, and each would have every device told again, M times M hellos). The run waited
    // for begins after the call, so it holds what the caller changed.
    if (this.changeWaiting) {
      if (this.changeWaitingExcept !== except) this.changeWaitingExcept = undefined;
      return this.changeWaiting;
    }
    this.changeWaitingExcept = except;
    const run = this.changeRunning.catch(() => undefined).then(() => {
      this.changeWaiting = null;
      const now = this.changeNow(this.changeWaitingExcept);
      this.changeRunning = now;
      return now;
    });
    this.changeWaiting = run;
    return run;
  }

  private changeWaiting: Promise<void> | null = null;
  private changeWaitingExcept: PeerLink | undefined;
  private changeRunning: Promise<void> = Promise.resolve();

  private async changeNow(except?: PeerLink): Promise<void> {
    await this.refresh();
    // How much of the policy this device holds, if that changed (0072): its person confirms the removals in it.
    await this.identity.acknowledge().catch((e: Error) => this.o.log(`peers: could not acknowledge the policy: ${e.message}`));
    // Links made, revoked or used: announced, or no longer.
    await this.retopic();
    const all = await this.identity.records();
    const fresh = all.filter((r) => !this.told.has(r.sig));
    for (const r of fresh) this.told.add(r.sig);
    const removed = new Set(await this.identity.removed());
    // What every device's hello says alike, read once.
    const same = {
      heads: await this.heads(),
      spaces: (await this.o.git.run(['for-each-ref', '--format=%(refname)%00%(objectname)', SPACES], { allowFail: true })).stdout,
      outputs: await outputRefs(this.o.git),
      digest: digestOf(all),
    };
    for (const l of this.links.values()) {
      if (!l.accepted || l === except) continue;
      const records = forDevice(fresh, l.key, removed);
      if (records.length && l.hello?.workspace === this.ws.id) l.send({ type: 'records', records });
      l.send(await this.helloFor(l, same));
    }
    this.events.members?.();
  }

  /**
   * Refs a device may not fetch (0066): every space but those its person may
   * read, and every other device's spaces as fetched here. Git sends nothing
   * that only hidden refs reach, and takes no want for what it did not show.
   */
  private hiddenRefs(device: string): string[] {
    const hidden = [PEER_SPACES, SPACES];
    const a = this.access;
    if (!a) return hidden;
    const person = a.personOf.get(device) ?? null;
    for (const id of a.policy.spaces.keys()) if (a.policy.mayRead(person, id)) hidden.push(`!${SPACES}${id}/`);
    return hidden;
  }

  /** The tips of the spaces a device's person may read, as this device has them (`<id>/<branch>` → commit), for its hello (0066). */
  private async spaceHeads(device: string, listed?: string): Promise<Record<string, string>> {
    const out = { stdout: listed ?? (await this.o.git.run(['for-each-ref', '--format=%(refname)%00%(objectname)', SPACES], { allowFail: true })).stdout };
    const a = this.access;
    const person = a?.personOf.get(device) ?? null;
    const heads: Record<string, string> = {};
    for (const line of out.stdout.split('\n').filter(Boolean)) {
      const [ref, oid] = line.split('\0');
      const m = /^refs\/spaces\/([0-9a-f]{32})\/heads\/(.+)$/.exec(ref!);
      if (m && a?.policy.mayRead(person, m[1]!)) heads[`${m[1]}/${m[2]}`] = oid!;
    }
    return heads;
  }

  /** Whether a device's person may read a space: yes, no, or not known here yet (its operation has not come) (0071). */
  spaceAccess(device: string, space: string): 'read' | 'no' | 'unknown' {
    const a = this.access;
    if (!a || !a.policy.founded || !a.policy.spaces.has(space)) return 'unknown';
    return a.policy.mayRead(a.personOf.get(device) ?? null, space) ? 'read' : 'no';
  }

  /** Whether a device's person may read a file of a space (null: the workspace's own, which anyone in it reads) (0066). */
  mayReadSpace(device: string, space: string | null): boolean {
    if (space === null) return true;
    const a = this.access;
    if (!a || !a.policy.founded) return false;
    return a.policy.mayRead(a.personOf.get(device) ?? null, space);
  }

  /** Let a paired device fetch: `git upload-pack`, nothing that writes; no space its person may not read (0066). */
  private serveGit(link: PeerLink, service: string, protocol: string, stream: Duplex): void {
    if (!link.accepted || service !== 'git-upload-pack') return void stream.destroy();
    // Protocol v0 whatever the device asks for (uploadPackArgs): its GIT_PROTOCOL is not passed on.
    void protocol;
    const child = spawnGit([...uploadPackArgs(this.hiddenRefs(link.key)), 'upload-pack', '--strict', '--timeout=600', join(this.o.dir, '.git')], {
      env: uploadPackEnv(),
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
  /** The disk was found all but full at the last fetch: said once, until there is room again. */
  private lowOnSpace = false;
  /** Room on the disk, as last looked at before a fetch (0115). */
  private freeBytes = Infinity;
  /** The most one fetch may bring (a server's first copy of a workspace more; each after, the usual). */
  private maxFetchBytes = DEFAULT_FETCH_BYTES;

  /** The most one fetch brings from now on (0115: a server's node, its first copy made, back to the usual). */
  setMaxFetchBytes(bytes: number): void {
    this.maxFetchBytes = bytes;
  }

  /**
   * Fetch a paired device's branches into `<its remote>/…`, and the spaces it
   * lets this one fetch (0066) into `refs/kuraa/peer-spaces/<its remote>/…`; one
   * fetch per device at a time. Returns whether it worked.
   */
  fetch(remote: string, o: { progress?: (said: string) => void } = {}): Promise<boolean> {
    return this.queueFetch(remote, [`+refs/heads/*:refs/remotes/${remote}/*`, `+${SPACES}*:${PEER_SPACES}${remote}/*`], o.progress);
  }

  /**
   * Fetch the run outputs a paired device has (outputs.ts): not branches, and
   * going nowhere else. In a queue of their own, beside its branches' (0062):
   * other refs, so the two never touch the same ones.
   */
  fetchOutputs(remote: string): Promise<boolean> {
    return this.queueFetch(remote, [outputsRefspec(remote)]);
  }

  private queueFetch(remote: string, refspecs: string[], progress?: (said: string) => void): Promise<boolean> {
    const queue = `${remote}\0${refspecs.join('\0')}`;
    const before = this.fetches.get(queue) ?? Promise.resolve(true);
    const run = before.catch(() => false).then(() => this.fetchNow(remote, refspecs, progress));
    this.fetches.set(queue, run);
    // Its failure is the caller's to handle (run is returned): not this bookkeeping's, which would leave it unhandled.
    const forget = () => {
      if (this.fetches.get(queue) === run) this.fetches.delete(queue);
    };
    void run.then(forget, forget);
    return run;
  }

  /**
   * One fetch. With `progress` (a whole workspace copied on joining, 0099): git's
   * progress said as it goes (the last line of it), and stopped only once it has
   * said nothing for 5 minutes, however long the copy takes; else stopped after
   * 10 minutes, as a sync's fetch of what is new has always been.
   */
  private async fetchNow(remote: string, refspecs: string[], progress?: (said: string) => void): Promise<boolean> {
    if (this.closing) return false;
    // Not where the disk is all but full (0112): a device sending more and more would fill it, refused or not. While
    // room is short, one fetch at a time in this process (0115), each limited to the room left: else several, each seeing
    // the same room, would fill it between them.
    let free = await statfs(this.o.dir).then((f) => f.bavail * f.bsize, () => Infinity);
    let release: (() => void) | null = null;
    if (free < LOW_FREE_BYTES) {
      const before = fetchTurn;
      fetchTurn = new Promise<void>((r) => (release = r));
      await before;
      free = await statfs(this.o.dir).then((f) => f.bavail * f.bsize, () => Infinity);
    }
    try {
      return await this.fetchWithin(remote, refspecs, free, progress);
    } finally {
      (release as (() => void) | null)?.();
    }
  }

  private async fetchWithin(remote: string, refspecs: string[], free: number, progress?: (said: string) => void): Promise<boolean> {
    this.freeBytes = free;
    if (free < MIN_FREE_BYTES) {
      if (!this.lowOnSpace) this.o.log(`peers: not fetching from ${remote}: less than 1 GB is free on this disk`);
      this.lowOnSpace = true;
      return false;
    }
    this.lowOnSpace = false;
    const r = await this.o.git.run([
      '-c', `core.hooksPath=${devNull}`, '-c', 'fetch.recurseSubmodules=false', '-c', 'protocol.version=2',
      'fetch', '--prune', '--no-write-fetch-head', ...(progress ? ['--progress'] : []), remote, ...refspecs,
    ], {
      allowFail: true,
      env: { PATH: gitPath(this.bridge.binDir) },
      ...(progress
        ? { idleMs: 5 * 60_000, onStderr: (chunk: string) => { const last = chunk.split(/[\r\n]/).map((l) => l.trim()).filter(Boolean).at(-1); if (last) progress(last); } }
        : { timeoutMs: 10 * 60_000 }),
    });
    if (r.code !== 0 && !this.closing) this.o.log(`peers: fetching from ${remote} failed: ${(r.stderr || r.stdout).trim()}`);
    return r.code === 0;
  }

  /** Something that went wrong in the background, logged; not once this device is closing (what it worked on may be gone). */
  private logUnlessClosing(e: Error): void {
    if (!this.closing) this.o.log(`peers: ${e.message}`);
  }

  /** Tell every connected device where this one's branches and outputs are, and the spaces each may read (0066). */
  async broadcastRefs(heads: Record<string, string>, outputs: Record<string, string>): Promise<void> {
    // The spaces read once, and each device told those its person may read (0071: not once for each device).
    const listed = (await this.o.git.run(['for-each-ref', '--format=%(refname)%00%(objectname)', SPACES], { allowFail: true })).stdout;
    for (const link of this.links.values()) if (link.accepted) link.send({ type: 'refs', heads, outputs, spaces: await this.spaceHeads(link.key, listed) });
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
    for (const t of this.lanLater.values()) clearTimeout(t);
    if (this.key && localNodes(this.computer).get(this.myKey) === this) localNodes(this.computer).delete(this.myKey);
    this.lan?.leave();
    this.tcp?.stop();
    if (this.hintsTimer) {
      clearTimeout(this.hintsTimer);
      await writeFile(this.hintsFile, JSON.stringify(this.hints), { mode: 0o600 }).catch(() => undefined);
    }
    for (const t of this.dialling.values()) clearTimeout(t);
    for (const link of this.links.values()) link.close();
    await this.releaseRelay?.();
    await this.swarm?.destroy();
    await this.bridge.close();
  }
}
