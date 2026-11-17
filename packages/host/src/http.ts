// The host's HTTP surface. Every /api and /git request needs the workspace token.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync, statSync, createReadStream } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, extname, join, resolve, sep } from 'node:path';
import type { Host } from './host.js';
import { HttpError } from './host.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.map': 'application/json',
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function tokenOf(req: IncomingMessage): string | null {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (auth.startsWith('Basic ')) {
    // git sends the token as the password of HTTP basic auth.
    const decoded = Buffer.from(auth.slice(6), 'base64').toString('utf8');
    return decoded.slice(decoded.indexOf(':') + 1);
  }
  return null;
}

function str(v: unknown, name: string): string {
  if (typeof v !== 'string' || !v) throw new HttpError(400, `Missing ${name}`);
  return v;
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

    if (!isApi && !isGit) return serveStatic(host, path, res);

    if (tokenOf(req) !== host.token) {
      if (isGit) res.setHeader('www-authenticate', 'Basic realm="kuraa"');
      send(res, 401, { error: 'Unauthorized' });
      return true;
    }

    try {
      if (isGit) {
        await gitBackend(host, req, res, url);
        return true;
      }
      await api(host, req, res, url);
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 500;
      if (status === 500) host.log(`error: ${(err as Error).stack ?? err}`);
      if (!res.headersSent) send(res, status, { error: (err as Error).message });
      else res.end();
    }
    return true;
  };
}

async function api(host: Host, req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const route = `${req.method} ${url.pathname}`;
  const q = url.searchParams;

  if (route === 'GET /api/workspace') {
    return send(res, 200, {
      name: host.workspace,
      branch: await host.git.branch(),
      head: await host.git.head(),
      types: host.registry.all().map((t) => ({ id: t.id, label: t.label, version: t.version })),
      run: await host.runner.describe(),
    });
  }

  // Packages for an engine (R): declared per workspace, stored once per host.
  if (route === 'GET /api/packages') {
    if (!host.runner.enabled) throw new HttpError(403, 'Running code is turned off on this host.');
    return send(res, 200, { packages: await host.runner.listPackages(str(q.get('engine'), 'engine')) });
  }
  if (route === 'POST /api/packages/install' || route === 'POST /api/packages/remove') {
    if (!host.runner.enabled) throw new HttpError(403, 'Running code is turned off on this host.');
    const body = await readBody(req);
    const engine = str(body.engine, 'engine');
    const list = Array.isArray(body.refs) ? body.refs : Array.isArray(body.names) ? body.names : [];
    const names = list.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 200);
    const by = (body.by ?? null) as { name?: unknown; email?: unknown; color?: unknown } | null;
    const user = by && typeof by.name === 'string' ? { name: by.name, email: typeof by.email === 'string' ? by.email : '', color: typeof by.color === 'string' ? by.color : '#888888' } : null;
    const result = route.endsWith('/install')
      ? await host.runner.installPackages(engine, names, user)
      : await host.runner.removePackages(engine, names, user);
    return send(res, result.ok ? 200 : 422, result);
  }

  // Running chunks: see runner.ts. Progress and outputs reach clients as room messages.
  if (route === 'GET /api/runs') {
    const path = host.relPath(str(q.get('path'), 'path'));
    return send(res, 200, { runs: await host.runner.outputs(path), pending: host.runner.pending(path), session: host.runner.session(path) });
  }

  if (route.startsWith('POST /api/runs')) {
    if (!host.runner.enabled) throw new HttpError(403, 'Running code is turned off on this host. Start it with --engine and --env to turn it on.');
    const body = await readBody(req);
    const path = host.relPath(str(body.path, 'path'));
    if (route === 'POST /api/runs') {
      const engine = host.runner.engineFor(String(body.engine ?? ''));
      if (!engine) throw new HttpError(400, `Nothing on this host runs ${String(body.engine)} chunks.`);
      const { environment } = await host.runner.describe();
      if (!environment?.available) throw new HttpError(503, environment?.message ?? 'No environment to run code in.');
      const chunk = body.chunk as { label?: unknown; index?: unknown; codeHash?: unknown; partial?: unknown } | undefined;
      if (!chunk || typeof chunk.index !== 'number' || typeof chunk.codeHash !== 'string') throw new HttpError(400, 'Missing chunk');
      const by = (body.by ?? {}) as { name?: unknown; email?: unknown; color?: unknown };
      const record = host.runner.run(path, {
        engine,
        code: typeof body.code === 'string' ? body.code : '',
        header: typeof body.header === 'string' ? body.header : 'r',
        chunk: { label: typeof chunk.label === 'string' ? chunk.label : null, index: chunk.index, codeHash: chunk.codeHash, partial: chunk.partial === true },
        by: { name: typeof by.name === 'string' ? by.name : 'Anonymous', email: typeof by.email === 'string' ? by.email : '', color: typeof by.color === 'string' ? by.color : '#888888' },
      });
      return send(res, 202, record);
    }
    if (route === 'POST /api/runs/interrupt') {
      host.runner.interrupt(path);
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/runs/restart') {
      await host.runner.restart(path);
      return send(res, 200, { ok: true });
    }
    if (route === 'POST /api/runs/clear') {
      await host.runner.clear(path, body.chunk as never);
      return send(res, 200, { ok: true });
    }
  }

  if (route === 'GET /api/tree') {
    const out = await host.git.out(['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    const files = [...new Set(out.split('\0').filter(Boolean))]
      .filter((p) => existsSync(join(host.dir, p)))
      .sort()
      .map((p) => ({ path: p, type: host.typeFor(p)?.id ?? null }));
    return send(res, 200, { files });
  }

  if (route === 'GET /api/files') {
    const path = host.relPath(str(q.get('path'), 'path'));
    const abs = host.resolvePath(path);
    if (!existsSync(abs)) throw new HttpError(404, 'No such file');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    createReadStream(abs).pipe(res);
    return;
  }

  if (route === 'POST /api/files') {
    const body = await readBody(req);
    const path = host.relPath(str(body.path, 'path'));
    const abs = host.resolvePath(path);
    if (existsSync(abs)) throw new HttpError(409, 'File exists');
    const content = typeof body.content === 'string' ? body.content : '';
    const commit = await host.serial(async () => {
      await mkdir(dirname(abs), { recursive: true });
      await writeFile(abs, content);
      return host.commitPaths([path], `Create ${path}`);
    });
    return send(res, 201, { path, commit });
  }

  // A folder. git keeps no empty folders, so it gets a .gitkeep (which clients
  // hide) and is committed, so collaborators and other clones have it too.
  if (route === 'POST /api/folders') {
    const body = await readBody(req);
    const path = host.relPath(str(body.path, 'path')).replace(/\/+$/, '');
    if (!path) throw new HttpError(400, 'Missing path');
    const abs = host.resolvePath(path);
    if (existsSync(abs)) throw new HttpError(409, 'A file or folder with that name exists');
    const keep = `${path}/.gitkeep`;
    const commit = await host.serial(async () => {
      await mkdir(abs, { recursive: true });
      await writeFile(join(abs, '.gitkeep'), '');
      return host.commitPaths([keep], `Create folder ${path}`);
    });
    return send(res, 201, { path, commit });
  }

  if (route === 'PATCH /api/files') {
    const body = await readBody(req);
    const from = host.relPath(str(body.from, 'from'));
    const to = host.relPath(str(body.to, 'to'));
    const absFrom = host.resolvePath(from);
    const absTo = host.resolvePath(to);
    if (!existsSync(absFrom)) throw new HttpError(404, 'No such file');
    if (existsSync(absTo)) throw new HttpError(409, 'Target exists');
    const commit = await host.serial(async () => {
      await host.dropRoom(from);
      await mkdir(dirname(absTo), { recursive: true });
      await rename(absFrom, absTo);
      return host.commitPaths([from, to], `Rename ${from} to ${to}`);
    });
    return send(res, 200, { from, to, commit });
  }

  if (route === 'DELETE /api/files') {
    const path = host.relPath(str(q.get('path'), 'path'));
    const abs = host.resolvePath(path);
    if (!existsSync(abs)) throw new HttpError(404, 'No such file');
    const commit = await host.serial(async () => {
      await host.dropRoom(path);
      await rm(abs, { recursive: true });
      return host.commitPaths([path], `Delete ${path}`);
    });
    return send(res, 200, { path, commit });
  }

  if (route === 'GET /api/rooms') {
    const rec = await host.room(str(q.get('path'), 'path'));
    return send(res, 200, host.describe(rec));
  }

  if (route === 'POST /api/versions') {
    const body = await readBody(req);
    const message = typeof body.message === 'string' && body.message.trim() ? body.message.trim() : undefined;
    if (typeof body.path === 'string' && body.path) {
      const rec = await host.room(body.path);
      const commit = await host.commitRoom(rec, message);
      return send(res, 200, { commit });
    }
    await host.serial(() => host.commitAll(message));
    return send(res, 200, { commit: await host.git.head() });
  }

  if (route === 'GET /api/history') {
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
      return { hash, author, email, date, subject, coAuthors, path: pathThen };
    });
    return send(res, 200, { commits });
  }

  const historyAt = /^\/api\/history\/([0-9a-f]{4,40})$/.exec(url.pathname);
  if (req.method === 'GET' && historyAt) {
    const path = host.relPath(str(q.get('path'), 'path'));
    const r = await host.git.run(['show', `${historyAt[1]}:${path}`], { allowFail: true });
    if (r.code !== 0) throw new HttpError(404, 'Not found at that commit');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(r.stdout);
    return;
  }

  if (route === 'POST /api/sync') {
    const result = await host.serial(() => sync(host));
    return send(res, result.ok ? 200 : 409, result);
  }

  throw new HttpError(404, `No route: ${route}`);
}

