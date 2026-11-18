// A hub: one server, one address and token, many workspaces (see
// docs/decisions/0029-hub.md).
//
// The hub runs a host for each of its workspaces, inside this process, each on
// a loopback port of its own, and passes `/w/<id>/…` to it (HTTP and the
// WebSocket alike), so a workspace's client talks to `<hub>/w/<id>` exactly as it
// would to a host of its own. The hub's own API, under `/hub/api`, lists the
// workspaces and adds them: a new folder (made a git repository), or a
// workspace joined from an invitation or subscription link.
//
// What may be added is the operator's to decide, as everything about a host is:
// new workspaces go only in the folder the hub was started with (--workspaces).
// The desktop app, being its own operator, also adds folders the person picks.
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import type { AddressInfo } from 'node:net';
import { basename, dirname, join, resolve } from 'node:path';
import { HttpError, type HostOptions } from './host.js';
import { serveStaticFrom, tokenOf } from './http.js';
import { initWorkspace, inspectFolder } from './workspace.js';
import type { PeerOptions } from './peers/peers.js';
import { startHost, joinWorkspace, type RunningHost } from './index.js';

export interface HubOptions {
  /** Where new workspaces are made, one folder each. */
  root: string;
  /** Where the hub keeps its list of workspaces. Default: `<root>/.kuraa-workspaces.json`. */
  registry?: string;
  token?: string;
  host?: string;
  port?: number;
  /** The built web client, served at `/`. */
  staticDir?: string;
  /** For every workspace's host: formats, running code, timings, identity, logging. */
  hosts?: Omit<HostOptions, 'dir' | 'token' | 'host' | 'port' | 'staticDir' | 'label' | 'peers' | 'init'>;
  /**
   * Syncing with other devices: for workspaces joined from an invitation or link
   * (always), and for the others when `everywhere` is set (--peer).
   */
  peers?: PeerOptions & { everywhere?: boolean };
  /** What this device is called to other devices, for workspaces it joins. */
  deviceName?: string;
  log?: (m: string) => void;
}

/** A workspace as the hub keeps it. */
interface Entry {
  id: string;
  name: string;
  dir: string;
  /** It syncs with other devices. */
  peers: boolean;
  added: string;
}

/** A workspace as the API shows it. */
export interface HubWorkspace {
  id: string;
  name: string;
  /** Its folder. */
  path: string;
  peers: boolean;
  /** Why it is not open, if it is not. */
  error?: string;
}

/** An id and folder name from a name: lowercase letters, digits and hyphens. */
export function slugOf(name: string): string {
  const slug = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return slug || 'workspace';
}

export class Hub {
  private entries: Entry[] = [];
  private readonly hosts = new Map<string, RunningHost>();
  private readonly errors = new Map<string, string>();
  private server: Server | null = null;
  readonly token: string;
  readonly root: string;
  private readonly registry: string;
  /** WebSockets passed through to workspaces: closed with the hub (the server does not track them). */
  private readonly tunnels = new Set<import('node:net').Socket>();
  /** Adding and removing, one at a time. */
  private queue: Promise<unknown> = Promise.resolve();
  address: AddressInfo | null = null;

  constructor(readonly o: HubOptions) {
    this.root = resolve(o.root);
    this.registry = o.registry ?? join(this.root, '.kuraa-workspaces.json');
    this.token = o.token ?? randomBytes(18).toString('base64url');
  }

