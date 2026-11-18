// The little of Hyperswarm, protomux and friends that the peer layer uses.
// They ship no types of their own.

declare module 'hyperswarm' {
  import type { Duplex } from 'node:stream';
  import type { EventEmitter } from 'node:events';
  export interface KeyPair { publicKey: Buffer; secretKey: Buffer }
  export interface SwarmConnection extends Duplex { remotePublicKey: Buffer; publicKey: Buffer }
  export interface PeerInfo { publicKey: Buffer; topics: Buffer[] }
  export interface Discovery { flushed(): Promise<void>; destroy(): Promise<void> }
  export default class Hyperswarm extends EventEmitter {
    constructor(opts?: { keyPair?: KeyPair; bootstrap?: unknown[]; firewall?: (remotePublicKey: Buffer) => boolean; maxPeers?: number });
    keyPair: KeyPair;
    connections: Set<SwarmConnection>;
    join(topic: Buffer, opts?: { server?: boolean; client?: boolean }): Discovery;
    leave(topic: Buffer): Promise<void>;
    joinPeer(publicKey: Buffer): void;
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
    createChannel(opts: { protocol: string; id?: Buffer | null; unique?: boolean; onopen?(): void; onclose?(): void; ondestroy?(): void }): Channel | null;
    pair(opts: { protocol: string; id?: Buffer | null }, fn: (id: Buffer | null) => void): void;
    unpair(opts: { protocol: string; id?: Buffer | null }): void;
  }
}

declare module 'compact-encoding' {
  import type { Encoding } from 'protomux';
  const c: { buffer: Encoding<Buffer>; string: Encoding<string>; raw: Encoding<Buffer>; json: Encoding<unknown> };
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
  export interface Testnet { bootstrap: unknown[]; destroy(): Promise<void> }
  export default function createTestnet(size?: number): Promise<Testnet>;
}
