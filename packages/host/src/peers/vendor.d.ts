// The little of Hyperswarm, protomux and friends that the peer layer uses.
// They ship no types of their own.

declare module 'hyperswarm' {
  import type { Duplex } from 'node:stream';
  import type { EventEmitter } from 'node:events';
  export interface KeyPair { publicKey: Buffer; secretKey: Buffer }
  export interface SwarmConnection extends Duplex { remotePublicKey: Buffer; publicKey: Buffer }
  export interface PeerInfo { publicKey: Buffer; topics: Buffer[] }
  export interface Discovery { flushed(): Promise<void>; destroy(): Promise<void>; /** Look the topic up (and announce it) again now. */ refresh(): Promise<void> }
  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: {
      keyPair?: KeyPair;
      bootstrap?: unknown[];
      /** A DHT node to use (shared with other swarms), instead of one of its own. Destroying the swarm destroys it. */
      dht?: unknown;
      firewall?: (remotePublicKey: Buffer) => boolean;
      maxPeers?: number;
      /**
       * A blind relay's key to connect through, when a direct connection cannot be
       * made (`force`: the last try failed in a way relaying helps with), or null.
       */
      relayThrough?: (force: boolean) => Buffer | null;
    });
    keyPair: KeyPair;
    connections: Set<SwarmConnection>;
    /** Its DHT node: `randomized` once it has learned this computer's router changes ports per connection. */
    dht: { randomized: boolean; firewalled: boolean; on(event: 'network-change' | 'network-update', fn: () => void): unknown };
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): Discovery;
    leave(topic: Buffer): Promise<void>;
    joinPeer(publicKey: Buffer): void;
    /** Accept connections to its key, without a topic. */
    listen(): Promise<void>;
    /** Stop dialling a device by itself (a connection to it stays). */
    leavePeer(publicKey: Buffer): void;
    flush(): Promise<void>;
    destroy(): Promise<void>;
    on(event: 'connection', fn: (conn: SwarmConnection, info: PeerInfo) => void): this;
  }
}

declare module 'protomux' {
  import type { Duplex } from 'node:stream';
  export interface Encoding<T> { preencode(state: unknown, v: T): void; encode(state: unknown, v: T): void; decode(state: unknown): T }
  export interface Message<T> { send(v: T): boolean }
  export interface Channel {
    open(handshake?: unknown): void;
    close(): void;
    addMessage<T>(opts: { encoding: Encoding<T>; onmessage(v: T): void }): Message<T>;
    opened: boolean;
    closed: boolean;
  }
  export default class Protomux {
    static from(stream: Duplex): Protomux;
    createChannel(opts: { protocol: string; id?: Buffer | null; unique?: boolean; onopen?(): void; onclose?(): void; ondestroy?(): void; ondrain?(): void }): Channel | null;
    pair(opts: { protocol: string; id?: Buffer | null }, fn: (id: Buffer | null) => void): void;
    unpair(opts: { protocol: string; id?: Buffer | null }): void;
  }
}

declare module 'compact-encoding' {
  import type { Encoding } from 'protomux';
  const c: { buffer: Encoding<Buffer>; string: Encoding<string>; raw: Encoding<Buffer>; json: Encoding<unknown>; uint: Encoding<number>; array<T>(item: Encoding<T>): Encoding<T[]> };
  export default c;
}

declare module 'hypercore-crypto' {
  const crypto: {
    keyPair(seed?: Buffer): { publicKey: Buffer; secretKey: Buffer };
    hash(data: Buffer | Buffer[]): Buffer;
    randomBytes(n: number): Buffer;
    sign(message: Buffer, secretKey: Buffer): Buffer;
    verify(message: Buffer, signature: Buffer, publicKey: Buffer): boolean;
  };
  export default crypto;
}

declare module 'hyperdht/testnet.js' {
  export interface Testnet { bootstrap: unknown[]; nodes: { address(): { port: number } }[]; destroy(): Promise<void> }
  export default function createTestnet(size?: number): Promise<Testnet>;
}

declare module 'hyperdht' {
  import type { Duplex } from 'node:stream';
  import type { EventEmitter } from 'node:events';
  export interface KeyPair { publicKey: Buffer; secretKey: Buffer }
  export interface NoiseSocket extends Duplex { remotePublicKey: Buffer; publicKey: Buffer }
  export interface DhtServer extends EventEmitter {
    listen(keyPair: KeyPair): Promise<void>;
    close(): Promise<void>;
    publicKey: Buffer;
  }
  export default class HyperDHT extends EventEmitter {
    constructor(opts?: { bootstrap?: unknown[]; nodes?: { host: string; port: number }[]; port?: number; ephemeral?: boolean });
    static keyPair(seed?: Buffer): KeyPair;
    ready(): Promise<void>;
    /** This computer's router changes its port for each connection. */
    randomized: boolean;
    /** Others cannot reach this node without its help (a router in the way). */
    firewalled: boolean;
    destroyed: boolean;
    /** DHT nodes it knows, to start from next time. */
    toArray(opts?: { limit?: number }): { host: string; port: number }[];
    createServer(opts: { firewall?(remotePublicKey: Buffer): boolean } | undefined, onconnection: (socket: NoiseSocket) => void): DhtServer;
    createRawStream(opts?: unknown): unknown;
    destroy(opts?: { force?: boolean }): Promise<void>;
  }
}

declare module 'blind-relay' {
  import type { Duplex } from 'node:stream';
  export class Server {
    constructor(opts: { createStream(opts?: unknown): unknown });
    accept(stream: Duplex, opts: { id: Buffer }): { on(event: 'error', fn: (e: Error) => void): unknown };
    close(): Promise<void>;
  }
}

declare module '@hyperswarm/secret-stream' {
  import { Duplex } from 'node:stream';
  /** A Noise-encrypted stream over another (a TCP socket): each end proves the key it holds. */
  export default class NoiseSecretStream extends Duplex {
    constructor(isInitiator: boolean, rawStream: Duplex, opts?: { keyPair?: { publicKey: Buffer; secretKey: Buffer }; remotePublicKey?: Buffer; keepAlive?: number; /** What the raw stream already brought. */ data?: Buffer });
    remotePublicKey: Buffer | null;
    publicKey: Buffer;
    opened: Promise<boolean>;
    /** Destroyed after this long without receiving anything. */
    setTimeout(ms: number): void;
  }
}
