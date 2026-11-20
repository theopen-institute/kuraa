// One connection to another device, split into channels (protomux): control
// messages (JSON), rooms (their changes as bytes), and git streams, any number
// at once. A channel's messages sent before the other end opens it wait there
// until it does (protomux), and both ends open both as they connect.
// The connection itself is Hyperswarm's: encrypted (Noise), and the other end
// proved it holds the key it claims (`remotePublicKey`).
import { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import Protomux, { type Channel, type Encoding, type Message } from 'protomux';
import c from 'compact-encoding';
import type { SwarmConnection } from 'hyperswarm';

const CONTROL = 'kuraa/control/1';
const GIT = 'kuraa/git/1';
const ROOMS = 'kuraa/rooms/1';

/** A room message on the rooms channel: its fields as JSON, less those that are bytes, which follow as they are. */
interface RoomFrame { meta: Record<string, unknown> & { bin?: string[] }; data: Buffer[] }

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
      /** A one-time invitation, from a device joining. */
      invite?: string;
      /** A subscription link, from a device that joined (or is joining) by one. */
      link?: string;
      /** How it merges (merging.ts, mergeSignature). */
      merges: string;
      /**
       * Every signed membership record it holds (records.ts): who is in, who was
       * removed, links revoked, rules, people. Only to a device it is paired with:
       * none to one it does not know yet.
       */
      records: unknown[];
    }
  /** The answer to a joining device: what it needs to set itself up, and the records (the joining device checks who welcomed it by them). */
  | { type: 'welcome'; name: string; members: { key: string; name: string }[]; branch: string; records: unknown[] }
  /** This device's branches changed: fetch them. */
  | { type: 'refs' }
  | { type: 'bye'; reason: string }
  /** Rooms: what this device has open, and changes to them (see rooms.ts). */
  | { type: 'room'; [k: string]: unknown };

export class PeerLink {
  readonly key: string;
  private readonly mux: Protomux;
  private readonly control: Channel;
  private readonly send_: Message<unknown>;
  private readonly rooms: Channel;
  private readonly sendFrame: Message<RoomFrame>;
  private readonly listeners = new Set<(m: ControlMessage) => void>();
  private gitHandler: ((service: string, protocol: string, stream: Duplex) => void) | null = null;
  closed = false;
  /** Set once the other end's hello has been accepted. */
  accepted = false;
  /** The name it goes by here: its remote's name. */
  remote: string | null = null;
  hello: Extract<ControlMessage, { type: 'hello' }> | null = null;

  constructor(readonly conn: SwarmConnection, private readonly onClose: () => void) {
    this.key = conn.remotePublicKey.toString('hex');
    this.mux = Protomux.from(conn);
    this.control = this.mux.createChannel({ protocol: CONTROL, onclose: () => this.close() })!;
    this.send_ = this.control.addMessage({
      encoding: c.json,
      // Room messages come only on their own channel.
      onmessage: (m) => {
        if ((m as ControlMessage | null)?.type !== 'room') this.deliver(m as ControlMessage);
      },
    });
    this.control.open();
    this.rooms = this.mux.createChannel({ protocol: ROOMS })!;
    this.sendFrame = this.rooms.addMessage({ encoding: roomFrame, onmessage: (f) => this.receiveFrame(f) });
    this.rooms.open();
    this.mux.pair({ protocol: GIT }, (id) => this.acceptGit(id));
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
    return this.gitChannel(randomBytes(16), { service, protocol });
  }

  private acceptGit(id: Buffer | null): void {
    if (!id) return;
    this.gitChannel(id, null);
  }

  /** A git stream over its own channel; the opening side sends what it asks for first. */
  private gitChannel(id: Buffer, ask: { service: string; protocol: string } | null): Duplex {
    // The channel's messages, made once the channel is (the stream needs them first).
    const msg = {} as { data: Message<Buffer>; end: Message<Buffer> };
    let ended = false;
    // A write waits while the connection is backed up, so a fast writer (git
    // upload-pack sending a large pack) cannot pile the whole pack up in memory.
    let waiting: (() => void) | null = null;
    const drained = () => {
      const cb = waiting;
      waiting = null;
      cb?.();
    };
    const stream = new Duplex({
      write: (chunk: Buffer, _enc, cb) => {
        if (msg.data.send(chunk) || channel.closed) cb();
        else waiting = cb;
      },
      final: (cb) => {
        msg.end.send(Buffer.alloc(0));
        cb();
      },
      read: () => {},
      destroy: (err, cb) => {
        channel.close();
        cb(err);
      },
    });
    const channel = this.mux.createChannel({
      protocol: GIT,
      id,
      ondrain: drained,
      onclose: () => {
        drained();
        if (!ended) stream.push(null);
        stream.destroy();
      },
    })!;
    const request = channel.addMessage({
      encoding: c.json,
      onmessage: (m) => {
        const r = m as { service?: unknown; protocol?: unknown };
        if (!ask && this.gitHandler && typeof r.service === 'string') this.gitHandler(r.service, typeof r.protocol === 'string' ? r.protocol : '', stream);
        else stream.destroy();
      },
    });
    msg.data = channel.addMessage({ encoding: c.buffer, onmessage: (b) => stream.push(b) });
    msg.end = channel.addMessage({
      encoding: c.buffer,
      onmessage: () => {
        ended = true;
        stream.push(null);
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
