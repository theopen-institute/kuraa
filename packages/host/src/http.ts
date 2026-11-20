// The host's HTTP surface. Every /api and /git request needs the workspace token.
//
// The API is a table of routes, grouped by what they are about (the workspace,
// running code, files, history, devices). A route is a method, a path (exact, or
// a pattern whose groups the handler reads), and a handler given the request in
// a context.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync, lstatSync, statSync, createReadStream } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { ChunkRef, PresenceUser } from '@kuraa/session/server';
import type { Host } from './host.js';
import { MERGE_AUTHOR } from './merging.js';
import { HttpError } from './errors.js';
import { renameOver, unportablePath } from './files.js';
import { renderRoutes, searchRoutes } from './render-routes.js';
import { writingRoutes } from './writing.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

/** The most a JSON request body may be. Files are made with their content in one, so it is generous. */
const MAX_BODY = 64 * 1024 * 1024;

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request too large');
    chunks.push(c as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

/** The URL to reach a server listening at an address, from this computer. */
export function localUrl(addr: AddressInfo): string {
  const hostname = addr.address.includes(':') ? `[${addr.address}]` : addr.address;
  return `http://${hostname === '0.0.0.0' ? '127.0.0.1' : hostname}:${addr.port}`;
}

export function tokenOf(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (auth.startsWith('Basic ')) {
    // git sends the token as the password of HTTP basic auth.
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  return null;
}

/** Whether a token given matches, in time that does not depend on where they differ. */
export function sameToken(given: string | null | undefined, token: string): boolean {
  if (typeof given !== 'string') return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(given), digest(token));
}

/** Whether something is at a path, a link (even one pointing nowhere) included. */
function lexists(abs: string): boolean {
  try {
    lstatSync(abs);
    return true;
  } catch {
    return false;
  }
}

/** Refuse a new name that some computer the workspace goes to could not hold (files.ts). */
function checkPortable(path: string): void {
  const why = unportablePath(path);
  if (why) throw new HttpError(400, why);
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `Missing ${name}`);
  return v;
}

/** Who asked, as the client says: a name, an email (for credit) and a colour. Null without a name, unless `anonymous` stands in. */
function personOf(v: unknown, anonymous?: string): PresenceUser | null {
  const by = (v && typeof v === 'object' ? v : {}) as { name?: unknown; email?: unknown; color?: unknown };
  const name = typeof by.name === 'string' ? by.name : anonymous;
  if (name === undefined) return null;
  return { name, email: typeof by.email === 'string' ? by.email : '', color: typeof by.color === 'string' ? by.color : '#888888' };
}

/** A chunk a request names, to clear its outputs; absent (or null) for every chunk. Anything else is refused. */
function chunkRefOf(v: unknown): ChunkRef | undefined {
  if (v === undefined || v === null) return undefined;
  const c = v as { label?: unknown; index?: unknown; codeHash?: unknown };
  if (typeof c !== 'object' || typeof c.index !== 'number' || typeof c.codeHash !== 'string' || (c.label !== null && typeof c.label !== 'string')) throw new HttpError(400, 'Not a chunk');
  return { label: c.label, index: c.index, codeHash: c.codeHash };
}

// ---------------------------------------------------------------------------
// Routes

export interface Context {
  host: Host;
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  q: URLSearchParams;
  /** The groups of a pattern path. */
  params: string[];
}

export interface Route {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string | RegExp;
  handle(c: Context): Promise<void> | void;
}

const route = (method: Route['method'], path: Route['path'], handle: Route['handle']): Route => ({ method, path, handle });

function requireRunning(host: Host, hint = ''): void {
  if (!host.runner.enabled) throw new HttpError(403, `Running code is turned off on this server.${hint}`);
}

