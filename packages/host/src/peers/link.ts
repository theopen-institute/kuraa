// One connection to another device, split into channels (protomux): control
// messages (JSON), rooms (their changes as bytes), run outputs as they happen
// (outputs.ts, 0062), and git streams, any number at once. A channel's messages sent before the other end opens it wait there
// until it does (protomux), and both ends open both as they connect.
// The connection itself is Hyperswarm's: encrypted (Noise), and the other end
// proved it holds the key it claims (`remotePublicKey`).
import { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import Protomux, { type Channel, type Encoding, type Message } from 'protomux';
import c from 'compact-encoding';
import type { SwarmConnection } from 'hyperswarm';

const CONTROL = 'kuraa/control/1';

/**
 * The version of what devices say to each other (hello, records, rooms, git
 * streams). Two devices that speak different ones do not sync: each says so,
 * and the one running the older kuraa is to be updated (0051). Raised whenever
 * a change would keep an older device from understanding a newer one. 1: before
 * the hello said it; 2: 0050 (records by hash, links without the secret, acks
 * on git streams); 3: 0066 (identities with logs, the workspace's policy: only
 * admins' devices invite and remove, which an older one would not hold to);
 * 4: 0071 (git served as protocol v0 only, records compared by what they say,
 * a want answered once, grants that sign their link's expiry and maker, and
 * branches said only to paired devices); 5: 0072 (devices are in as their people
 * are: no pairing records; a policy ranked by who made it; keys dropped); 6: the
 * network review's fixes (links unlinked, and those let in by them admitted, in
 * the policy; a workspace from before kept to its own geneses and seal; room
 * edits saying whose they are; policy operations asked for by commits); 7:
 * 0077 (rooms are sessions, told apart by an id, with one device leading each)
 * and 0078 (clashes settled by what gives less, not by rank; workspaces from
 * before founded again; attestations and trustee rotations no longer taken);
 * 8: 0082 (a file named `@<identity ID>` is its person's own: only they change
 * it, but to move it unchanged; rooms take a person's feature state only as
 * theirs, and readers' changes to their own);
 * 9: 0099 (servers: a join with role `server`, by a key no one's, which every
 * operation after it names, so an older device would wait for them for ever);
 * 10: 0099 (a server taken out by a revoke, to be invited back: an older device
 * would not count it, and keep the server in);
 * 11: 0109 (a document's own files, `report.md.files/…`, are changed by whoever
 * may change the document: an older device would judge them by their folder);
 * 12: 0110 (the owner and servers read every space, and only a space's maker or
 * the owner changes its readers: an older device would count an admin's change,
 * and send it the space).
 */
export const PROTOCOL = 12;
const GIT = 'kuraa/git/1';
/**
 * Another device's encrypted connection, carried on this one (node.ts, tunnels):
 * to a device the other end is connected to (it passes the bytes on, reading
 * none of them), or to another of this computer's workspaces.
 */
const TUNNEL = 'kuraa/tunnel/1';
const ROOMS = 'kuraa/rooms/1';
/**
 * Run outputs as they happen (outputs.ts, 0062). Sent on only once the other
 * end has opened it too: a device running an older kuraa never does, and
 * messages for a channel it never opens would wait there, holding the whole
 * connection up once enough of them did (protomux).
 */
const OUTPUTS = 'kuraa/outputs/1';
/** How much of a stream (git, a tunnel) may be sent and not yet taken by the reader at the other end, in bytes. */
const GIT_WINDOW = 1024 * 1024;
/** The most of a stream sent at once: so the other end, keeping to the window, never has more than a piece past it. */
const GIT_PIECE = 64 * 1024;
/** Taken and not yet read past this, the other end is not keeping to the window: the stream is closed. */
const GIT_OVERRUN = 2 * GIT_WINDOW;
/** The most streams (git, tunnels) the other end may have open on one link at once (0071): each runs a process, or holds a connection, here. */
const MAX_STREAMS = 32;
/** Run outputs carrying more than this, while the connection is backed up, are not sent: they come with the outputs ref later (0071). */
const OUTPUTS_BACKED_UP_BYTES = 64 * 1024;

/**
 * What a tunnel is asked for: a connection to device `to`, from device `from`
 * (keys, hex); `also`: between two computers' devices over a link the two have
 * for another workspace, kept as a direct link is (node.ts, also).
 */
export interface TunnelAsk { to: string; from: string; also?: boolean }

/** A message on the rooms or outputs channel: its fields as JSON, less those that are bytes, which follow as they are. */
interface RoomFrame { meta: Record<string, unknown> & { bin?: string[] }; data: Buffer[] }

/** A message about run outputs (outputs.ts, LiveMessage): its fields, and bytes (plots) beside them. */
export interface OutputsFrame { meta: Record<string, unknown>; data: Buffer[] }

const buffers = c.array(c.buffer);
const roomFrame: Encoding<RoomFrame> = {
  preencode(state, m) {
    c.json.preencode(state, m.meta);
    buffers.preencode(state, m.data);
  },
  encode(state, m) {
    c.json.encode(state, m.meta);
    buffers.encode(state, m.data);
  },
  decode(state) {
    return { meta: c.json.decode(state) as RoomFrame['meta'], data: buffers.decode(state) };
  },
};

export type RoomMessage = Extract<ControlMessage, { type: 'room' }>;

/** Messages on the control channel. */
export type ControlMessage =
  | {
      type: 'hello';
      /** The workspace, and the one it was forked from. */
      workspace: string;
      forkedFrom: string | null;
      name: string;
      /** The version of what it says (PROTOCOL); none: 1. */
      protocol?: number;
      /** The version of kuraa it runs, as released (`0.10.0`); none from a build that is not one (pnpm dev). */
      version?: string;
      /** An invite link, from a device that joined (or is joining) by one. */
      link?: string;
      /** How it merges (merging.ts, mergeSignature). */
      merges: string;
      /**
       * Which signed membership records it holds (records.ts: who is in, who was
       * removed, links revoked or used, people), as one hash (node.ts, digestOf):
       * a device that holds others asks for what it lacks (want). Only to a device
       * it is paired with: empty to one it does not know yet.
       */
      digest: string;
      /** Its branches: name → commit (a device fetches only when it lacks one). */
      heads?: Record<string, string>;
      /** The tips of the spaces the receiving device's person may read (`<id>/<branch>` → commit), 0066. */
      spaces?: Record<string, string>;
      /** The run outputs it has, its own and other members' (peers/outputs.ts): device key → commit. Only to a device it is paired with. */
      outputs?: Record<string, string>;
      /** The key of the relay it offers members (relay.ts): only to a device it is paired with. */
      relay?: string;
      /** Its relay is on a public address (anyone can reach it): the best kind. */
      relayPublic?: boolean;
      /** Relays named in its settings, shared with the members. */
      relays?: string[];
      /** Where it takes TCP (a server, tcp.ts): `host:port`. */
      tcp?: string[];
      /** Its DHT node, to start from (a server): `host:port`. */
      dht?: string;
      /**
       * To a device that may not know it is in (0072): the records that show it
       * is, each signed in itself: its person's key events, the key it signs
       * with, that key vouched for, and the policy operations that key signed
       * (its join).
       */
      proof?: unknown[];
      /** A device joining by a link: the signing key its join will be signed with (the device letting it in says so: policy.ts, admit). */
      signer?: string;
    }
  /** The answer to a joining device: what it needs to set itself up, and the records (the joining device checks who welcomed it by them). */
  | { type: 'welcome'; name: string; members: { key: string; name: string }[]; branch: string; records: unknown[]; /** The workspace's secret: the link does not carry it (0050). */ secret?: string }
  /** This device's branches changed, to these (name → commit): fetch them, unless this device has them already. */
  | { type: 'refs'; heads?: Record<string, string>; outputs?: Record<string, string>; spaces?: Record<string, string> }
  /** Signed membership records the other device lacks: just taken or made here, or asked for (want); `unheld`: policy operations asked for (ops) that it does not hold. */
  | { type: 'records'; records: unknown[]; unheld?: string[] }
  /** Asking for policy operations that commits it sent name (gate.ts): sent those it holds, and told of those it does not (records, unheld). */
  | { type: 'ops'; ids: string[] }
  /** Asking for the records this device lacks: it says which it has (each by the start of the hash of what it says, records.ts, shortKey). */
  | { type: 'want'; have: string[]; /** It answers a want of the other end's: not answered with another (0071). */ reply?: boolean }
  /**
   * Which other workspaces this device's computer is in, each as a code from its
   * secret and this computer's device in it, hidden by the same (node.ts, sayAlso).
   */
  | { type: 'also'; entries: { t: string; k: string }[] }
  /** The devices of the workspace this one is connected to now: sent whenever that changes (node.ts, reach). */
  | { type: 'present'; keys: string[] }
  | { type: 'bye'; reason: string }
  /** Rooms: what this device has open, and changes to them (see rooms.ts). */
  | { type: 'room'; [k: string]: unknown }
  /** Run outputs as they happen (outputs.ts, 0062): only on their own channel. */
  | { type: 'outputs'; frame: OutputsFrame };

/** Branches as a device says they are, checked: name → commit; null if they are not. */
export function readHeads(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const out: Record<string, string> = {};
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 10_000) return null;
  for (const [name, oid] of entries) {
    // A ref's name as git allows one (no control characters, spaces or what git refuses), or none at all.
    if (typeof oid !== 'string' || !/^[0-9a-f]{40,64}$/.test(oid) || !name || name.length > 1000 || name.includes('..') || name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.lock') || name.includes('//') || name.includes('@{') || /[\x00-\x20\x7f~^:?*[\\]/.test(name)) return null;
    out[name] = oid;
  }
  return out;
}

/** Run outputs as a device says it has them, checked: device key → commit; null if not said, or not so. */
export function readOutputs(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > 10_000) return null;
  const out: Record<string, string> = {};
  for (const [key, oid] of entries) {
    if (!/^[0-9a-f]{64}$/.test(key) || typeof oid !== 'string' || !/^[0-9a-f]{40,64}$/.test(oid)) return null;
    out[key] = oid;
  }
  return out;
}

