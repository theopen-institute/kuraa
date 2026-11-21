// Git reaching other devices: a git remote helper for `kuraa://<device key>`
// URLs, so peers are ordinary git remotes (`git fetch laptop`, `laptop/main`).
//
// Git runs `git-remote-kuraa`, found in .git/kuraa/bin (the host puts it on
// git's PATH; on the command line, add that folder to PATH). The helper asks the
// running host, over a local TCP socket guarded by a token, for a stream to the
// device's `git upload-pack`, and passes git's protocol through it. Only fetching
// is possible: a device never writes to another's repository; each brings what
// it fetched into its own branches.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import type { Duplex } from 'node:stream';
import { KURAA_SCHEME } from './identity.js';

/** The helper, as plain JavaScript with no imports beyond Node's, so any Node (or Electron as Node) runs it. */
const HELPER = String.raw`// git-remote-kuraa: written by the kuraa host. Fetches from paired devices through it.
import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const url = process.argv[3] || '';
const gitDir = process.env.GIT_DIR || '.git';
let peer;
try {
  peer = JSON.parse(readFileSync(join(gitDir, 'kuraa', 'peer.json'), 'utf8'));
} catch {
  process.stderr.write('kuraa: the kuraa host is not running for this repository (no ' + join(gitDir, 'kuraa', 'peer.json') + ')\n');
  process.exit(1);
}
let buf = Buffer.alloc(0);
let piping = null;
process.stdin.on('data', (d) => {
  if (piping) return piping.write(d);
  buf = Buffer.concat([buf, d]);
  for (;;) {
    const nl = buf.indexOf(10);
    if (nl < 0) return;
    const line = buf.subarray(0, nl).toString('utf8');
    buf = buf.subarray(nl + 1);
    if (line === 'capabilities') process.stdout.write('connect\n\n');
    else if (line.startsWith('connect ')) return start(line.slice(8));
    else if (line === '') process.exit(0);
    else { process.stderr.write('kuraa: unsupported: ' + line + '\n'); process.exit(1); }
  }
});
// Git is done with the connection (or went away): close it, and be done.
process.stdin.on('end', () => { if (piping) piping.end(); else process.exit(0); });
function start(service) {
  const sock = connect(peer.port, '127.0.0.1');
  let head = Buffer.alloc(0);
  let open = false;
  sock.write(JSON.stringify({ token: peer.token, url, service, protocol: process.env.GIT_PROTOCOL || '' }) + '\n');
  sock.on('data', (d) => {
    if (open) return process.stdout.write(d);
    head = Buffer.concat([head, d]);
    const nl = head.indexOf(10);
    if (nl < 0) return;
    const answer = head.subarray(0, nl).toString('utf8');
    if (answer !== 'ok') { process.stderr.write('kuraa: ' + answer.replace(/^error /, '') + '\n'); process.exit(1); }
    open = true;
    process.stdout.write('\n');
    const rest = head.subarray(nl + 1);
    if (rest.length) process.stdout.write(rest);
    piping = sock;
    if (buf.length) sock.write(buf);
  });
  // The other end is done (or the host stopped): pass on what came, then exit. Ending stdout alone
  // would not close it, and git would wait for more for ever.
  sock.on('close', () => process.stdout.write('', () => process.exit(open ? 0 : 1)));
  sock.on('error', (e) => { process.stderr.write('kuraa: ' + e.message + '\n'); process.exit(1); });
}
`;

export interface BridgeOptions {
  /** .git/kuraa */
  stateDir: string;
  /** A stream to a device's git service, or why there is none. */
  open(key: string, service: string, protocol: string): Duplex | string;
  /** The most one fetch may bring, in bytes. */
  maxBytes: number;
  log(m: string): void;
}

export class GitBridge {
  private server: Server | null = null;
  /** Connections from git's helper, closed when the host stops, so no fetch is left waiting. */
  private readonly sockets = new Set<Socket>();
  private readonly token = randomBytes(24).toString('hex');

  constructor(private readonly o: BridgeOptions) {}

  /** Where the helper is: put it first on git's PATH. */
  get binDir(): string {
    return join(this.o.stateDir, 'bin');
  }

  async start(): Promise<void> {
    await mkdir(this.binDir, { recursive: true });
    await writeFile(join(this.binDir, 'git-remote-kuraa.mjs'), HELPER);
    // Electron runs as Node with ELECTRON_RUN_AS_NODE; plain Node ignores it.
    // On Windows, Git for Windows runs the script with its own sh, which takes C:/… paths.
    const self = process.platform === 'win32' ? process.execPath.replace(/\\/g, '/') : process.execPath;
    const launcher = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${self}" "$(dirname "$0")/git-remote-kuraa.mjs" "$@"\n`;
    await writeFile(join(this.binDir, 'git-remote-kuraa'), launcher);
    await chmod(join(this.binDir, 'git-remote-kuraa'), 0o755);
    this.server = createServer((sock) => {
      this.sockets.add(sock);
      sock.on('close', () => this.sockets.delete(sock));
      this.serve(sock);
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    const port = (this.server.address() as { port: number }).port;
    await writeFile(join(this.o.stateDir, 'peer.json'), JSON.stringify({ port, token: this.token }), { mode: 0o600 });
  }

  private serve(sock: Socket): void {
    let head = Buffer.alloc(0);
    const onData = (d: Buffer) => {
      head = Buffer.concat([head, d]);
      const nl = head.indexOf(10);
      if (nl < 0) {
        if (head.length > 4096) sock.destroy();
        return;
      }
      sock.off('data', onData);
      let req: { token?: unknown; url?: unknown; service?: unknown; protocol?: unknown };
      try {
        req = JSON.parse(head.subarray(0, nl).toString('utf8')) as typeof req;
      } catch {
        return void sock.destroy();
      }
      const rest = head.subarray(nl + 1);
      if (req.token !== this.token) return void sock.destroy();
      const url = String(req.url ?? '');
      const service = String(req.service ?? '');
      if (!url.startsWith(KURAA_SCHEME)) return void sock.end(`error not a kuraa:// URL: ${url}\n`);
      if (service !== 'git-upload-pack') return void sock.end(`error devices only fetch from each other (not ${service})\n`);
      const protocol = /^version=\d$/.test(String(req.protocol)) ? String(req.protocol) : '';
      const stream = this.o.open(url.slice(KURAA_SCHEME.length).replace(/\/$/, ''), service, protocol);
      if (typeof stream === 'string') return void sock.end(`error ${stream}\n`);
      sock.write('ok\n');
      if (rest.length) stream.write(rest);
      let bytes = 0;
      stream.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > this.o.maxBytes) {
          this.o.log(`a fetch from ${url} passed ${this.o.maxBytes} bytes; stopped`);
          stream.destroy();
          sock.destroy();
          return;
        }
        // git reading slowly: the device waits (link.ts), rather than its pack piling up here.
        if (!sock.write(chunk)) stream.pause();
      });
      sock.on('drain', () => stream.resume());
      stream.on('end', () => sock.end());
      stream.on('error', () => sock.destroy());
      stream.on('close', () => sock.end());
      sock.on('data', (chunk: Buffer) => {
        if (!stream.write(chunk)) sock.pause();
      });
      stream.on('drain', () => sock.resume());
      sock.on('end', () => stream.end());
      sock.on('error', () => stream.destroy());
    };
    sock.on('data', onData);
    sock.on('error', () => undefined);
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    for (const sock of this.sockets) sock.destroy();
    await closed;
    await rm(join(this.o.stateDir, 'peer.json'), { force: true });
  }
}
