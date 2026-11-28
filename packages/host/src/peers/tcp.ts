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
  handlers: Map<string, TcpHandler>;
}

let listening: Promise<Listener | null> | null = null;
let listener: Listener | null = null;

function open(port: number, log: (m: string) => void): Promise<Listener | null> {
  return new Promise((resolve) => {
    const handlers = new Map<string, TcpHandler>();
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
/** Connections that have not said which device they are for yet: at most this many, and this many from one address (0099). */
const MAX_WAITING = 256;
const MAX_WAITING_FROM = 16;
/** How long a connection has, from when it is taken, to say which device it is for (0112): a deadline, not an idle time. */
const PRELUDE_MS = 5000;
/**
 * And then to be let in (0115): the encrypted handshake and the hello, counted
 * all the while, under a deadline no byte puts off. A device in is let in at
 * once; one that is not, is held no longer.
 */
const LET_IN_MS = 15_000;
/** The connections waiting (to say which device, or to be let in), oldest first, each with how to stop counting it. */
const waiting = new Map<Socket, () => void>();
const waitingFrom = new Map<string, number>();

/**
 * Where a connection is from, as the limits count it (0112): an IPv4 address as
 * it is; an IPv6 one by its first 64 bits, which a single network is given
 * whole, so one holder of a /64 counts as one, not as 2^64.
 */
export function addressGroup(addr: string): string {
  const v4 = /^(?:::ffff:)?(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
  if (v4) return v4[1]!;
  if (!addr.includes(':')) return addr;
  // Expand :: to the missing groups, then keep the first four.
  const [head, tail = ''] = addr.split('%')[0]!.split('::') as [string, string?];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const groups = addr.includes('::') ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t] : h;
  return `${groups.slice(0, 4).map((g) => (parseInt(g || '0', 16) || 0).toString(16)).join(':')}::/64`;
}

/**
 * A device's handler for a connection: the socket, and `settled`, to say it has
 * been let in (0115), after which it is no longer counted nor held to a deadline.
 */
export type TcpHandler = (sock: Socket, settled: () => void) => void;

function accept(sock: Socket, handlers: Map<string, TcpHandler>): void {
  sock.on('error', () => undefined);
  // A server's port is open to anyone (0099): connections not let in hold a socket each, so only so many; each
  // address, only so many of those; and when all are taken, the one waiting longest makes way (0112), as an honest
  // device says which device it is for at once, and is let in at its hello. Counted until it is let in (0115), not
  // only until its first line: else a handshake begun and never ended held a socket for nothing.
  const from = addressGroup(sock.remoteAddress ?? '');
  if ((waitingFrom.get(from) ?? 0) >= MAX_WAITING_FROM) return void sock.destroy();
  if (waiting.size >= MAX_WAITING) {
    const [oldest, stop] = waiting.entries().next().value!;
    stop();
    oldest.destroy();
  }
  let counted = true;
  let deadline = setTimeout(() => sock.destroy(), PRELUDE_MS);
  deadline.unref?.();
  const done = () => {
    if (!counted) return;
    counted = false;
    clearTimeout(deadline);
    waiting.delete(sock);
    const left = (waitingFrom.get(from) ?? 1) - 1;
    if (left) waitingFrom.set(from, left);
    else waitingFrom.delete(from);
  };
  waiting.set(sock, done);
  waitingFrom.set(from, (waitingFrom.get(from) ?? 0) + 1);
  sock.once('close', done);
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
      // Said which device: now to be let in, by a deadline of its own.
      clearTimeout(deadline);
      deadline = setTimeout(() => sock.destroy(), LET_IN_MS);
      deadline.unref?.();
      return handler(sock, done);
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
export async function listenTcp(key: string, port: number | undefined, onSocket: TcpHandler, log: (m: string) => void): Promise<{ port: number; stop(): void } | null> {
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