export class PeerLink {
  readonly key: string;
  private readonly mux: Protomux;
  private readonly control: Channel;
  private readonly send_: Message<unknown>;
  private readonly rooms: Channel;
  private readonly sendFrame: Message<RoomFrame>;
  private readonly outputsChannel: Channel;
  private readonly sendOutputsFrame: Message<RoomFrame>;
  private readonly listeners = new Set<(m: ControlMessage) => void>();
  private gitHandler: ((service: string, protocol: string, stream: Duplex) => void) | null = null;
  private tunnelHandler: ((ask: TunnelAsk, stream: Duplex) => void) | null = null;
  closed = false;
  /** Set once the other end's hello has been accepted. */
  accepted = false;
  /** The name it goes by here: its remote's name. */
  remote: string | null = null;
  hello: Extract<ControlMessage, { type: 'hello' }> | null = null;
  /** The devices of the workspace the other end says it is connected to. */
  present = new Set<string>();
  /** This device's hello to it, sent (node.ts): what this device says on the link comes after it. */
  said: Promise<void> = Promise.resolve();
  /** Its branches as it last said (name → commit); null: not said, so fetched to know. */
  heads: Record<string, string> | null = null;
  /** The tips of its spaces this device's person may read, as it last said (0066). */
  spaces: Record<string, string> | null = null;
  /** The run outputs it has, as it last said (device key → commit); null: not said. */
  outputs: Record<string, string> | null = null;
  /** When the link was made: one never let in is closed after a while (node.ts). */
  readonly opened = Date.now();
  /** Streams the other end has open on this link now (git, tunnels): at most MAX_STREAMS. */
  private streams = 0;
  /** The outputs channel is backed up: large frames wait for the outputs ref (sendOutputs). */
  private outputsBacked = false;

