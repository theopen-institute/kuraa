// The host's HTTP surface. Every /api and /git request needs the workspace token.
//
// The API is a table of routes, grouped by what they are about (the workspace,
// running code, files, history, devices). A route is a method, a path (exact, or
// a pattern whose groups the handler reads), and a handler given the request in
// a context.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { constants, existsSync, lstatSync, statSync, createReadStream } from 'node:fs';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve, sep } from 'node:path';
import type { ChunkRef, PresenceUser } from '@kuraa/session/server';
import type { Host } from './host.js';
import { MERGE_AUTHOR } from './merging.js';
import { HttpError, NotAllowed } from './errors.js';
import { renameOver, unportablePath } from './files.js';
import { renderRoutes, searchRoutes } from './render-routes.js';
import { toolRoutes } from './tool-routes.js';
import { writingRoutes } from './writing.js';
import { corsHeaders, hostAllowed, refuseHost } from './origins.js';
import { ownerOf } from '@kuraa/feature-kit/host';
import { filesFolderOf } from '@kuraa/kernel';
import { ORDER_FILE, ordersAfterDelete, ordersAfterRename, readOrders, writeOrders } from './order.js';

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
export function personOf(v: unknown, anonymous?: string): PresenceUser | null {
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
  if (!host.runner.enabled) throw new HttpError(403, `Running code is turned off on this host.${hint}`);
}

const workspaceRoutes: Route[] = [
  route('GET', '/api/workspace', async ({ host, res }) => send(res, 200, {
    // Its own name, the same on every device (0061), read again in case it was changed outside the app.
    name: (await host.refreshName()) ?? host.name,
    named: host.sharedName !== null,
    branch: await host.git.branch(),
    head: await host.git.head(),
    types: host.registry.all().map((t) => ({ id: t.id, label: t.label, version: t.version })),
    run: await host.runner.describe(),
  })),

  // Rename the workspace for everyone (0061): a commit, synced to every device.
  route('PATCH', '/api/workspace/name', async ({ host, req, res }) => {
    const body = await readBody(req);
    send(res, 200, { name: await host.rename(body.name, personOf(body.by) ?? undefined) });
  }),

  // Components: which engines and formats are on. Set by the host's flags; the app only shows them.
  route('GET', '/api/components', async ({ host, res }) => send(res, 200, await host.components())),

  route('GET', '/api/rooms', async ({ host, res, q }) => {
    // A new document with no file yet (draft=1, 0097): opened empty, its file made when there is first something
    // in it; only where a file could be made by this person (a name that travels, a folder they may change).
    const draft = q.get('draft') === '1';
    if (draft) {
      const path = host.relPath(str(q.get('path'), 'path'));
      checkPortable(path);
      if (host.peers && !existsSync(host.resolvePath(path)) && !(await host.peers.access(path)).canWrite) throw new NotAllowed(`You may not make ${path}`);
    }
    const rec = await host.room(str(q.get('path'), 'path'), { draft });
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
    send(res, 200, { runs: await host.runsOf(path), pending: await host.pendingOf(path), session: host.runner.session(path) });
  }),

  route('POST', '/api/runs', async ({ host, req, res }) => {
    requireRunning(host, ' Whoever runs the host can turn it on.');
    const body = await readBody(req);
    const path = host.relPath(str(body.path, 'path'));
    const engine = host.runner.engineFor(String(body.engine ?? ''));
    if (!engine) throw new HttpError(400, `Nothing on this host runs ${String(body.engine)} chunks.`);
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
    // Clearing outputs runs nothing: those another device published can be cleared on a device that runs no code.
    if (op !== 'clear') requireRunning(host, ' Whoever runs the host can turn it on.');
    const body = await readBody(req);
    const path = host.relPath(str(body.path, 'path'));
    if (op === 'interrupt') host.runner.interrupt(path);
    else if (op === 'restart') await host.runner.restart(path);
    else await host.clearRuns(path, chunkRefOf(body.chunk));
    send(res, 200, { ok: true });
  })),
];

/**
 * Folders' orders after a rename or deletion (0093), written in a commit of
 * their own. What was done is done: an order that cannot be written is said in
 * the log, and its stale name passed over when it is read.
 */
async function followOrders(host: Host, change: (orders: Map<string, string[]>) => Map<string, string[]>, message: string): Promise<void> {
  try {
    const next = change(await readOrders(host, (await host.listFiles()).filter((p) => p === ORDER_FILE || p.endsWith(`/${ORDER_FILE}`))));
    await writeOrders(host, next, message);
  } catch (e) {
    host.log(`could not update the order after a change: ${(e as Error).message}`);
  }
}