const workspaceRoutes: Route[] = [
  route('GET', '/api/workspace', async ({ host, res }) => send(res, 200, {
    name: host.options.label ?? host.workspace,
    branch: await host.git.branch(),
    head: await host.git.head(),
    types: host.registry.all().map((t) => ({ id: t.id, label: t.label, version: t.version })),
    run: await host.runner.describe(),
  })),

  // Components: which engines and formats are on. Set by the host's flags; the app only shows them.
  route('GET', '/api/components', async ({ host, res }) => send(res, 200, await host.components())),

  route('GET', '/api/rooms', async ({ host, res, q }) => {
    const rec = await host.room(str(q.get('path'), 'path'));
    send(res, 200, host.describe(rec));
  }),

  route('POST', '/api/versions', async ({ host, req, res }) => {
    const body = await readBody(req);
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : undefined;
    if (typeof body.path === 'string' && body.path) {
      const rec = await host.room(body.path);
      return send(res, 200, { commit: await host.commitRoom(rec, message) });
    }
    await host.serial(() => host.commitAll(message));
    send(res, 200, { commit: await host.git.head() });
  }),

  route('POST', '/api/sync', async ({ host, res }) => {
    const result = await host.syncNow();
    send(res, result.ok ? 200 : 409, result);
  }),
];

// Running chunks (see runner.ts): progress and outputs reach clients as room
// messages. Packages for an engine (R): declared per workspace, stored once per host.
const runRoutes: Route[] = [
  route('GET', '/api/packages', async ({ host, res, q }) => {
    requireRunning(host);
    send(res, 200, { packages: await host.runner.listPackages(str(q.get('engine'), 'engine')) });
  }),

  ...(['install', 'remove'] as const).map((op) => route('POST', `/api/packages/${op}`, async ({ host, req, res }) => {
    requireRunning(host);
    const body = await readBody(req);
    const engine = str(body.engine, 'engine');
    const list = Array.isArray(body.refs) ? body.refs : Array.isArray(body.names) ? body.names : [];
    const names = list.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200);
    const user = personOf(body.by);
    const result = op === 'install' ? await host.runner.installPackages(engine, names, user) : await host.runner.removePackages(engine, names, user);
    send(res, result.ok ? 200 : 422, result);
  })),

  route('GET', '/api/runs', async ({ host, res, q }) => {
    const path = host.relPath(str(q.get('path'), 'path'));
    send(res, 200, { runs: await host.runner.outputs(path), pending: host.runner.pending(path), session: host.runner.session(path) });
  }),

  route('POST', '/api/runs', async ({ host, req, res }) => {
    requireRunning(host, ' Whoever runs the server can turn it on.');
    const body = await readBody(req);
    const path = host.relPath(str(body.path, 'path'));
    const engine = host.runner.engineFor(String(body.engine ?? ''));
    if (!engine) throw new HttpError(400, `Nothing on this server runs ${String(body.engine)} chunks.`);
    const { environment } = await host.runner.describe();
    if (!environment?.available) throw new HttpError(503, environment?.message ?? 'No environment to run code in.');
    const chunk = body.chunk as { label?: unknown; index?: unknown; codeHash?: unknown; partial?: unknown } | undefined;
    if (!chunk || typeof chunk.index !== 'number' || typeof chunk.codeHash !== 'string') throw new HttpError(400, 'Missing chunk');
    const record = host.runner.run(path, {
      engine,
      code: typeof body.code === 'string' ? body.code : '',
      header: typeof body.header === 'string' ? body.header : 'r',
      chunk: { label: typeof chunk.label === 'string' ? chunk.label : null, index: chunk.index, codeHash: chunk.codeHash, partial: chunk.partial === true },
      by: personOf(body.by, 'Anonymous')!,
    });
    send(res, 202, record);
  }),

  ...(['interrupt', 'restart', 'clear'] as const).map((op) => route('POST', `/api/runs/${op}`, async ({ host, req, res }) => {
    requireRunning(host, ' Whoever runs the server can turn it on.');
    const body = await readBody(req);
    const path = host.relPath(str(body.path, 'path'));
    if (op === 'interrupt') host.runner.interrupt(path);
    else if (op === 'restart') await host.runner.restart(path);
    else await host.runner.clear(path, chunkRefOf(body.chunk));
    send(res, 200, { ok: true });
  })),
];