/** Fetch, merge and push against the upstream remote. */
async function sync(host: Host): Promise<{ ok: boolean; message: string; head?: string | null }> {
  const remotes = (await host.git.out(['remote'])).split('\n').filter(Boolean);
  const remote = host.options.upstream ?? (remotes.includes('origin') ? 'origin' : remotes[0]);
  if (!remote) return { ok: false, message: 'No upstream remote is configured' };
  await host.commitAll();
  const branch = await host.git.branch();
  await host.git.run(['fetch', remote]);
  const hasRemoteBranch = (await host.git.run(['rev-parse', '--verify', '-q', `${remote}/${branch}`], { allowFail: true })).code === 0;
  if (hasRemoteBranch) {
    const merge = await host.git.run(['merge', '--no-edit', `${remote}/${branch}`], { allowFail: true });
    if (merge.code !== 0) {
      await host.git.run(['merge', '--abort'], { allowFail: true });
      return { ok: false, message: `Merge with ${remote}/${branch} conflicts; resolve it outside the app for now.` };
    }
    await host.checkAll();
  }
  await host.git.run(['push', remote, `HEAD:${branch}`]);
  return { ok: true, message: `Synced with ${remote}/${branch}`, head: await host.git.head() };
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
      res.write(chunk);
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

function serveStatic(host: Host, path: string, res: ServerResponse): boolean {
  const root = host.options.staticDir;
  if (!root) {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('kuraa host. Open the web client and point it at this URL.');
    return true;
  }
  const base = resolve(root);
  let file = resolve(base, '.' + decodeURIComponent(path));
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