const fileRoutes: Route[] = [
  route('GET', '/api/tree', async ({ host, res }) => {
    const branch = await host.git.branch();
    // With the files of the spaces this device holds (plain git is kept off them: spaces.ts).
    const paths = await host.listFiles();
    // Documents are shown by their title: null if one has none, absent for files that are not documents.
    const files = await host.treeEntries(paths, branch);
    // Companions (0082) and a document's own files (0109) say which document they are kept beside, when it is there:
    // the list shows them with it, not on their own.
    const listed = new Set(paths);
    for (const f of files) {
      const doc = host.belongsTo(f.path);
      if (doc && listed.has(doc)) f.of = doc;
    }
    // Who reads, and who may change, each file (where not everyone may), and folders with permissions of their own, in words (0066, 0069).
    const marks = host.peers ? await host.peers.marks(paths) : { files: new Map<string, object>(), folders: [] };
    for (const f of files) {
      const m = marks.files.get(f.path);
      if (m) Object.assign(f, m);
    }
    // Folders in the order people arranged them (0093), by folder ('' for the top).
    const orders = Object.fromEntries(await readOrders(host, paths));
    send(res, 200, { files, folders: marks.folders, orders });
  }),

  // A document's header fields set (0096: a corkboard's synopsis, an outline's
  // status), open or not; committed, credited to whoever asked.
  route('POST', '/api/documents/header', async ({ host, req, res }) => {
    const body = await readBody(req);
    const path = host.relPath(str(body.path, 'path'));
    const fields = body.fields;
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || !Object.keys(fields).length) throw new HttpError(400, 'fields: the header fields to set');
    if (!existsSync(host.resolvePath(path))) throw new HttpError(404, 'No such file');
    if (host.peers && !(await host.peers.access(path)).canWrite) throw new NotAllowed(`You may not change ${path}`);
    const by = personOf(body.by);
    const commit = await host.serial(async () => {
      await host.requireWritable();
      if (!(await host.setHeader(path, fields as Record<string, unknown>))) return null;
      return host.commitPaths([path], `Change ${Object.keys(fields).join(', ')} of ${path}`, by && by.email ? [by] : []);
    });
    send(res, 200, { path, commit });
  }),

  // A folder's order (0093): the names of its files and folders, in the order
  // people arranged them; none, the folder's own order file removed.
  route('POST', '/api/order', async ({ host, req, res }) => {
    const body = await readBody(req);
    const folder = typeof body.folder === 'string' && body.folder.replace(/\/+$/, '') ? host.relPath(body.folder.replace(/\/+$/, '')) : '';
    if (!Array.isArray(body.names) || body.names.some((n) => typeof n !== 'string' || !n || n.includes('/'))) throw new HttpError(400, 'names: the names of the folder’s files and folders');
    if (folder && !existsSync(host.resolvePath(folder))) throw new HttpError(404, 'No such folder');
    // Only what is there, each once.
    const names = [...new Set(body.names as string[])].filter((n) => n !== ORDER_FILE && lexists(host.resolvePath(folder ? `${folder}/${n}` : n, { link: 'self' })));
    const commit = await writeOrders(host, new Map([[folder, names]]), `Order ${folder ? `${folder}/` : 'the top level'}`, { check: true });
    send(res, 200, { folder, names, commit });
  }),

  route('GET', '/api/files', async ({ host, res, q }) => {
    const path = host.relPath(str(q.get('path'), 'path'));
    const abs = host.resolvePath(path);
    // Opened refusing a link, then read from what was opened: a link put there since it was checked is not followed (0037).
    let fh;
    try {
      fh = await open(abs, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ELOOP') throw new HttpError(403, `${path} is a link to somewhere else: the app does not open or follow links`);
      if (code === 'ENOENT' || code === 'ENOTDIR') throw new HttpError(404, 'No such file');
      throw e;
    }
    if (!(await fh.stat()).isFile()) {
      await fh.close();
      throw new HttpError(404, 'No such file');
    }
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    // A read that fails half-way ends the answer, not the host.
    fh.createReadStream().on('error', () => res.destroy()).pipe(res);
  }),

  route('POST', '/api/files', async ({ host, req, res }) => {
    const body = await readBody(req);
    const path = host.relPath(str(body.path, 'path'));
    checkPortable(path);
    const abs = host.resolvePath(path);
    if (existsSync(abs)) throw new HttpError(409, 'File exists');
    const content = typeof body.content === 'string' ? body.content : '';
    // Made in a folder fewer read: into their space, never onto the workspace's own branch (0069).
    const space = host.peers ? await host.peers.spaceForNew(path) : null;
    const commit = await host.serial(async () => {
      await host.requireWritable();
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content, { flag: 'wx' });
      return space ? host.commitIntoSpace(space, [path], `Create ${path}`) : host.commitPaths([path], `Create ${path}`);
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
    const space = host.peers ? await host.peers.spaceForNew(`${path}/.gitkeep`) : null;
    const commit = await host.serial(async () => {
      await host.requireWritable();
      await mkdir(abs, { recursive: true });
      await writeFile(join(abs, '.gitkeep'), '');
      return space ? host.commitIntoSpace(space, [`${path}/.gitkeep`], `Create folder ${path}`) : host.commitPaths([`${path}/.gitkeep`], `Create folder ${path}`);
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
      // Checked as the kind of file it will be (a text file renamed to a document gets its first title).
      if (!host.typeFor(to)?.title) throw new HttpError(400, `${to} would not be a document with a title`);
      await host.checkTitle(from, title, to);
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
    // Only the case changed (drama to Drama): on a file system that ignores case (macOS, Windows) the new
    // name is there already, as this same file, and is no clash.
    const caseOnly = from.toLowerCase() === to.toLowerCase() && sameFile(absFrom, absTo);
    if (existsSync(absTo) && !caseOnly) throw new HttpError(409, `${to} already exists`);
    // A folder moves with everything in it, but never into itself.
    const isFolder = lstatSync(absFrom).isDirectory();
    if (isFolder && to.startsWith(`${from}/`)) throw new HttpError(400, 'A folder cannot move into itself');
    // Only the folder changed: a move. Otherwise (the name changed too) a rename.
    const moveOnly = dirname(from) !== dirname(to) && basename(from) === basename(to);
    // Its permissions go with it (0069): refused, rather than left behind, where this person cannot carry them.
    const why = host.peers ? await host.peers.whyNotMove(from, isFolder) : null;
    if (why) throw new HttpError(403, why);
    // What is kept beside a file goes with it (0082): its companion folders, everyone's files in them, unchanged; a folder's go with it anyway.
    // And its own files (0109: `report.md.files/`), all of them.
    const companions = isFolder ? [] : [...host.features.foldersOf(from), filesFolderOf(from)].filter((c) => lexists(host.resolvePath(c, { link: 'self' }))).map((c) => [c, `${to}${c.slice(from.length)}`] as const);
    // Documents whose references to what moved are not this person's to write again (0109): left as they are, and said.
    let left: string[] = [];
    for (const [, c] of companions) if (lexists(host.resolvePath(c, { link: 'self' })) && !caseOnly) throw new HttpError(409, `${c} already exists`);
    const commit = await host.serial(async () => {
      await host.requireWritable();
      if (isFolder) await host.dropRoomsUnder(from, to);
      else await host.dropRoom(from, to);
      for (const [c] of companions) await host.dropRoomsUnder(c);
      await mkdir(dirname(absTo), { recursive: true });
      if (caseOnly) {
        // Through a name of its own, so every file system takes the new case (git.stage and
        // commitPaths then record it, the old name as gone).
        const aside = `${absFrom}.kuraa-rename-${randomBytes(4).toString('hex')}`;
        await renameOver(absFrom, aside);
        await renameOver(aside, absTo);
      } else await renameOver(absFrom, absTo);
      for (const [c, next] of companions) {
        if (caseOnly) {
          const aside = `${host.resolvePath(c)}.kuraa-rename-${randomBytes(4).toString('hex')}`;
          await renameOver(host.resolvePath(c), aside);
          await renameOver(aside, host.resolvePath(next));
        } else await renameOver(host.resolvePath(c), host.resolvePath(next));
      }
      if (title !== undefined && !isFolder) await host.setTitle(to, title);
      // Files of spaces stay in their spaces, at their new paths (0069).
      await host.carrySpaces(from, to, isFolder);
      for (const [c, next] of companions) await host.carrySpaces(c, next, true);
      // References follow (0109): to what moved, in every document that names it, and from the document that moved.
      const mayChange = async (p: string) => !host.peers || (await host.peers.access(p)).canWrite;
      const refs = await host.rewriteReferences([[from, to], ...companions], mayChange);
      left = refs.left;
      return host.commitPaths([from, to, ...companions.flat(), ...refs.changed], moveOnly ? `Move ${from} to ${dirname(to) === '.' ? 'the top level' : `${dirname(to)}/`}` : `Rename ${from} to ${to}`);
    });
    if (host.peers) await host.peers.moved(from, to, isFolder);
    // The orders follow (0093): the new name where the old was, or out of one folder's and at the end of another's.
    await followOrders(host, (orders) => ordersAfterRename(orders, from, to), `Order after renaming ${from}`);
    void host.features.emit('rename', { from, to, folder: isFolder });
    send(res, 200, { from, to, commit, ...(left.length ? { left } : {}) });
  }),

  route('DELETE', '/api/files', async ({ host, res, q }) => {
    const path = host.relPath(str(q.get('path'), 'path'), { link: 'self' });
    // A link is deleted itself (never what it points to).
    const abs = host.resolvePath(path, { link: 'self' });
    if (!lexists(abs)) throw new HttpError(404, 'No such file');
    const isFolder = lstatSync(abs).isDirectory();
    // What is kept beside a file: only the deleter's own goes with it; others' stay, theirs (0082).
    const companions = isFolder ? [] : await host.features.ownFilesOf(path);
    // Its own files (0109: `report.md.files/`) are the document's: they go with it, all of them.
    const own = isFolder ? null : filesFolderOf(path);
    const ownFiles = own && lexists(host.resolvePath(own, { link: 'self' })) ? own : null;
    // A folder: everything in it but others' own files, which stay where they are, theirs.
    const me = host.features.person();
    const theirs = isFolder ? (await host.listFiles()).filter((p) => p.startsWith(`${path}/`) && ownerOf(p) !== null && ownerOf(p) !== me) : [];
    const commit = await host.serial(async () => {
      await host.requireWritable();
      // A folder's open rooms go with it.
      if (isFolder) await host.dropRoomsUnder(path);
      else await host.dropRoom(path);
      if (theirs.length) {
        const gone = (await host.listFiles()).filter((p) => p.startsWith(`${path}/`) && !theirs.includes(p));
        for (const p of gone) await rm(host.resolvePath(p, { link: 'self' }), { force: true, maxRetries: 5 });
        await removeEmptyFolders(abs);
        return host.commitPaths(gone, `Delete ${path} (but others’ own files in it)`);
      }
      // Retried while Windows says busy (another program has a file open, for a moment).
      await rm(abs, { recursive: true, maxRetries: 5 });
      for (const c of companions) await host.features.removeOwn(c);
      if (ownFiles) {
        await host.dropRoomsUnder(ownFiles);
        await rm(host.resolvePath(ownFiles, { link: 'self' }), { recursive: true, maxRetries: 5 });
      }
      return host.commitPaths([path, ...companions, ...(ownFiles ? [ownFiles] : [])], `Delete ${path}`);
    });
    await followOrders(host, (orders) => ordersAfterDelete(orders, path), `Order after deleting ${path}`);
    void host.features.emit('delete', { path, folder: isFolder });
    send(res, 200, { path, commit });
  }),
];

/** Remove the empty folders under a folder, and it if that leaves it empty. */
async function removeEmptyFolders(abs: string): Promise<void> {
  const { readdir, rmdir } = await import('node:fs/promises');
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) if (e.isDirectory()) await removeEmptyFolders(join(abs, e.name));
  await rmdir(abs).catch(() => undefined);
}

/** Whether two paths name one file (or folder): the same one on disk, as on a file system that ignores case. */
function sameFile(a: string, b: string): boolean {
  try {
    const x = lstatSync(a);
    const y = lstatSync(b);
    return x.ino === y.ino && x.dev === y.dev;
  } catch {
    return false;
  }
}

const historyRoutes: Route[] = [
  // Words written each day, by person, from a day on (0094): the history, and what is typed here not committed yet.
  route('GET', '/api/words', async ({ host, res, q }) => {
    const since = q.get('since') ?? '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) throw new HttpError(400, 'since: a day, as YYYY-MM-DD');
    send(res, 200, { days: await host.wordsByDay(since) });
  }),
  route('GET', '/api/history', async ({ host, res, q }) => {
    const path = host.relPath(str(q.get('path'), 'path'));
    // --follow crosses renames, so each entry also gives the path the file had in that commit
    // (from --name-only, which git prints after the formatted header).
    // A space's file, from its space's history (0066).
    const ref = host.refFor(path);
    const log = await host.git.run(
      ['log', ...(ref === 'HEAD' ? [] : [ref]), '--follow', '-n', '200', '--name-only', '--format=%x1e%H%x1f%an%x1f%ae%x1f%aI%x1f%s%x1f%b%x1d', '--', path],
      { allowFail: true },
    );
    const commits = log.stdout.split('\x1e').filter((s) => s.trim()).map((entry) => {
      const [header = '', names = ''] = entry.split('\x1d');
      const [hash, author, email, date, subject, body = ''] = header.split('\x1f');
      const coAuthors = [...body.matchAll(/^Co-authored-by:\s*(.+?)\s*<([^>]*)>\s*$/gim)].map((m) => ({ name: m[1], email: m[2] }));
      const pathThen = names.split('\n').map((n) => n.trim()).filter(Boolean).pop() ?? path;
      // Saves the host made on its own, merges it made, or commits made otherwise (named versions, outside).
      const kind = email === MERGE_AUTHOR.email ? 'merge' : /^Kuraa-Kind:\s*autosave\s*$/im.test(body) ? 'autosave' : 'commit';
      return { hash, author, email, date, subject, coAuthors, path: pathThen, kind } as { hash: string; author: string; email: string; date: string; subject: string; coAuthors: { name: string | undefined; email: string | undefined }[]; path: string; kind: string };
    });
    // Changes not kept (0072): made by someone who may not change the file; in its history, to read and take up.
    const refused = await host.notKept(path);
    if (refused.length) {
      for (const { commit } of refused) {
        const r = await host.git.run(['show', '-s', '--format=%an%x1f%ae%x1f%aI%x1f%s', commit], { allowFail: true });
        if (r.code !== 0) continue;
        const [author = '', email = '', date = '', subject = ''] = r.stdout.trim().split('\x1f');
        // Put in by date, the history's own order otherwise as git gives it.
        const at = commits.findIndex((c) => c.date <= date);
        commits.splice(at < 0 ? commits.length : at, 0, { hash: commit, author, email, date, subject, coAuthors: [], path, kind: 'not-kept' });
      }
    }
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
// paired and connected. Where invites are on (canInvite: every hub's workspace, 0047), people using
// the app make and revoke invite links, remove devices and rename this one: every
// member has the same say (0038).
// You on this computer (peers/person.ts, 0035), where the one running the host uses it
// (managePerson: a hub on loopback, 0047): this computer's signing key, your identity if it is here, and your keys
// the workspace knows of.
const personKeys = () => import('./peers/person.js');
const hostPerson = async (host: Host) => {
  if (!host.options.managePerson) throw new HttpError(404, 'Your identity is managed only on the computer running this host, while it is not open to the network');
  const keys = await personKeys();
  const p = await keys.readPerson();
  return keys.personInfo(p ? await knownKeys(host, p.id) : []);
};
/** The signing keys workspaces know to be this identity's: every workspace on a hub (knownKeys), else this one. */
const knownKeys = async (host: Host, id: string): Promise<string[]> => {
  if (host.options.knownKeys) return host.options.knownKeys(id);
  return host.peers ? (await host.peers.node.identity.people()).find((x) => x.key === id)?.keys ?? [] : [];
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
  // The recovery key (0066): shown until the person says it is saved elsewhere, then removed from this computer.
  route('GET', '/api/person/recovery', async ({ host, res }) => {
    await hostPerson(host);
    const line = await (await personKeys()).recoveryLine();
    if (!line) throw new HttpError(404, 'Your recovery key is not on this computer');
    send(res, 200, { line });
  }),
  route('POST', '/api/person/recovery/saved', async ({ host, res }) => {
    await hostPerson(host);
    await keysDo(async () => (await personKeys()).recoverySaved());
    send(res, 200, { person: await hostPerson(host) });
  }),
  // Whose a recovery key is, and the keys workspaces know to be theirs: to choose which stay theirs.
  route('POST', '/api/person/recover/preview', async ({ host, req, res }) => {
    await hostPerson(host);
    const line = str((await readBody(req)).line, 'line');
    let who: { id: string; name: string } | undefined;
    await keysDo(async () => { who = (await personKeys()).readRecoveryLine(line); });
    send(res, 200, { ...who!, keys: await knownKeys(host, who!.id) });
  }),
  route('POST', '/api/person/recover', async ({ host, req, res }) => {
    await hostPerson(host);
    const b = await readBody(req);
    const line = str(b.line, 'line');
    const drop = new Set(Array.isArray(b.drop) ? b.drop.filter((k): k is string => typeof k === 'string') : []);
    await keysDo(async () => {
      const keys = await personKeys();
      const known = await knownKeys(host, keys.readRecoveryLine(line).id);
      await keys.recoverPerson(line, known.filter((k) => !drop.has(k)));
    });
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

// Syncs (the online copy, from a component: decision 0059): places this workspace keeps a copy on, and
// syncs with. Everyone sees them (Sync syncs with them); adding and removing targets is for the one running
// the host (manageOnline), whose git credentials they use.
const mayManageOnline = (host: Host) => {
  if (!host.options.manageOnline) throw new HttpError(403, 'The online copy is set up only on the computer running this host, while it is not open to the network');
};
const syncOf = (host: Host, id: string) => {
  const s = host.syncs.get(id);
  if (!s) throw new HttpError(404, `No component for ${id} is loaded on this host`);
  return s;
};
const syncInfo = async (host: Host, id: string) => {
  const { sync, session } = syncOf(host, id);
  return { id, label: sync.label, description: sync.description ?? '', placeholder: sync.placeholder ?? '', help: sync.help ?? '', targets: await session.list() };
};
const syncRoutes: Route[] = [
  route('GET', '/api/syncs', async ({ host, res }) => send(res, 200, { canManage: !!host.options.manageOnline, syncs: await Promise.all([...host.syncs.keys()].map((id) => syncInfo(host, id))) })),
  route('POST', /^\/api\/syncs\/([a-z0-9-]+)$/, async ({ host, req, res, params }) => {
    const { session } = syncOf(host, params[0]!);
    mayManageOnline(host);
    const target = str((await readBody(req)).target, 'target');
    try {
      await session.add(target);
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    send(res, 201, await syncInfo(host, params[0]!));
  }),
  route('DELETE', /^\/api\/syncs\/([a-z0-9-]+)\/([A-Za-z0-9._-]+)$/, async ({ host, res, params }) => {
    const { session } = syncOf(host, params[0]!);
    mayManageOnline(host);
    try {
      await session.remove(params[1]!);
    } catch (e) {
      throw new HttpError(404, (e as Error).message);
    }
    send(res, 200, await syncInfo(host, params[0]!));
  }),
];

/** Done, or refused by the workspace's policy (403: this person is not an admin) or as asked (400). */
async function allowed<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(e instanceof NotAllowed || /^Only (an admin|the)/.test((e as Error).message) ? 403 : 400, (e as Error).message);
  }
}

const peerRoutes: Route[] = [
  route('GET', '/api/peers', async ({ host, res }) => {
    const canInvite = !!host.options.invites;
    send(res, 200, host.peers ? { enabled: true, canInvite, ...(await host.peers.status()) } : { enabled: false, canInvite });
  }),

  route('GET', '/api/peers/links', async ({ host, res }) => {
    if (!host.options.invites) throw new HttpError(403, 'Making invitations from the app is turned off on this host');
    send(res, 200, { links: host.peers ? await host.peers.links() : [] });
  }),

  route('POST', '/api/peers/links', async ({ host, req, res }) => {
    const body = await readBody(req);
    const hours = body.hours === null ? null : Number(body.hours);
    if (hours !== null && !(hours > 0 && hours <= 24 * 366)) throw new HttpError(400, 'A link lasts some hours (up to a year), or has no expiry (null)');
    const peers = await host.peersForInvites();
    // Named before it is shared: whoever joins gets the name (0061).
    await host.ensureName();
    // As a member, unless it says admin (0066); or a server (0099: the owner's, for one).
    const role = body.role === 'admin' ? 'admin' : body.role === 'server' ? 'server' : 'member';
    const link = await allowed(() => peers.inviteLink({ hours, once: body.once === true, role }));
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
    let revoked: boolean;
    try {
      ({ revoked } = await peers.removeDevice(params[0]!));
    } catch (e) {
      throw new HttpError(e instanceof NotAllowed ? 403 : 404, (e as Error).message);
    }
    // One's own computer: its key revoked too, where this computer keeps one's identity (0068).
    send(res, 200, { ok: true, revoked });
  }),

  // A server taken out (0099): the owner's; it keeps its copy. Invited back by a new link, unless ?for-good=1 (its key
  // lost or stolen), after which that key never comes in again.
  route('DELETE', /^\/api\/peers\/servers\/([0-9a-f]{64})$/, async ({ host, res, params, q }) => {
    const peers = await host.peersForInvites();
    await allowed(() => peers.removeServer(params[0]!, { forGood: q.get('for-good') === '1' }));
    send(res, 200, await peers.people());
  }),

  // The workspace's people (0066): an admin makes someone an admin or a member, or takes them out (with their devices).
  route('POST', /^\/api\/peers\/people\/([0-9a-f]{64})$/, async ({ host, req, res, params }) => {
    const peers = await host.peersForInvites();
    const role = (await readBody(req)).role;
    if (role !== 'admin' && role !== 'member') throw new HttpError(400, 'A person is an admin or a member');
    await allowed(() => peers.setRole(params[0]!, role));
    send(res, 200, await peers.people());
  }),
  // The owner gives their role to someone in the workspace (0070), staying an admin.
  route('POST', /^\/api\/peers\/owner\/([0-9a-f]{64})$/, async ({ host, res, params }) => {
    const peers = await host.peersForInvites();
    await allowed(() => peers.makeOwner(params[0]!));
    send(res, 200, await peers.people());
  }),
  route('DELETE', /^\/api\/peers\/people\/([0-9a-f]{64})$/, async ({ host, res, params }) => {
    const peers = await host.peersForInvites();
    await allowed(() => peers.removePerson(params[0]!));
    send(res, 200, await peers.people());
  }),

  // Who may change what (0066): a file's access; rules and groups.
  route('GET', '/api/access', async ({ host, res, q }) => {
    const path = str(q.get('path'), 'path');
    send(res, 200, host.peers ? await host.peers.access(path) : { canWrite: true, rule: null, admin: false, you: null, readers: null, notKept: [] });
  }),
  // A file's or folder's permissions (0069): who may change it, who reads it (a folder's: what is made in it).
  route('GET', '/api/permissions', async ({ host, res, q }) => {
    const peers = host.peers;
    if (!peers) throw new HttpError(400, 'Permissions are for a workspace shared with other devices');
    const raw = str(q.get('path'), 'path');
    const path = raw === '' || raw === '/' ? '' : raw.endsWith('/') ? `${host.relPath(raw.slice(0, -1))}/` : host.relPath(raw);
    send(res, 200, await peers.permissions(path));
  }),
  route('POST', '/api/permissions', async ({ host, req, res }) => {
    const peers = host.peers;
    if (!peers) throw new HttpError(400, 'Permissions are for a workspace shared with other devices');
    const b = await readBody(req);
    const raw = str(b.path, 'path');
    const path = raw === '' || raw === '/' ? '' : raw.endsWith('/') ? `${host.relPath(raw.slice(0, -1))}/` : host.relPath(raw);
    const list = (v: unknown) => (v === undefined ? undefined : v === null ? null : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : (() => { throw new HttpError(400, 'Name people, groups or admins'); })());
    const change = { write: list(b.write), read: list(b.read) };
    await allowed(() => peers.setPermissions(path, change));
    send(res, 200, await peers.permissions(path));
  }),
  // Who reads a file (0066): everyone in the workspace (null), or an audience; it moves to that audience's space.
  route('POST', '/api/audience', async ({ host, req, res }) => {
    const peers = host.peers;
    if (!peers) throw new HttpError(400, 'Who reads what is for a workspace shared with other devices');
    const b = await readBody(req);
    const path = host.relPath(str(b.path, 'path'));
    if (b.audience !== null && (!Array.isArray(b.audience) || !b.audience.every((w: unknown) => typeof w === 'string'))) throw new HttpError(400, 'An audience is a list of people, groups or admins, or null for everyone');
    const audience = b.audience as string[] | null;
    await allowed(() => peers.setAudience(path, audience));
    send(res, 200, await peers.access(path));
  }),
  route('GET', '/api/rules', async ({ host, res }) => {
    send(res, 200, host.peers ? await host.peers.rules() : { admin: false, rules: [], groups: [], permissions: [], clashes: [], refound: null });
  }),
  // A clash's losing change made again, on purpose, after both (0078): an admin's (as the change needs).
  route('POST', /^\/api\/clashes\/([0-9a-f]{64})\/redo$/, async ({ host, res, params }) => {
    const peers = await host.peersForInvites();
    await allowed(() => peers.redo(params[0]!));
    send(res, 200, await peers.rules());
  }),
  // A workspace from before 0066 founded again (0078), by its owner (or, with none, an admin).
  route('POST', '/api/peers/refound', async ({ host, res }) => {
    const peers = await host.peersForInvites();
    await allowed(() => peers.refound());
    send(res, 200, await peers.rules());
  }),
  route('POST', '/api/rules', async ({ host, req, res }) => {
    const peers = await host.peersForInvites();
    const b = await readBody(req);
    if (typeof b.path !== 'string' || !Array.isArray(b.by) || !b.by.every((w: unknown) => typeof w === 'string')) throw new HttpError(400, 'A rule has a path and whom it names');
    const path = b.path;
    const by = b.by as string[];
    await allowed(() => peers.setRule(path, by));
    send(res, 200, await peers.rules());
  }),
  route('POST', /^\/api\/groups\/([a-z0-9][a-z0-9-]{0,39})$/, async ({ host, req, res, params }) => {
    const peers = await host.peersForInvites();
    const b = await readBody(req);
    const who = str(b.who, 'who');
    const role = b.role === 'admin' || b.role === 'member' ? b.role : null;
    await allowed(() => peers.setGroupRole(params[0]!, who, role));
    send(res, 200, await peers.rules());
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

// Features (0082): how each stands for the workspace, turning one on or off for it (and its settings), and its own routes.
const FEATURE_ROUTE = /^\/api\/features\/([a-z][a-z0-9-]{0,40})\/(.+)$/;
const featureRoutes: Route[] = [
  route('GET', '/api/features', async ({ host, res }) => send(res, 200, { features: await host.features.status() })),
  // Everyone's own files beside a document by a companion suffix, with their text: as they are, or at a commit (a past version).
  route('GET', '/api/companions', async ({ host, res, q }) => {
    const doc = host.relPath(str(q.get('path'), 'path'));
    const suffix = str(q.get('suffix'), 'suffix');
    if (!host.features.suffixes().includes(suffix)) throw new HttpError(400, 'Not a companion suffix');
    const folder = `${doc}${suffix}`;
    const commit = q.get('commit');
    const out: { person: string; path: string; text: string }[] = [];
    if (commit) {
      if (!/^[0-9a-f]{4,40}$/.test(commit)) throw new HttpError(400, 'Not a commit');
      const listed = (await host.git.run(['ls-tree', '-z', '--name-only', `${commit}:${folder}`], { allowFail: true })).stdout.split('\0').filter(Boolean);
      for (const name of listed) {
        const person = ownerOf(name);
        if (!person) continue;
        const blob = await host.git.run(['show', `${commit}:${folder}/${name}`], { allowFail: true });
        if (blob.code === 0) out.push({ person, path: `${folder}/${name}`, text: blob.stdout });
      }
    } else {
      for (const p of await host.features.filesOf(doc)) {
        if (!p.startsWith(`${folder}/`)) continue;
        const text = await readFile(host.resolvePath(p), 'utf8').catch(() => null);
        if (text !== null) out.push({ person: ownerOf(p)!, path: p, text });
      }
    }
    send(res, 200, { companions: out });
  }),
  route('PATCH', /^\/api\/features\/([a-z][a-z0-9-]{0,40})$/, async ({ host, req, res, params }) => {
    const body = await readBody(req);
    if (body.on !== undefined && typeof body.on !== 'boolean') throw new HttpError(400, '“on” is true or false');
    const settings = body.settings;
    if (settings !== undefined && (typeof settings !== 'object' || settings === null || Array.isArray(settings))) throw new HttpError(400, 'Settings are an object');
    const status = await host.features.setWorkspace(params[0]!, { on: body.on as boolean | undefined, settings: settings as Record<string, never> | undefined }, personOf(body.by));
    // Rooms open now keep its state from here on, before anyone is told it is on.
    await host.seedOpenRooms();
    send(res, 200, status);
  }),
  ...(['GET', 'POST', 'PATCH', 'DELETE'] as const).map((method) => route(method, FEATURE_ROUTE, async ({ host, req, res, q, params }) => {
    const body = method === 'GET' ? undefined : await readBody(req);
    const { by, ...rest } = (body ?? {}) as Record<string, unknown>;
    const r = await host.features.route(params[0]!, method, params[1]!, q, body === undefined ? undefined : (rest.body as never), personOf(by));
    send(res, r.status ?? 200, r.body ?? null);
  })),
];

const ROUTES: Route[] = [...workspaceRoutes, ...runRoutes, ...renderRoutes, ...toolRoutes, ...searchRoutes, ...fileRoutes, ...historyRoutes, ...peerRoutes, ...personRoutes, ...syncRoutes, ...writingRoutes, ...featureRoutes];

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

    // Only at a name for this computer, when it listens there alone; pages
    // elsewhere read its answers only from origins the operator named (origins.ts).
    if (!hostAllowed(req, host.requests)) {
      refuseHost(res);
      return true;
    }
    corsHeaders(req, res, host.requests);
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
      // Refused by the policy, wherever (a server's page, say, asking for a new document: 0099): 403, not an error.
      const status = err instanceof HttpError ? err.status : err instanceof NotAllowed ? 403 : 500;
      if (status === 500) host.log(`error: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) send(res, status, { error: (err as Error).message });
      else res.end();
    }
    return true;
  };
}

/**
 * Refuses a push whose new commits add a symbolic link anywhere (as a file, or
 * a file made one): the host never follows links (0037), and a pushed one would
 * otherwise be checked out into the working tree. Links already in the history
 * do not stop a push.
 */
const PRE_RECEIVE = `#!/bin/sh
# Written by kuraa, for pushes to its host only (git http-backend, core.hooksPath).
while read old new ref; do
  case "$new" in *[!0]*) ;; *) continue ;; esac
  if git log --raw -m --root --no-renames --format= "$new" --not --all | grep -q '^:[0-7]* 120000 '; then
    echo "kuraa: $ref adds a symbolic link, which this workspace does not take." >&2
    exit 1
  fi
done
exit 0
`;

/**
 * The folder of hooks pushes run (in .git/kuraa, kuraa's own): written each
 * time, so it is always there and this version, and moved into place, so a push
 * at the same moment never runs half of it.
 */
async function pushHooks(host: Host): Promise<string> {
  const dir = join(await host.git.gitDir(), 'kuraa', 'hooks');
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.pre-receive-${randomBytes(6).toString('hex')}`);
  await writeFile(tmp, PRE_RECEIVE, { mode: 0o755 });
  await renameOver(tmp, join(dir, 'pre-receive'));
  return dir;
}

/** The repository over git's smart HTTP protocol, through `git http-backend`. */
async function gitBackend(host: Host, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const pathInfo = '/.git' + url.pathname.replace(/^\/git/, '');
  if (url.pathname.endsWith('/git-receive-pack') || url.searchParams.get('service') === 'git-receive-pack') {
    // A push updates the working tree, which must be clean: commit open rooms first.
    await host.serial(() => host.commitAll());
  }
  // Pushes run kuraa's hooks, not the repository's: a push may not add a link (0037).
  const child = host.git.spawn(['-c', 'http.receivepack=true', '-c', 'http.uploadpack=true', '-c', `core.hooksPath=${await pushHooks(host)}`, 'http-backend'], {
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
    res.end('Kuraa host. Open the web client and point it at this URL.');
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