  private log(m: string): void {
    this.o.log?.(m);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async start(): Promise<AddressInfo> {
    await mkdir(this.root, { recursive: true });
    try {
      this.entries = JSON.parse(await readFile(this.registry, 'utf8')) as Entry[];
    } catch {
      this.entries = [];
    }
    for (const e of this.entries) await this.open(e);
    this.server = createServer((req, res) => void this.handle(req, res));
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket as import('node:net').Socket, head));
    await new Promise<void>((resolveListen, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.o.port ?? 0, this.o.host ?? '127.0.0.1', () => resolveListen());
    });
    this.address = this.server.address() as AddressInfo;
    this.log(`hub serving ${this.entries.length} workspace${this.entries.length === 1 ? '' : 's'} from ${this.root} on http://${this.address.address}:${this.address.port}`);
    return this.address;
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.registry), { recursive: true });
    const tmp = `${this.registry}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(this.entries, null, 2));
    await rename(tmp, this.registry);
  }

  /** Start a workspace's host. A workspace that cannot open is listed with why. */
  private async open(e: Entry): Promise<void> {
    try {
      if (!existsSync(e.dir)) throw new Error(`Its folder is gone: ${e.dir}`);
      const peers = e.peers ? { bootstrap: this.o.peers?.bootstrap, maxFetchBytes: this.o.peers?.maxFetchBytes, remoteSyncMs: this.o.peers?.remoteSyncMs } : undefined;
      const h = await startHost({ ...this.o.hosts, dir: e.dir, label: e.name, token: this.token, host: '127.0.0.1', port: 0, peers, log: (m) => this.log(`[${e.id}] ${m}`) });
      this.hosts.set(e.id, h);
      this.errors.delete(e.id);
    } catch (err) {
      this.errors.set(e.id, (err as Error).message);
      this.log(`[${e.id}] could not open: ${(err as Error).message}`);
    }
  }

  list(): HubWorkspace[] {
    return this.entries.map((e) => ({ id: e.id, name: e.name, path: e.dir, peers: e.peers, ...(this.errors.has(e.id) ? { error: this.errors.get(e.id) } : {}) }));
  }

  private freeId(name: string): string {
    const base = slugOf(name);
    let id = base;
    for (let i = 2; this.entries.some((e) => e.id === id) || existsSync(join(this.root, id)); i++) id = `${base}-${i}`;
    return id;
  }

  private async add(e: Entry): Promise<HubWorkspace> {
    this.entries.push(e);
    await this.save();
    await this.open(e);
    this.log(`added workspace ${e.name} (${e.dir})`);
    return this.list().find((w) => w.id === e.id)!;
  }

  /** A new workspace: a new folder in the hub's folder, made a git repository. */
  create(name: string): Promise<HubWorkspace> {
    return this.serial(async () => {
      const label = name.trim();
      if (!label) throw new HttpError(400, 'A workspace needs a name');
      const id = this.freeId(label);
      const dir = join(this.root, id);
      await mkdir(dir, { recursive: true });
      await initWorkspace(dir);
      return this.add({ id, name: label, dir, peers: !!this.o.peers?.everywhere, added: new Date().toISOString() });
    });
  }

  /** A workspace joined from an invitation or subscription link, into a new folder in the hub's folder. */
  join(invitation: string, name: string): Promise<HubWorkspace> {
    return this.serial(async () => {
      const label = name.trim() || 'Shared workspace';
      const id = this.freeId(label);
      const dir = join(this.root, id);
      try {
        await joinWorkspace({ dir, invitation, name: this.o.deviceName, bootstrap: this.o.peers?.bootstrap, log: (m) => this.log(`[${id}] ${m}`) });
      } catch (err) {
        // Leave nothing half-made behind.
        await rm(dir, { recursive: true, force: true });
        throw new HttpError(400, (err as Error).message);
      }
      return this.add({ id, name: label, dir, peers: true, added: new Date().toISOString() });
    });
  }

  /**
   * A folder that is already there (the desktop app, for a folder the person
   * picked): added as it is, made a git repository first if `init`.
   */
  addFolder(folder: string, init = false): Promise<HubWorkspace> {
    return this.serial(async () => {
      const info = await inspectFolder(folder);
      const dir = info.repoRoot ?? info.dir;
      const known = this.entries.find((e) => resolve(e.dir) === resolve(dir));
      if (known) return this.list().find((w) => w.id === known.id)!;
      if (!info.repoRoot) {
        if (!init) throw new HttpError(400, `${dir} is not a git repository`);
        await initWorkspace(dir);
      }
      const name = basename(dir);
      return this.add({ id: this.freeId(name), name, dir, peers: !!this.o.peers?.everywhere, added: new Date().toISOString() });
    });
  }

  /** Take a workspace off the list and close it. Its folder stays as it is. */
  remove(id: string): Promise<void> {
    return this.serial(async () => {
      const e = this.entries.find((x) => x.id === id);
      if (!e) throw new HttpError(404, `No workspace ${id}`);
      await this.hosts.get(id)?.close();
      this.hosts.delete(id);
      this.errors.delete(id);
      this.entries = this.entries.filter((x) => x !== e);
      await this.save();
      this.log(`removed workspace ${e.name} from the list (its folder stays: ${e.dir})`);
    });
  }

  /** The host of a workspace, by id. */
  hostOf(id: string): RunningHost | undefined {
    return this.hosts.get(id);
  }

  // HTTP ----------------------------------------------------------------------

  private send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  private async body(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as Record<string, unknown>;
    } catch {
      throw new HttpError(400, 'Invalid JSON');
    }
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const w = /^\/w\/([a-z0-9-]+)(\/.*)?$/.exec(url.pathname);
    try {
      if (w) return this.proxy(req, res, w[1]!, `${w[2] ?? '/'}${url.search}`);
      if (url.pathname.startsWith('/hub/api/')) {
        if (tokenOf(req) !== this.token) return this.send(res, 401, { error: 'Unauthorized' });
        return await this.api(req, res, url);
      }
      // A client that asks a hub for one workspace's API is told this is a hub.
      if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/git')) return this.send(res, 404, { error: 'This is a hub: workspaces are under /w/<id>', hub: true });
      serveStaticFrom(this.o.staticDir, url.pathname, res);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (!res.headersSent) this.send(res, status, { error: (err as Error).message });
      else res.end();
    }
  }

  private async api(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /hub/api/workspaces') return this.send(res, 200, { workspaces: this.list() });
    if (route === 'POST /hub/api/workspaces') {
      const b = await this.body(req);
      if (b.kind === 'new') return this.send(res, 201, { workspace: await this.create(String(b.name ?? '')) });
      if (b.kind === 'join') {
        if (typeof b.invitation !== 'string' || !b.invitation.trim()) throw new HttpError(400, 'Paste an invitation or subscription link');
        return this.send(res, 201, { workspace: await this.join(b.invitation, String(b.name ?? '')) });
      }
      throw new HttpError(400, 'Add a new workspace (kind: new) or join one (kind: join)');
    }
    const one = /^\/hub\/api\/workspaces\/([a-z0-9-]+)$/.exec(url.pathname);
    if (one && req.method === 'DELETE') {
      await this.remove(one[1]!);
      return this.send(res, 200, { ok: true });
    }
    throw new HttpError(404, `No route: ${route}`);
  }

  /** Pass a request to a workspace's host, as if it had come to it. */
  private proxy(req: IncomingMessage, res: ServerResponse, id: string, path: string): void {
    const h = this.hosts.get(id);
    if (!h) return this.send(res, this.entries.some((e) => e.id === id) ? 503 : 404, { error: this.errors.get(id) ?? `No workspace ${id}` });
    const target = new URL(h.url);
    const out = request({ host: target.hostname, port: target.port, method: req.method, path, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.pipe(res);
    });
    out.on('error', (e) => {
      if (!res.headersSent) this.send(res, 502, { error: e.message });
      else res.destroy();
    });
    req.pipe(out);
  }

  /** WebSockets (a workspace's rooms): the upgrade request, rewritten, then the bytes both ways. */
  private upgrade(req: IncomingMessage, socket: import('node:net').Socket, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const w = /^\/w\/([a-z0-9-]+)(\/.*)$/.exec(url.pathname);
    const h = w && this.hosts.get(w[1]!);
    if (!h) return void socket.destroy();
    const target = new URL(h.url);
    const upstream = connect(Number(target.port), target.hostname, () => {
      const lines = [`${req.method} ${w[2]}${url.search} HTTP/${req.httpVersion}`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
    });
    this.tunnels.add(socket);
    this.tunnels.add(upstream);
    const end = () => {
      upstream.destroy();
      socket.destroy();
      this.tunnels.delete(socket);
      this.tunnels.delete(upstream);
    };
    upstream.on('error', end);
    socket.on('error', end);
    upstream.on('close', end);
    socket.on('close', end);
  }

  async close(): Promise<void> {
    const closed = new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server?.closeAllConnections();
    for (const s of this.tunnels) s.destroy();
    this.tunnels.clear();
    await closed;
    await Promise.all([...this.hosts.values()].map((h) => h.close().catch(() => undefined)));
    this.hosts.clear();
  }
}

export interface RunningHub {
  hub: Hub;
  url: string;
  token: string;
  close(): Promise<void>;
}

/** Start a hub on a folder of workspaces. */
export async function startHub(options: HubOptions): Promise<RunningHub> {
  const hub = new Hub(options);
  const addr = await hub.start();
  const hostname = addr.address.includes(':') ? `[${addr.address}]` : addr.address;
  return { hub, url: `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${addr.port}`, token: hub.token, close: () => hub.close() };
}
