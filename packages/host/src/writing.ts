// What the editor needs while people write (decision 0040): a workspace file as
// it is, to show an image the document points at; images pasted or dropped into
// a document, kept in the workspace beside it; and who made a commit and when,
// for the labels on a conflict's versions.
//
// Files are read and written only inside the workspace, never through a
// symbolic link, and never in .git (host.resolvePath).
import type { IncomingMessage } from 'node:http';
import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { relative, sep } from 'node:path';
import type { Host } from './host.js';
import type { Context, Route } from './http.js';
import { HttpError } from './errors.js';
import { unportablePath } from './files.js';

/** The largest image that may be added. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** Types a workspace file is served as, by extension. Anything else is a download, never shown. */
const TYPES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  avif: 'image/avif', bmp: 'image/bmp', ico: 'image/x-icon', pdf: 'application/pdf',
  txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', csv: 'text/plain; charset=utf-8', json: 'application/json',
};

const send = (c: Context, status: number, body: unknown) => {
  c.res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  c.res.end(JSON.stringify(body));
};

/**
 * A workspace path's file: resolvePath refuses one reached through a symbolic
 * link at any step (a link could lead outside the workspace), and here anything
 * but a plain file is refused too.
 */
export function workspaceFile(host: Host, path: string): { abs: string; rel: string } {
  const abs = host.resolvePath(path);
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    throw new HttpError(404, 'No such file');
  }
  if (!st.isFile()) throw new HttpError(st.isSymbolicLink() ? 403 : 404, 'No such file');
  return { abs, rel: relative(host.dir, abs).split(sep).join('/') };
}

/** The image type its bytes say it is (by extension), or null. SVG must at least look like SVG. */
export function sniffImage(bytes: Buffer): string | null {
  const hex = bytes.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return 'png';
  if (hex.startsWith('ffd8ff')) return 'jpg';
  if (hex.startsWith('474946383761') || hex.startsWith('474946383961')) return 'gif';
  if (hex.startsWith('52494646') && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  const head = bytes.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '').trimStart();
  if ((head.startsWith('<?xml') || head.startsWith('<svg') || head.startsWith('<!--') || head.startsWith('<!DOCTYPE svg')) && /<svg[\s>]/.test(head)) return 'svg';
  return null;
}

/** A filename safe on every computer the workspace goes to: lowercase words joined by dashes, with the image's extension. */
export function safeImageName(name: string, ext: string): string {
  const stem = name
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
  const safe = `${stem || 'image'}.${ext}`;
  return unportablePath(safe) ? `image-${stem}.${ext}` : safe;
}

async function readBytes(req: IncomingMessage, max: number): Promise<Buffer> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (declared > max) throw new HttpError(413, 'The image is larger than 20 MB, the most an image may be.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > max) throw new HttpError(413, 'The image is larger than 20 MB, the most an image may be.');
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks);
}

/** Keep an image next to a document: in its folder's `images/`, under a name not yet taken (or the same image's). */
export async function addImage(host: Host, doc: string, name: string, bytes: Buffer, by?: { name: string; email: string; color: string } | null): Promise<{ path: string; src: string }> {
  if (!bytes.length) throw new HttpError(400, 'The image is empty.');
  const ext = sniffImage(bytes);
  if (!ext) throw new HttpError(415, 'Only PNG, JPEG, GIF, WebP and SVG images can be added.');
  const docPath = host.relPath(doc);
  const folder = docPath.includes('/') ? `${docPath.slice(0, docPath.lastIndexOf('/'))}/images` : 'images';
  const base = safeImageName(name, ext);
  const stem = base.slice(0, -(ext.length + 1));
  const hash = createHash('sha256').update(bytes).digest('hex');
  return host.serial(async () => {
    // Not while git is busy outside the app (a rebase, a merge): 409 until it is done.
    await host.requireWritable();
    let path: string;
    for (let n = 1; ; n++) {
      path = `${folder}/${n === 1 ? stem : `${stem}-${n}`}.${ext}`;
      // resolvePath refuses the folder or file if it is (or goes through) a link.
      const abs = host.resolvePath(path);
      let existing: Buffer | null = null;
      try {
        existing = lstatSync(abs).isFile() ? readFileSync(abs) : Buffer.alloc(0);
      } catch { /* free */ }
      if (existing === null) {
        await mkdir(host.resolvePath(folder), { recursive: true });
        await writeFile(abs, bytes, { flag: 'wx' });
        await host.commitPaths([path], `Add image ${path}`, by && by.email ? [by] : []);
        break;
      }
      // The same image already there: use it.
      if (createHash('sha256').update(existing).digest('hex') === hash) break;
    }
    const src = path.slice(folder.length - 'images'.length);
    return { path, src };
  });
}

export const writingRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/raw',
    handle: ({ host, res, q }) => {
      const { abs, rel } = workspaceFile(host, String(q.get('path') ?? ''));
      const ext = /\.([A-Za-z0-9]+)$/.exec(rel)?.[1]?.toLowerCase() ?? '';
      const type = TYPES[ext];
      res.writeHead(200, {
        'content-type': type ?? 'application/octet-stream',
        'x-content-type-options': 'nosniff',
        'cache-control': 'no-store',
        // An SVG opened on its own runs nothing; elsewhere, only a download.
        'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:",
        ...(type ? {} : { 'content-disposition': 'attachment' }),
      });
      createReadStream(abs).pipe(res);
    },
  },
  {
    method: 'POST',
    path: '/api/images',
    handle: async (c) => {
      const doc = c.q.get('doc');
      if (!doc) throw new HttpError(400, 'Missing doc');
      const bytes = await readBytes(c.req, MAX_IMAGE_BYTES);
      const name = c.q.get('name') ?? 'image';
      const by = c.q.get('by') ? { name: c.q.get('by')!, email: c.q.get('email') ?? '', color: '#888888' } : null;
      send(c, 201, await addImage(c.host, doc, name, bytes, by));
    },
  },
  {
    method: 'GET',
    path: /^\/api\/commits\/([0-9a-f]{4,40})$/,
    handle: async (c) => {
      const r = await c.host.git.run(['show', '-s', '--format=%an%x00%aI', `${c.params[0]}^{commit}`, '--'], { allowFail: true });
      if (r.code !== 0) throw new HttpError(404, 'No such commit');
      const [author = '', date = ''] = r.stdout.trim().split('\0');
      send(c, 200, { author, date });
    },
  },
];