  constructor(readonly conn: SwarmConnection, private readonly onClose: () => void) {
    this.key = conn.remotePublicKey.toString('hex');
    this.mux = Protomux.from(conn);
    this.control = this.mux.createChannel({ protocol: CONTROL, onclose: () => this.close() })!;
    this.send_ = this.control.addMessage({
      encoding: c.json,
      // Room and outputs messages come only on their own channels.
      onmessage: (m) => {
        const type = (m as ControlMessage | null)?.type;
        if (type !== 'room' && type !== 'outputs') this.deliver(m as ControlMessage);
      },
    });
    this.control.open();
    this.rooms = this.mux.createChannel({ protocol: ROOMS })!;
    this.sendFrame = this.rooms.addMessage({ encoding: roomFrame, onmessage: (f) => this.receiveFrame(f) });
    this.rooms.open();
    this.outputsChannel = this.mux.createChannel({ protocol: OUTPUTS, ondrain: () => void (this.outputsBacked = false) })!;
    this.sendOutputsFrame = this.outputsChannel.addMessage({
      encoding: roomFrame,
      onmessage: (f) => {
        if (f.meta && typeof f.meta === 'object' && Array.isArray(f.data)) this.deliver({ type: 'outputs', frame: { meta: f.meta, data: f.data } });
      },
    });
    this.outputsChannel.open();
    this.mux.pair({ protocol: GIT }, (id) => this.acceptGit(id));
    this.mux.pair({ protocol: TUNNEL }, (id) => {
      if (id && this.streams < MAX_STREAMS) this.byteChannel(TUNNEL, id, null, true);
    });
    conn.on('error', () => this.close());
    conn.on('close', () => this.close());
  }