const fileRoutes: Route[] = [
  route('GET', '/api/tree', async ({ host, res }) => {
    const out = await host.git.out(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    const branch = await host.git.branch();
    const paths = [...new Set(out.split('\0').filter(Boolean))].sort();
    // Documents are shown by their title: null if one has none, absent for files that are not documents.
    const files = await host.treeEntries(paths, branch);
    send(res, 200, { files });
  }),

  route('GET', '/api/files', ({ host, res, q }) => {
    const abs = host.resolvePath(host.relPath(str(q.get('path'), 'path')));
    if (!existsSync(abs) || !statSync(abs).isFile()) throw new HttpError(404, 'No such file');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    // A read that fails half-way ends the answer, not the host.
    createReadStream(abs).on('error', () => res.destroy()).pipe(res);
  }),

  route('POST', '/api/files', async ({ host, req, res }) => {
    const body = await readBody(req);
    const path = host.relPath(str(body.path, 'path'));
    checkPortable(path);
    const abs = host.resolvePath(path);
    if (existsSync(abs)) throw new HttpError(409, 'File exists');
    const content = typeof body.content === 'string' ? body.content : '';
    const commit = await host.serial(async () => {
      await host.requireWritable();
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, { flag: 'wx' });
      return host.commitPaths([path], `Create ${path}`);
    });
    send(res, 201, { path, commit });
  }),

  // A folder. git keeps no empty folders, so it gets a .gitkeep (which clients
  // hide) and is committed, so collaborators and other clones have it too.
  route('POST', '/api/folders', async ({ host, req, res }) => {
    const body = await readBody(req);
    const path = host.relPath(str(body.path, 'path')).replace(/\/+$/, '');
    if (!path) throw new HttpError(400, 'Missing path');
    checkPortable(path);
    const abs = host.resolvePath(path);
    if (existsSync(abs)) throw new HttpError(409, 'A file or folder with that name exists');
    const commit = await host.serial(async () => {
      await host.requireWritable();
      await mkdir(abs, { recursive: true });
      await writeFile(join(abs, '.gitkeep'), '');
      return host.commitPaths([`${path}/.gitkeep`], `Create folder ${path}`);
    });
    send(res, 201, { path, commit });
  }),

  // Rename or move a file or folder; for a document, optionally give it a new
  // title too (with `to` the same as `from`, only that).
  route('PATCH', '/api/files', async ({ host, req, res }) => {
    const body = await readBody(req);
    const from = host.relPath(str(body.from, 'from'), { link: 'self' });
    const to = host.relPath(str(body.to, 'to'));
    const title = typeof body.title === 'string' ? body.title.replace(/\s+/g, ' ').trim() : undefined;
    // A link is renamed itself (never what it points to).
    const absFrom = host.resolvePath(from, { link: 'self' });
    const absTo = host.resolvePath(to);
    if (!lexists(absFrom)) throw new HttpError(404, 'No such file or folder');
    if (title !== undefined) {
      await host.checkTitle(from, title);
      if (!host.typeFor(to)?.title) throw new HttpError(400, `${to} would not be a document with a title`);
    }
    if (to === from) {
      if (title === undefined) throw new HttpError(400, 'Nothing to change');
      const commit = await host.serial(async () => {
        await host.requireWritable();
        await host.setTitle(from, title);
        return host.commitPaths([from], `Retitle ${from}: ${title}`);
      });
      return send(res, 200, { from, to, commit });
    }
    checkPortable(to);
    if (existsSync(absTo)) throw new HttpError(409, `${to} already exists`);
    // A folder moves with everything in it, but never into itself.
    const isFolder = lstatSync(absFrom).isDirectory();
    if (isFolder && to.startsWith(`${from}/`)) throw new HttpError(400, 'A folder cannot move into itself');
    // Only the folder changed: a move. Otherwise (the name changed too) a rename.
    const moveOnly = dirname(from) !== dirname(to) && basename(from) === basename(to);
    const commit = await host.serial(async () => {
      await host.requireWritable();
      if (isFolder) await host.dropRoomsUnder(from);
      else await host.dropRoom(from);
      await mkdir(dirname(absTo), { recursive: true });
      await renameOver(absFrom, absTo);
      if (title !== undefined && !isFolder) await host.setTitle(to, title);
      return host.commitPaths([from, to], moveOnly ? `Move ${from} to ${dirname(to) === '.' ? 'the top level' : `${dirname(to)}/`}` : `Rename ${from} to ${to}`);
    });
    send(res, 200, { from, to, commit });
  }),

  route('DELETE', '/api/files', async ({ host, res, q }) => {
    const path = host.relPath(str(q.get('path'), 'path'), { link: 'self' });
    // A link is deleted itself (never what it points to).
    const abs = host.resolvePath(path, { link: 'self' });
    if (!lexists(abs)) throw new HttpError(404, 'No such file');
    const isFolder = lstatSync(abs).isDirectory();
    const commit = await host.serial(async () => {
      await host.requireWritable();
      // A folder's open rooms go with it.
      if (isFolder) await host.dropRoomsUnder(path);
      else await host.dropRoom(path);
      // Retried while Windows says busy (another program has a file open, for a moment).
      await rm(abs, { recursive: true, maxRetries: 5 });
      return host.commitPaths([path], `Delete ${path}`);
    });
    send(res, 200, { path, commit });
  }),
];

