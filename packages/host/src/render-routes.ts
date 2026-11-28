// The HTTP routes for rendering documents (renders.ts), added to http.ts's
// table. Searching is @kuraa/search's (0120), on its own routes.
import { statSync } from 'node:fs';
import { basename } from 'node:path';
import type { Context, Route } from './http.js';
import { personOf, readBody, send } from './http.js';
import { HttpError } from './errors.js';
import { bookName, MIME, RENDER_FORMATS, type CompileOptions, type RenderFormat } from './renders.js';

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

/** What a folder's compile leaves out (workspace paths) and its title, as asked (0093); the rest of the book as it says (0106). */
const compileOf = (c: Context, path: string, body: Record<string, unknown>): CompileOptions | undefined => {
  if (!path.endsWith('/')) return undefined;
  const paths = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x).map((x) => c.host.relPath(x.replace(/\/+$/, ''))) : []);
  const text = (v: unknown, most = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, most) : null);
  const file = (v: unknown) => (typeof v === 'string' && v.trim() ? c.host.relPath(v.trim()) : null);
  return {
    exclude: paths(body.exclude),
    noHeading: paths(body.noHeading),
    // The top level ('') is a folder too: its documents may have no titles.
    noTitles: Array.isArray(body.noTitles) ? body.noTitles.filter((x): x is string => typeof x === 'string').map((x) => (x.replace(/^\/+|\/+$/g, '') ? c.host.relPath(x.replace(/\/+$/, '')) : '')) : [],
    title: text(body.title) ?? bookName(path),
    subtitle: text(body.subtitle),
    author: text(body.author),
    toc: body.toc === true,
    numbering: body.numbering === 'chapters' || body.numbering === 'sections' ? body.numbering : null,
    separator: text(body.separator, 100),
    referenceDoc: file(body.referenceDoc),
    cover: file(body.cover),
  };
};

const formatOf = (v: unknown): RenderFormat => {
  if (!RENDER_FORMATS.includes(v as RenderFormat)) throw new HttpError(400, 'Not a format: html, docx, pdf or epub');
  return v as RenderFormat;
};

/** What a rendered page may do if opened on its own: show itself, nothing more (no scripts, no requests). */
const RENDER_CSP = "sandbox; default-src 'none'; img-src data:; style-src 'unsafe-inline' data:; font-src data:; media-src data:";

// Rendering documents to HTML, Word, PDF and EPUB, where code runs; outputs are kept in .git/kuraa/renders.
export const renderRoutes: Route[] = [
  route('GET', '/api/renders', async (c) => send(c.res, 200, await c.host.renders.info(pathOf(c, c.q.get('path'))))),

  // What a folder's book could have (0093): its folders and documents in the file tree's order, each at its depth.
  route('GET', '/api/renders/contents', async (c) => {
    const path = pathOf(c, c.q.get('path'));
    if (!path.endsWith('/')) throw new HttpError(400, 'A folder: its path ending in /');
    send(c.res, 200, { items: await c.host.bookContents(path === '/' ? '' : path.slice(0, -1)) });
  }),

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
