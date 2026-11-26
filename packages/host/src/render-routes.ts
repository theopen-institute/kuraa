// The HTTP routes for rendering documents (renders.ts) and searching the
// workspace (search.ts), added to http.ts's table.
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Context, Route } from './http.js';
import { personOf, readBody, send } from './http.js';
import { HttpError } from './errors.js';
import { bookName, MIME, RENDER_FORMATS, type RenderFormat } from './renders.js';
import { searchWorkspace } from './search.js';

const route = (method: Route['method'], path: string, handle: (c: Context) => Promise<void>): Route => ({ method, path, handle });

/** A document's path, or a folder's to compile it (0093): ending in `/`, the top level `/`. */
const pathOf = (c: Context, v: unknown) => {
  if (typeof v !== 'string' || !v) throw new HttpError(400, 'Missing path');
  if (!v.endsWith('/')) return c.host.relPath(v);
  if (v === '/') return '/';
  const folder = c.host.relPath(v.replace(/\/+$/, ''));
  if (!folder || !statSync(c.host.resolvePath(folder), { throwIfNoEntry: false })?.isDirectory()) throw new HttpError(404, 'No such folder');
  return `${folder}/`;
};

/** What a folder's compile leaves out (workspace paths) and its title, as asked (0093). */
const compileOf = (c: Context, path: string, body: Record<string, unknown>) => {
  if (!path.endsWith('/')) return undefined;
  const paths = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x).map((x) => c.host.relPath(x.replace(/\/+$/, ''))) : []);
  const title = typeof body.title === 'string' && body.title.trim() ? body.title.trim().slice(0, 300) : bookName(path);
  return { exclude: paths(body.exclude), noHeading: paths(body.noHeading), title };
};

const formatOf = (v: unknown): RenderFormat => {
  if (!RENDER_FORMATS.includes(v as RenderFormat)) throw new HttpError(400, 'Not a format: html, docx or pdf');
  return v as RenderFormat;
};

/** What a rendered page may do if opened on its own: show itself, nothing more (no scripts, no requests). */
const RENDER_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:";

// Rendering documents to HTML, Word and PDF, where code runs; outputs are kept in .git/kuraa/renders.
export const renderRoutes: Route[] = [
  route('GET', '/api/renders', async (c) => send(c.res, 200, await c.host.renders.info(pathOf(c, c.q.get('path'))))),

  route('POST', '/api/renders', async (c) => {
    const body = await readBody(c.req);
    const path = pathOf(c, body.path);
    const { state } = await c.host.renders.render(path, formatOf(body.format), personOf(body.by), compileOf(c, path, body));
    send(c.res, state.state === 'failed' ? 422 : 202, state);
  }),

  route('GET', '/api/renders/file', async (c) => {
    const path = pathOf(c, c.q.get('path'));
    const format = formatOf(c.q.get('format'));
    const bytes = await c.host.renders.output(path, format);
    if (!bytes) throw new HttpError(404, 'Not rendered yet');
    const name = `${path.endsWith('/') ? bookName(path) : basename(path).replace(/\.[^.]*$/, '')}.${format}`;
    c.res.writeHead(200, {
      'content-type': MIME[format], 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
      ...(format === 'html' ? { 'content-security-policy': RENDER_CSP } : {}),
    });
    c.res.end(bytes);
  }),

  // The files the latest output was made from, put together as they were (0081), as a zip.
  route('GET', '/api/renders/made-from', async (c) => {
    const path = pathOf(c, c.q.get('path'));
    const format = formatOf(c.q.get('format'));
    const made = await c.host.renders.madeFrom(path, format);
    if (!made) throw new HttpError(404, 'This render does not say what it was made from: render it again.');
    const name = `${basename(path).replace(/\.[^.]*$/, '')}-${format}-made-from`;
    const bytes = await c.host.madeFromZip(made, name);
    c.res.writeHead(200, {
      'content-type': 'application/zip', 'content-length': bytes.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${name}.zip`)}`,
    });
    c.res.end(bytes);
  }),
];

// Searching the workspace's text files, and open documents as they are being edited.
export const searchRoutes: Route[] = [
  route('GET', '/api/search', async (c) => {
    const query = c.q.get('q') ?? '';
    if (!query.trim() || query.length > 500 || query.includes('\n')) throw new HttpError(400, 'Search for a phrase of up to 500 characters, on one line');
    send(c.res, 200, await searchWorkspace(c.host, query, c.q.get('case') === '1'));
  }),
];
