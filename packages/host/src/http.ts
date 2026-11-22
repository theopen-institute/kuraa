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
import { HttpError, NotAllowed } from './errors.js';
import crypto from 'hypercore-crypto';
import { askMessage, emailOf, readAttestation } from './peers/attest.js';
import { renameOver, unportablePath } from './files.js';
import { renderRoutes, searchRoutes } from './render-routes.js';
import { toolRoutes } from './tool-routes.js';
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
  if (!host.runner.enabled) throw new HttpError(403, `Running code is turned off on this server.${hint}`);
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
    send(res, 200, { runs: await host.runsOf(path), pending: await host.pendingOf(path), session: host.runner.session(path) });
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
    // Clearing outputs runs nothing: those another device published can be cleared on a device that runs no code.
    if (op !== 'clear') requireRunning(host, ' Whoever runs the server can turn it on.');
    const body = await readBody(req);
    const path = host.relPath(str(body.path, 'path'));
    if (op === 'interrupt') host.runner.interrupt(path);
    else if (op === 'restart') await host.runner.restart(path);
    else await host.clearRuns(path, chunkRefOf(body.chunk));
    send(res, 200, { ok: true });
  })),
];

const fileRoutes: Route[] = [
  route('GET', '/api/tree', async ({ host, res }) => {
    const out = await host.git.out(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    const branch = await host.git.branch();
    // With the files of the spaces this device holds (plain git is kept off them: spaces.ts).
    const spaced = host.spaces.entries().map(([p]) => p).filter((p) => existsSync(join(host.dir, p)));
    const paths = [...new Set([...out.split('\0').filter(Boolean), ...spaced])].sort();
    // Documents are shown by their title: null if one has none, absent for files that are not documents.
    const files = await host.treeEntries(paths, branch);
    // Who reads, and who may change, each file (where not everyone may), and folders with permissions of their own, in words (0066, 0069).
    const marks = host.peers ? await host.peers.marks(paths) : { files: new Map<string, object>(), folders: [] };
    for (const f of files) {
      const m = marks.files.get(f.path);
      if (m) Object.assign(f, m);
    }
    send(res, 200, { files, folders: marks.folders });
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
    if (existsSync(absTo)) throw new HttpError(409, `${to} already exists`);
    // A folder moves with everything in it, but never into itself.
    const isFolder = lstatSync(absFrom).isDirectory();
    if (isFolder && to.startsWith(`${from}/`)) throw new HttpError(400, 'A folder cannot move into itself');
    // Only the folder changed: a move. Otherwise (the name changed too) a rename.
    const moveOnly = dirname(from) !== dirname(to) && basename(from) === basename(to);
    // Its permissions go with it (0069): refused, rather than left behind, where this person cannot carry them.
    const why = host.peers ? await host.peers.whyNotMove(from, isFolder) : null;
    if (why) throw new HttpError(403, why);
    const commit = await host.serial(async () => {
      await host.requireWritable();
      if (isFolder) await host.dropRoomsUnder(from);
      else await host.dropRoom(from);
      await mkdir(dirname(absTo), { recursive: true });
      await renameOver(absFrom, absTo);
      if (title !== undefined && !isFolder) await host.setTitle(to, title);
      // Files of spaces stay in their spaces, at their new paths (0069).
      await host.carrySpaces(from, to, isFolder);
      return host.commitPaths([from, to], moveOnly ? `Move ${from} to ${dirname(to) === '.' ? 'the top level' : `${dirname(to)}/`}` : `Rename ${from} to ${to}`);
    });
    if (host.peers) await host.peers.moved(from, to, isFolder);
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
// paired and connected. Where invites are on (canInvite: every hub's workspace, 0047), people using
// the app make and revoke invite links, remove devices and rename this one: every
// member has the same say (0038).
// You on this computer (peers/person.ts, 0035), where the one running the host uses it
// (managePerson: a hub on loopback, 0047): this computer's signing key, your identity if it is here, and your keys
// the workspace knows of.
const personKeys = () => import('./peers/person.js');
const hostPerson = async (host: Host) => {
  if (!host.options.managePerson) throw new HttpError(404, 'Your identity is managed only on the computer running this server, while it is not open to the network');
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

/** A verifier's address, as the app gives it: http(s), no trailing slash. */
function verifierUrl(v: unknown): string {
  const url = typeof v === 'string' ? v.trim().replace(/\/+$/, '') : '';
  if (!/^https?:\/\/\S+$/.test(url)) throw new HttpError(400, 'A verifier is a server’s address (https://…)');
  return url;
}

/** Ask a verifier something (verifier.ts): its answer, or its refusal as an error. */
async function askVerifier(url: string, path: string, body: unknown): Promise<unknown> {
  let r: Response;
  try {
    r = await fetch(`${url}${path}`, body === null ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  } catch (e) {
    throw new HttpError(502, `Could not reach ${url}: ${(e as Error).message}`);
  }
  const answer = await r.json().catch(() => ({})) as { error?: string };
  if (!r.ok) throw new HttpError(r.status === 404 ? 404 : 400, answer.error ?? `${url} answered ${r.status}`);
  return answer;
}

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
  // Trustees (0066, step 6): name them (with the recovery key); ask them, with both keys lost; vouch, as one; complete.
  route('POST', '/api/person/trustees', async ({ host, req, res }) => {
    await hostPerson(host);
    const b = await readBody(req);
    const keys = await personKeys();
    const line = str(b.line, 'line');
    const ids = Array.isArray(b.ids) ? b.ids.filter((x): x is string => typeof x === 'string') : [];
    const drop = new Set(Array.isArray(b.drop) ? b.drop.filter((k): k is string => typeof k === 'string') : []);
    await keysDo(async () => {
      const known = await knownKeys(host, keys.readRecoveryLine(line).id);
      await keys.nameTrustees(line, { threshold: Number(b.threshold), ids }, known.filter((k) => !drop.has(k)));
    });
    await personChanged(host);
    send(res, 200, { person: await hostPerson(host) });
  }),
  route('POST', '/api/person/trustees/ask', async ({ host, req, res }) => {
    await hostPerson(host);
    const id = str((await readBody(req)).id, 'id');
    const log = host.options.identityLog ? await host.options.identityLog(id) : host.peers ? await (async () => {
      const state = await host.peers!.node.identity.identityState(id);
      return state ? { events: state.events, name: (await host.peers!.node.identity.people()).find((p) => p.key === id)?.name ?? '' } : null;
    })() : null;
    if (!log) throw new HttpError(404, 'None of the workspaces here knows that identity');
    let out: { line: string; trustees: { threshold: number; ids: string[] } } | undefined;
    await keysDo(async () => { out = await (await personKeys()).askTrustees(log.events, log.name, await knownKeys(host, id)); });
    send(res, 200, out);
  }),
  route('POST', '/api/person/trustees/preview', async ({ host, req, res }) => {
    await hostPerson(host);
    const line = str((await readBody(req)).line, 'line');
    let ask: { name: string; id: string } | undefined;
    await keysDo(async () => { ask = (await personKeys()).readTrusteeAsk(line); });
    send(res, 200, { name: ask!.name, id: ask!.id });
  }),
  route('POST', '/api/person/trustees/vouch', async ({ host, req, res }) => {
    await hostPerson(host);
    const line = str((await readBody(req)).line, 'line');
    let answer = '';
    await keysDo(async () => { answer = await (await personKeys()).vouchForAsk(line); });
    send(res, 200, { line: answer });
  }),
  route('POST', '/api/person/trustees/complete', async ({ host, req, res }) => {
    await hostPerson(host);
    const b = await readBody(req);
    const lines = Array.isArray(b.lines) ? b.lines.filter((x): x is string => typeof x === 'string') : [];
    await keysDo(async () => { await (await personKeys()).completeTrustees(lines); });
    await personChanged(host);
    send(res, 200, { person: await hostPerson(host) });
  }),
  // Your email, checked by a verifier (0066, step 6): a code sent there, then an attestation, kept here and said in each workspace.
  route('POST', '/api/person/email/start', async ({ host, req, res }) => {
    await hostPerson(host);
    const b = await readBody(req);
    const url = verifierUrl(b.url);
    const keys = await personKeys();
    const p = await keys.readPerson();
    if (!p) throw new HttpError(400, 'Your identity is not on this computer');
    const email = emailOf(str(b.email, 'email'));
    if (!email) throw new HttpError(400, 'Not an email address');
    await askVerifier(url, '/verify/email/start', { id: p.id, email, log: p.events, proof: crypto.sign(askMessage('email', p.id, `email:${email}`), p.secretKey).toString('hex') });
    send(res, 200, { sent: true });
  }),
  route('POST', '/api/person/email/finish', async ({ host, req, res }) => {
    await hostPerson(host);
    const b = await readBody(req);
    const keys = await personKeys();
    const p = await keys.readPerson();
    if (!p) throw new HttpError(400, 'Your identity is not on this computer');
    const r = await askVerifier(verifierUrl(b.url), '/verify/email/finish', { id: p.id, email: str(b.email, 'email'), code: str(b.code, 'code') }) as { attestation?: unknown };
    const a = readAttestation(r.attestation);
    if (!a || a.id !== p.id) throw new HttpError(502, 'The verifier answered with something that is not an attestation of you');
    await keys.keepAttestation(a);
    await personChanged(host);
    send(res, 200, { person: await hostPerson(host) });
  }),
  // Your recovery key, locked with a passphrase, kept by a verifier that checked your address; and had back with a code (step 6).
  route('POST', '/api/person/escrow/put', async ({ host, req, res }) => {
    await hostPerson(host);
    const b = await readBody(req);
    const url = verifierUrl(b.url);
    const keys = await personKeys();
    const p = await keys.readPerson();
    const line = await keys.recoveryLine();
    if (!p || !line) throw new HttpError(400, 'Your recovery key is not on this computer: it can be locked and kept only while it is');
    const verifier = await askVerifier(url, '/verify', null) as { key?: string; escrow?: boolean };
    if (!verifier.escrow) throw new HttpError(400, 'That server does not keep recovery keys');
    const a = (await keys.attestations()).find((x) => x.id === p.id && x.verifier === verifier.key && x.expires > Date.now());
    if (!a) throw new HttpError(400, 'Have your email address checked by that server first');
    let blob: string;
    try {
      blob = keys.sealRecovery(line, str(b.passphrase, 'passphrase'));
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    await askVerifier(url, '/verify/escrow/put', { attestation: a, blob, id: p.id, log: p.events, proof: crypto.sign(askMessage('escrow', p.id, createHash('sha256').update(blob).digest('hex')), p.secretKey).toString('hex') });
    // Kept there: no longer on this computer (whoever takes it, takes no key with it).
    await keys.recoverySaved();
    send(res, 200, { person: await hostPerson(host), email: a.claim.slice(6) });
  }),
  route('POST', '/api/person/escrow/start', async ({ host, req, res }) => {
    await hostPerson(host);
    const b = await readBody(req);
    await askVerifier(verifierUrl(b.url), '/verify/escrow/start', { email: str(b.email, 'email') });
    send(res, 200, { sent: true });
  }),
  route('POST', '/api/person/escrow/get', async ({ host, req, res }) => {
    await hostPerson(host);
    const b = await readBody(req);
    const r = await askVerifier(verifierUrl(b.url), '/verify/escrow/get', { email: str(b.email, 'email'), code: str(b.code, 'code') }) as { kept?: { blob?: unknown }[] };
    const keys = await personKeys();
    const passphrase = str(b.passphrase, 'passphrase');
    for (const k of r.kept ?? []) {
      const line = typeof k.blob === 'string' ? keys.openRecovery(k.blob, passphrase) : null;
      if (line) return send(res, 200, { line, ...keys.readRecoveryLine(line) });
    }
    throw new HttpError(400, (r.kept ?? []).length ? 'That passphrase opens none of the recovery keys kept for that address' : 'No recovery key is kept for that address');
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
  if (!host.options.manageOnline) throw new HttpError(403, 'The online copy is set up only on the computer running this server, while it is not open to the network');
};
const syncOf = (host: Host, id: string) => {
  const s = host.syncs.get(id);
  if (!s) throw new HttpError(404, `No component for ${id} is loaded on this server`);
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
    if (!host.options.invites) throw new HttpError(403, 'Making invitations from the app is turned off on this server');
    send(res, 200, { links: host.peers ? await host.peers.links() : [] });
  }),

  route('POST', '/api/peers/links', async ({ host, req, res }) => {
    const body = await readBody(req);
    const hours = body.hours === null ? null : Number(body.hours);
    if (hours !== null && !(hours > 0 && hours <= 24 * 366)) throw new HttpError(400, 'A link lasts some hours (up to a year), or has no expiry (null)');
    const peers = await host.peersForInvites();
    // Named before it is shared: whoever joins gets the name (0061).
    await host.ensureName();
    // As a member, unless it says admin (0066).
    const role = body.role === 'admin' ? 'admin' : 'member';
    // For someone by their email, if given: their place waits for an attestation of it (0066, step 6).
    const email = typeof body.email === 'string' && body.email.trim() ? body.email : undefined;
    const link = await allowed(() => peers.inviteLink({ hours, once: body.once === true, role, email }));
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

  // Who may change what (0066): a file's access and suggestions; suggesting; seeing to a suggestion; rules and groups.
  route('GET', '/api/access', async ({ host, res, q }) => {
    const path = str(q.get('path'), 'path');
    send(res, 200, host.peers ? await host.peers.access(path) : { canWrite: true, rule: null, admin: false, suggestions: [], you: null, readers: null });
  }),
  route('POST', '/api/suggestions', async ({ host, req, res }) => {
    const peers = host.peers;
    if (!peers) throw new HttpError(400, 'Suggestions are for a workspace shared with other devices');
    const b = await readBody(req);
    const path = str(b.path, 'path');
    if (typeof b.text !== 'string') throw new HttpError(400, 'A suggestion has a text');
    const text = b.text;
    send(res, 201, { commit: await allowed(() => peers.suggest(path, text)) });
  }),
  route('POST', '/api/suggestions/resolve', async ({ host, req, res }) => {
    const peers = host.peers;
    if (!peers) throw new HttpError(400, 'Suggestions are for a workspace shared with other devices');
    const b = await readBody(req);
    const commit = str(b.commit, 'commit');
    const path = str(b.path, 'path');
    await allowed(() => peers.resolveSuggestion(commit, path, b.accepted === true));
    send(res, 200, { ok: true });
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
    send(res, 200, host.peers ? await host.peers.rules() : { admin: false, rules: [], groups: [], verifiers: [] });
  }),
  // Verifiers whose checks count here (0066, step 6): an admin adds one by its address, or takes one away.
  route('POST', '/api/verifiers', async ({ host, req, res }) => {
    const peers = await host.peersForInvites();
    const url = str((await readBody(req)).url, 'url');
    send(res, 200, await allowed(() => peers.addVerifier(url)));
  }),
  route('DELETE', /^\/api\/verifiers\/([0-9a-f]{64})$/, async ({ host, res, params }) => {
    const peers = await host.peersForInvites();
    send(res, 200, await allowed(() => peers.removeVerifier(params[0]!)));
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

const ROUTES: Route[] = [...workspaceRoutes, ...runRoutes, ...renderRoutes, ...toolRoutes, ...searchRoutes, ...fileRoutes, ...historyRoutes, ...peerRoutes, ...personRoutes, ...syncRoutes, ...writingRoutes];

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