  send(m: ControlMessage): void {
    if (!this.closed) this.send_.send(m);
  }

  /**
   * Send a message about rooms, on the rooms channel: its fields that are bytes
   * (Yjs updates, state vectors) go as they are. Both channels share one
   * connection, so messages arrive in the order sent.
   */
  sendRoom(m: RoomMessage): void {
    if (this.closed) return;
    const meta: RoomFrame['meta'] = {};
    const bin: string[] = [];
    const data: Buffer[] = [];
    for (const [k, v] of Object.entries(m)) {
      if (v instanceof Uint8Array) {
        bin.push(k);
        data.push(Buffer.from(v.buffer, v.byteOffset, v.byteLength));
      } else meta[k] = v;
    }
    this.sendFrame.send({ meta: { ...meta, bin }, data });
  }

  /** Whether the other end takes run outputs as they happen: it runs a kuraa that has opened their channel. */
  get takesOutputs(): boolean {
    return !this.closed && this.outputsChannel.opened;
  }

  /** Send a message about run outputs (outputs.ts), if the other end takes them; returns whether it was sent. */
  sendOutputs(f: OutputsFrame): boolean {
    if (!this.takesOutputs) return false;
    // A slow connection (a relay, a tunnel): plots are not piled up in memory for it; finished runs come with the outputs ref.
    if (this.outputsBacked && f.data.reduce((n, b) => n + b.length, 0) > OUTPUTS_BACKED_UP_BYTES) return false;
    if (!this.sendOutputsFrame.send({ meta: f.meta, data: f.data })) this.outputsBacked = true;
    return true;
  }

  private receiveFrame(f: RoomFrame): void {
    if (!f.meta || typeof f.meta !== 'object' || !Array.isArray(f.data)) return;
    const { bin = [], ...m } = f.meta;
    if (!Array.isArray(bin)) return;
    bin.forEach((k, i) => {
      if (typeof k === 'string') m[k] = f.data[i] ?? Buffer.alloc(0);
    });
    this.deliver({ ...m, type: 'room' } as RoomMessage);
  }

  private deliver(m: ControlMessage): void {
    for (const fn of this.listeners) fn(m);
  }

