// Connections over TCP (decision 0053): on the local network (lan.ts says
// where), and to a server with a public address (--peer-port, --public-address)
// on networks that block what the DHT needs (UDP), as many offices and campuses
// do. One listener for the whole process, for every workspace's device: a
// device connecting says first, in one line, which device it is connecting to
// (`kuraa <key>`), then the two run Noise (@hyperswarm/secret-stream), the same
// encryption and proof of keys as Hyperswarm's connections.
import { connect, createServer, type Server, type Socket } from 'node:net';
import NoiseSecretStream from '@hyperswarm/secret-stream';

/** What a device connecting first says. */
const PRELUDE = /^kuraa ([0-9a-f]{64})\n/;

interface Listener {
  server: Server;
  port: number;
  /** Each device of this process that takes connections, by key. */
  handlers: Map<string, (sock: Socket) => void>;
}

let listening: Promise<Listener | null> | null = null;
let listener: Listener | null = null;

function open(port: number, log: (m: string) => void): Promise<Listener | null> {
  return new Promise((resolve) => {
    const handlers = new Map<string, (sock: Socket) => void>();
    const server = createServer((sock) => accept(sock, handlers));
    server.on('error', (e) => {
      log(`peers: cannot take connections over TCP${port ? ` on port ${port}` : ''}: ${e.message}`);
      resolve(null);
    });
    server.listen(port, () => {
      listener = { server, port: (server.address() as { port: number }).port, handlers };
      resolve(listener);
    });
  });
}

/**
 * A connection: which device it is for, from its first line; then handed to
 * that device, with what came after put back. Read without making the socket
 * flow, so nothing that comes meanwhile is lost before the device reads it.
 */
function accept(sock: Socket, handlers: Map<string, (sock: Socket) => void>): void {
  sock.on('error', () => undefined);
  sock.setTimeout(10_000, () => sock.destroy());
  let head = Buffer.alloc(0);
  const onReadable = () => {
    for (let chunk: Buffer | null; (chunk = sock.read() as Buffer | null) !== null;) {
      head = Buffer.concat([head, chunk]);
      const nl = head.indexOf(10);
      if (nl < 0) {
        if (head.length > 100) return void sock.destroy();
        continue;
      }
      sock.off('readable', onReadable);
      const m = PRELUDE.exec(head.subarray(0, nl + 1).toString('latin1'));
      const handler = m && handlers.get(m[1]!);
      if (!handler) return void sock.destroy();
      const rest = head.subarray(nl + 1);
      if (rest.length) sock.unshift(rest);
      return handler(sock);
    }
  };
  sock.on('readable', onReadable);
}

/**
 * Take connections over TCP for a device of this process (its key), on the
 * process's listener: on `port` if given and it is the first to ask (a server's
 * --peer-port), else any free one. Returns the port, and how to stop; null if
 * there is no listener.
 */
export async function listenTcp(key: string, port: number | undefined, onSocket: (sock: Socket) => void, log: (m: string) => void): Promise<{ port: number; stop(): void } | null> {
  listening ??= open(port ?? 0, log);
  const l = await listening;
  if (!l) {
    listening = null;
    return null;
  }
  if (port && l.port !== port) log(`peers: taking connections over TCP on port ${l.port}, not ${port}: another workspace asked first`);
  l.handlers.set(key, onSocket);
  return {
    port: l.port,
    stop: () => {
      if (l.handlers.get(key) === onSocket) l.handlers.delete(key);
      // The last: the port is let go of.
      if (!l.handlers.size && listener === l) {
        l.server.close();
        listener = null;
        listening = null;
      }
    },
  };
}

/** Connect over TCP to a device (`key`) at host:port: encrypted, and only if it proves it holds the key. */
export function dialTcp(host: string, port: number, key: string, keyPair: { publicKey: Buffer; secretKey: Buffer }): NoiseSecretStream {
  const sock = connect(port, host);
  sock.on('error', () => undefined);
  sock.setTimeout(10_000, () => sock.destroy());
  sock.write(`kuraa ${key}\n`);
  return new NoiseSecretStream(true, sock, { keyPair, remotePublicKey: Buffer.from(key, 'hex'), keepAlive: 5000 });
}

/** `host:port`, as said: an address to connect to. */
export function parseAddress(s: unknown): { host: string; port: number } | null {
  if (typeof s !== 'string' || s.length > 300) return null;
  const m = /^(\[[0-9a-fA-F:.]+\]|[^\s:/[\]]+):(\d{1,5})$/.exec(s);
  if (!m) return null;
  const port = Number(m[2]);
  if (!port || port > 65535) return null;
  return { host: m[1]!.replace(/^\[|\]$/g, ''), port };
}
