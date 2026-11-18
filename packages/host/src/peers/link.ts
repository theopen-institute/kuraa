// One connection to another device, split into channels (protomux): control
// messages (JSON), rooms (stage of 0028), and git streams, any number at once.
// The connection itself is Hyperswarm's: encrypted (Noise), and the other end
// proved it holds the key it claims (`remotePublicKey`).
import { Duplex } from 'node:stream';
import { randomBytes } from 'node:crypto';
import Protomux, { type Channel, type Message } from 'protomux';
import c from 'compact-encoding';
import type { SwarmConnection } from 'hyperswarm';

const CONTROL = 'kuraa/control/1';
const GIT = 'kuraa/git/1';

/** Messages on the control channel. */
export type ControlMessage =
  | {
      type: 'hello';
      /** The workspace, and the one it was forked from. */
      workspace: string;
      forkedFrom: string | null;
      name: string;
      /** Paired devices this one knows of, and removed ones. */
      members: { key: string; name: string }[];
      removed: string[];
      /** The upstream device's key, if the upstream is a device. */
      upstream: string | null;
      /** A one-time invitation, from a device joining. */
      invite?: string;
      /** A subscription link, from a device that joined (or is joining) by one. */
      link?: string;
      /** Subscription links revoked. */
      revokedLinks?: string[];
    }
  /** The answer to a joining device: what it needs to set itself up. */
  | { type: 'welcome'; name: string; members: { key: string; name: string }[]; upstream: string | null; branch: string }
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
      onmessage: (m) => {
        for (const fn of this.listeners) fn(m as ControlMessage);
      },
    });
    this.control.open();
    this.mux.pair({ protocol: GIT }, (id) => this.acceptGit(id));
    conn.on('error', () => this.close());
    conn.on('close', () => this.close());
  }

  send(m: ControlMessage): void {
    if (!this.closed) this.send_.send(m);
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
    const stream = new Duplex({
      write: (chunk: Buffer, _enc, cb) => {
        msg.data.send(chunk);
        cb();
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
      onclose: () => {
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