  onMessage(fn: (m: ControlMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Answer git requests from the other end (it fetching from this device). */
  onGit(fn: (service: string, protocol: string, stream: Duplex) => void): void {
    this.gitHandler = fn;
  }

  /** A stream to a git service on the other device: `git-upload-pack`. */
  openGit(service: string, protocol: string): Duplex {
    return this.byteChannel(GIT, randomBytes(16), { service, protocol });
  }

  private acceptGit(id: Buffer | null): void {
    if (!id || this.streams >= MAX_STREAMS) return;
    this.byteChannel(GIT, id, null, true);
  }

  /** Answer tunnels the other end asks for (node.ts). */
  onTunnel(fn: (ask: TunnelAsk, stream: Duplex) => void): void {
    this.tunnelHandler = fn;
  }

  /** A stream carrying a connection from device `from` to device `to`, through (or to) the other end. */
  openTunnel(ask: TunnelAsk): Duplex {
    return this.byteChannel(TUNNEL, randomBytes(16), ask);
  }

  /**
   * A stream over its own channel (git, a tunnel); the opening side sends what it asks for
   * first. Each end tells the other how much it has taken (ack), and a writer
   * waits while a window's worth is not yet taken, as it waits while the
   * connection is backed up: a fast writer (git upload-pack sending a large
   * pack) cannot pile a pack up in memory, here or at a slow reader there.
   */
  private byteChannel(protocol: string, id: Buffer, ask: object | null, incoming = false): Duplex {
    if (incoming) this.streams++;
    let counted = incoming;
    // The channel's messages, made once the channel is (the stream needs them first).
    const msg = {} as { data: Message<Buffer>; end: Message<Buffer>; ack: Message<number> };
    let ended = false;
    let waiting: (() => void) | null = null;
    /** Sent and not yet taken there; the connection backed up. */
    let inflight = 0;
    let backedUp = false;
    /** Taken here (pushed to the reader) and not yet said. */
    let unacked = 0;
    const release = () => {
      if (!waiting || (!channel.closed && (backedUp || inflight > GIT_WINDOW))) return;
      const cb = waiting;
      waiting = null;
      cb();
    };
    const ack = () => {
      if (!unacked || channel.closed) return;
      msg.ack.send(unacked);
      unacked = 0;
    };
    const stream = new Duplex({
      write: (chunk: Buffer, _enc, cb) => {
        // In pieces, each waiting for the window as a write does: the other end never has more than a piece past it.
        let at = 0;
        const next = () => {
          if (channel.closed) return cb();
          while (at < chunk.length) {
            const piece = chunk.subarray(at, at + GIT_PIECE);
            at += piece.length;
            inflight += piece.length;
            backedUp = !msg.data.send(piece);
            if (at < chunk.length && (backedUp || inflight > GIT_WINDOW)) {
              waiting = next;
              return;
            }
          }
          waiting = cb;
          release();
        };
        next();
      },
      final: (cb) => {
        msg.end.send(Buffer.alloc(0));
        cb();
      },
      // The reader wants more: say what it has taken, so the other end sends on.
      read: () => ack(),
      destroy: (err, cb) => {
        channel.close();
        cb(err);
      },
    });
    const channel = this.mux.createChannel({
      protocol,
      id,
      ondrain: () => {
        backedUp = false;
        release();
      },
      onclose: () => {
        if (counted) {
          counted = false;
          this.streams--;
        }
        release();
        if (!ended) stream.push(null);
        stream.destroy();
      },
    })!;
    const request = channel.addMessage({
      encoding: c.json,
      onmessage: (m) => {
        if (ask) return void stream.destroy();
        if (protocol === GIT) {
          const r = m as { service?: unknown; protocol?: unknown };
          // The protocol the other end asks for, as git says it (`version=2`, and the like): passed to nothing else.
          const protocol = typeof r.protocol === 'string' && /^[a-z0-9=:._-]{0,100}$/i.test(r.protocol) ? r.protocol : '';
          if (this.gitHandler && typeof r.service === 'string') this.gitHandler(r.service, protocol, stream);
          else stream.destroy();
        } else {
          const r = m as { to?: unknown; from?: unknown };
          const key = /^[0-9a-f]{64}$/;
          if (this.tunnelHandler && typeof r.to === 'string' && key.test(r.to) && typeof r.from === 'string' && key.test(r.from)) this.tunnelHandler({ to: r.to, from: r.from, ...((m as { also?: unknown }).also === true ? { also: true } : {}) }, stream);
          else stream.destroy();
        }
      },
    });
    msg.data = channel.addMessage({
      encoding: c.buffer,
      onmessage: (b) => {
        unacked += b.length;
        // Sent past the window (a writer that does not wait for acks): closed, before it piles up here.
        if (unacked > GIT_OVERRUN) return void channel.close();
        // Taken while the reader keeps up; once it does not, said when it reads again (read).
        if (stream.push(b) && unacked >= GIT_WINDOW / 4) ack();
      },
    });
    msg.end = channel.addMessage({
      encoding: c.buffer,
      onmessage: () => {
        ended = true;
        stream.push(null);
      },
    });
    msg.ack = channel.addMessage({
      encoding: c.uint,
      onmessage: (n) => {
        inflight = Math.max(0, inflight - n);
        release();
      },
    });
    channel.open();
    if (ask) request.send(ask);
    return stream;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.conn.destroy();
    this.onClose();
  }
}