const historyRoutes: Route[] = [
  route('GET', '/api/history', async ({ host, res, q }) => {
    const path = host.relPath(str(q.get('path'), 'path'));
    // --follow crosses renames, so each entry also gives the path the file had in that commit
    // (from --name-only, which git prints after the formatted header).
    const log = await host.git.run(
      ['log', '--follow', '-n', '200', '--name-only', '--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1d', '--', path],
      { allowFail: true },
    );
    const commits = log.stdout.split('\x1e').filter((s) => s.trim()).map((entry) => {
      const [header = '', names = ''] = entry.split('\x1d');
      const [hash, author, email, date, subject, body = ''] = header.split('\x1f');
      const coAuthors = [...body.matchAll(/^Co-authored-by:\s*(.+?)\s*<([^>]*)>\s*$/gim)].map((m) => ({ name: m[1], email: m[2] }));
      const pathThen = names.split('\n').map((n) => n.trim()).filter(Boolean).pop() ?? path;
      // Saves the host made on its own, merges it made, or commits made otherwise (named versions, outside).
      const kind = email === MERGE_AUTHOR.email ? 'merge' : /^Kuraa-Kind:\s*autosave\s*$/im.test(body) ? 'autosave' : 'commit';
      return { hash, author, email, date, subject, coAuthors, path: pathThen, kind };
    });
    send(res, 200, { commits });
  }),

  route('GET', /^\/api\/history\/([0-9a-f]{4,40})$/, async ({ host, res, q, params }) => {
    const path = host.relPath(str(q.get('path'), 'path'));
    const r = await host.git.run(['show', `${params[0]}:${path}`], { allowFail: true });
    if (r.code !== 0) throw new HttpError(404, 'Not found at that commit');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(r.stdout);
  }),
];

// The workspace's devices, as the app shows them: who this device is, and which are
// paired and connected. Where the operator allows it (canInvite), people using the
// app make and revoke invite links, remove devices and rename this one: every
// member has the same say (0038).
// You on this computer (peers/person.ts, 0035), where the one running the host uses it
// (managePerson: a hub on loopback, 0047): this computer's signing key, your identity if it is here, and your keys
// the workspace knows of.
const personKeys = () => import('./peers/person.js');
const hostPerson = async (host: Host) => {
  if (!host.options.managePerson) throw new HttpError(404, 'Your identity is managed only on the computer running this server, while it is not open to the network');
  const keys = await personKeys();
  const p = await keys.readPerson();
  const known = p && host.peers ? (await host.peers.node.identity.people()).find((x) => x.key === p.publicKey.toString('hex'))?.keys ?? [] : [];
  return keys.personInfo(known);
};
/**
 * Made, imported or revoked: said now by every workspace that syncs (the hub tells
 * them all, through personChanged), or by this one alone if the host is on its own.
 */
const personChanged = async (host: Host) => {
  if (host.options.personChanged) await host.options.personChanged();
  else await host.peers?.node.signingKey();
};
const keysDo = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
};

const personRoutes: Route[] = [
  route('GET', '/api/person', async ({ host, res }) => send(res, 200, { person: await hostPerson(host) })),
  route('POST', '/api/person', async ({ host, req, res }) => {
    await hostPerson(host);
    const name = str((await readBody(req)).name, 'name');
    await keysDo(async () => (await personKeys()).createPerson(name));
    await personChanged(host);
    send(res, 201, { person: await hostPerson(host) });
  }),
  route('POST', '/api/person/import', async ({ host, req, res }) => {
    await hostPerson(host);
    const line = str((await readBody(req)).line, 'line');
    await keysDo(async () => (await personKeys()).importPerson(line));
    await personChanged(host);
    send(res, 200, { person: await hostPerson(host) });
  }),
  route('POST', '/api/person/revoke', async ({ host, req, res }) => {
    await hostPerson(host);
    const key = str((await readBody(req)).key, 'key');
    await keysDo(async () => (await personKeys()).revokeKey(key));
    await personChanged(host);
    send(res, 200, { person: await hostPerson(host) });
  }),
  route('GET', '/api/person/export', async ({ host, res }) => {
    await hostPerson(host);
    const keys = await personKeys();
    const p = await keys.readPerson();
    if (!p) throw new HttpError(404, 'Your identity is not on this computer');
    send(res, 200, { line: keys.exportPerson(p) });
  }),
];

// Online copies (backups.ts): git servers this workspace keeps a copy on, and syncs with. Everyone
// sees them (Sync syncs with them); adding and removing them is for the one running the host (manageOnline).
const mayManageOnline = (host: Host) => {
  if (!host.options.manageOnline) throw new HttpError(403, 'The online copy is set up only on the computer running this server, while it is not open to the network');
};
const onlineRoutes: Route[] = [
  route('GET', '/api/online', async ({ host, res }) => send(res, 200, { canManage: !!host.options.manageOnline, copies: await host.online.list() })),
  route('POST', '/api/online', async ({ host, req, res }) => {
    mayManageOnline(host);
    const target = str((await readBody(req)).target, 'target');
    try {
      await host.online.add(target);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    send(res, 201, { copies: await host.online.list() });
  }),
  route('DELETE', /^\/api\/online\/([A-Za-z0-9._-]+)$/, async ({ host, res, params }) => {
    mayManageOnline(host);
    try {
      await host.online.remove(params[0]!);
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
    send(res, 200, { copies: await host.online.list() });
  }),
];

const peerRoutes: Route[] = [
  route('GET', '/api/peers', async ({ host, res }) => {
    const canInvite = !!host.options.invites;
    send(res, 200, host.peers ? { enabled: true, canInvite, ...(await host.peers.status()) } : { enabled: false, canInvite });
  }),

  route('GET', '/api/peers/links', async ({ host, res }) => {
    if (!host.options.invites) throw new HttpError(403, 'Making invitations from the app is turned off on this server');
    send(res, 200, { links: host.peers ? await host.peers.links() : [] });
  }),

  route('POST', '/api/peers/links', async ({ host, req, res }) => {
    const body = await readBody(req);
    const hours = body.hours === null ? null : Number(body.hours);
    if (hours !== null && !(hours > 0 && hours <= 24 * 366)) throw new HttpError(400, 'A link lasts some hours (up to a year), or has no expiry (null)');
    const peers = await host.peersForInvites();
    const link = await peers.inviteLink({ hours, once: body.once === true });
    send(res, 201, { link, ...(await peers.links()).at(-1)! });
  }),

  route('DELETE', /^\/api\/peers\/links\/([0-9a-f]{16})$/, async ({ host, res, params }) => {
    const peers = await host.peersForInvites();
    await peers.revokeLink(params[0]!);
    send(res, 200, { ok: true });
  }),

  // Removing a device: permanent, passed on to every device; it keeps its copy.
  route('DELETE', /^\/api\/peers\/devices\/([0-9a-f]{64})$/, async ({ host, res, params }) => {
    const peers = await host.peersForInvites();
    try {
      await peers.removeDevice(params[0]!);
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
    send(res, 200, { ok: true });
  }),

  route('POST', '/api/peers/name', async ({ host, req, res }) => {
    const peers = await host.peersForInvites();
    try {
      await peers.rename(str((await readBody(req)).name, 'name'));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    send(res, 200, { name: peers.node.name });
  }),
];

const ROUTES: Route[] = [...workspaceRoutes, ...runRoutes, ...renderRoutes, ...searchRoutes, ...fileRoutes, ...historyRoutes, ...peerRoutes, ...personRoutes, ...onlineRoutes, ...writingRoutes];

/** The route for a request, and the groups of its path. */
function findRoute(method: string, path: string): { route: Route; params: string[] } | null {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    if (typeof r.path === 'string') {
      if (r.path === path) return { route: r, params: [] };
      continue;
    }
    const m = r.path.exec(path);
    if (m) return { route: r, params: m.slice(1) };
  }
  return null;
}

export function createRequestHandler(host: Host) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    const isApi = path.startsWith('/api/');
    const isGit = path === '/git' || path.startsWith('/git/');

    // Allow a web client served from another origin (e.g. the Vite dev server).
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('access-control-allow-headers', 'authorization, content-type');
    res.setHeader('access-control-allow-methods', 'GET, POST, PATCH, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    // A host is not a hub (hub.ts): asked for a hub's API, it says so rather than serving the page.
    if (path === '/hub' || path.startsWith('/hub/')) {
      send(res, 404, { error: 'This is a host of one workspace, not a hub' });
      return true;
    }
    if (!isApi && !isGit) return serveStaticFrom(host.options.staticDir, path, res);

    if (!sameToken(tokenOf(req), host.token)) {
      if (isGit) res.setHeader('www-authenticate', 'Basic realm="kuraa"');
      send(res, 401, { error: 'Unauthorized' });
      return true;
    }

    try {
      if (isGit) {
        await gitBackend(host, req, res, url);
        return true;
      }
      const found = findRoute(req.method ?? 'GET', path);
      if (!found) throw new HttpError(404, `No route: ${req.method} ${path}`);
      await found.route.handle({ host, req, res, url, q: url.searchParams, params: found.params });
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) host.log(`error: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) send(res, status, { error: (err as Error).message });
      else res.end();
    }
    return true;
  };
}

/** The repository over git's smart HTTP protocol, through `git http-backend`. */
async function gitBackend(host: Host, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const pathInfo = '/.git' + url.pathname.replace(/^\/git/, '');
  if (url.pathname.endsWith('/git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack') {
    // A push updates the working tree, which must be clean: commit open rooms first.
    await host.serial(() => host.commitAll());
  }
  const child = host.git.spawn(['-c', 'http.receivepack=true', '-c', 'http.uploadpack=true', 'http-backend'], {
    GIT_PROJECT_ROOT: host.dir,
    GIT_HTTP_EXPORT_ALL: '1',
    PATH_INFO: pathInfo,
    QUERY_STRING: url.search.slice(1),
    REQUEST_METHOD: req.method ?? 'GET',
    CONTENT_TYPE: req.headers['content-type'] ?? '',
    CONTENT_LENGTH: req.headers['content-length'] ?? '',
    HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] ?? ''),
    REMOTE_USER: 'kuraa',
    REMOTE_ADDR: req.socket.remoteAddress ?? '',
    GIT_HTTP_MAX_REQUEST_BUFFER: '100M',
  });
  req.pipe(child.stdin);
  let headerDone = false;
  let buf = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    if (headerDone) {
      // Wait for the client when it reads slower than git writes (a large clone).
      if (!res.write(chunk)) {
        child.stdout.pause();
        res.once('drain', () => child.stdout.resume());
      }
      return;
    }
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n');
    const idx2 = buf.indexOf('\n\n');
    const end = idx >= 0 ? idx : idx2;
    if (end < 0) return;
    const sepLen = idx >= 0 ? 4 : 2;
    const headers = buf.subarray(0, end).toString('utf8').split(/\r?\n/);
    let status = 200;
    for (const line of headers) {
      const c = line.indexOf(':');
      if (c < 0) continue;
      const name = line.slice(0, c).trim();
      const value = line.slice(c + 1).trim();
      if (name.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200;
      else res.setHeader(name, value);
    }
    res.writeHead(status);
    headerDone = true;
    res.write(buf.subarray(end + sepLen));
  });
  let stderr = '';
  child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
  await new Promise<void>((resolveDone) => {
    child.on('close', (code) => {
      if (!headerDone) send(res, 500, { error: `git http-backend failed (${code}): ${stderr}` });
      else res.end();
      resolveDone();
    });
  });
  if (url.pathname.endsWith('/git-receive-pack')) {
    // The working tree moved: bring open rooms up to date.
    await host.serial(() => host.checkAll());
  }
}

/** A file of the built web client (index.html for any path that is not one). */
export function serveStaticFrom(root: string | undefined, path: string, res: ServerResponse): boolean {
  if (!root) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('kuraa host. Open the web client and point it at this URL.');
    return true;
  }
  const base = resolve(root);
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    res.writeHead(400);
    res.end('Bad path');
    return true;
  }
  let file = resolve(base, '.' + decoded);
  if (file !== base && !file.startsWith(base + sep)) {
    res.writeHead(403);
    res.end();
    return true;
  }
  if (!existsSync(file) || statSync(file).isDirectory()) file = join(base, 'index.html');
  if (!existsSync(file)) {
    res.writeHead(404);
    res.end('Not found');
    return true;
  }
  res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
  createReadStream(file).pipe(res);
  return true;
}
