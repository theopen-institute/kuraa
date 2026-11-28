// What the editor needs while people write (decision 0040): a workspace file as
// it is, to show an image the document points at; images pasted or dropped into
// a document, kept as its own files (0109) with their details removed (0108);
// how much the workspace's history takes; and who made a commit and when, for
// the labels on a conflict's versions.
//
// Every binary file the page shows is read through /api/raw (0108): the one
// place a file not yet fetched would be fetched, were devices one day to fetch
// large files only when needed.
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
import { cleanImage, filesFolderOf, MAX_IMAGE_BYTES, relativeTarget, sniffImage as sniff, type ImageDetail } from '@kuraa/kernel';

export { MAX_IMAGE_BYTES };

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
  return sniff(bytes);
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

/** An image added: where it is, its address from the document, how large it is as kept, and what was removed from it. */
export interface AddedImage {
  path: string;
  src: string;
  size: number;
  removed: ImageDetail[];
}

/**
 * Keep an image as one of a document's own files (0109): in `report.md.files/`
 * beside it, under a name not yet taken (or the same image's), with its details
 * removed (0108). Whatever the page did already, the host cleans it: what it
 * keeps is clean. Only someone who may change the document adds to its files,
 * and they are read by whoever reads it: in its space, where it is in one.
 */
export async function addImage(host: Host, doc: string, name: string, given: Buffer, by?: { name: string; email: string; color: string } | null): Promise<AddedImage> {
  if (!given.length) throw new HttpError(400, 'The image is empty.');
  if (!sniffImage(given)) throw new HttpError(415, 'Only PNG, JPEG, GIF, WebP and SVG images can be added.');
  const clean = cleanImage(given);
  if (!clean) throw new HttpError(415, 'The image could not be read: its file may be damaged.');
  const ext = clean.type;
  const bytes = Buffer.from(clean.bytes.buffer, clean.bytes.byteOffset, clean.bytes.byteLength);
  if (bytes.length > MAX_IMAGE_BYTES) throw new HttpError(413, 'The image is larger than 20 MB, the most an image may be.');
  const docPath = host.relPath(doc);
  if (host.peers && !(await host.peers.access(docPath)).canWrite) throw new HttpError(403, `You may not change ${docPath}, so you cannot add to its files.`);
  const folder = filesFolderOf(docPath);
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
        // In the document's space (a document of its own audience), else where a file made there goes (0069).
        const space = host.spaceOf(docPath) ?? (host.peers ? await host.peers.spaceForNew(path) : null);
        const coAuthors = by && by.email ? [by] : [];
        if (space) await host.commitIntoSpace(space, [path], `Add image ${path}`, coAuthors);
        else await host.commitPaths([path], `Add image ${path}`, coAuthors);
        break;
      }
      // The same image already there: use it.
      if (createHash('sha256').update(existing).digest('hex') === hash) break;
    }
    // As the document writes it: relative to its folder (spaces and the like made safe).
    const src = encodeURI(relativeTarget(docPath, path));
    return { path, src, size: bytes.length, removed: clean.removed };
  });
}

/**
 * How much the workspace's git objects take on this computer, in bytes: its
 * history (every version of every file, run outputs, spaces), loose and packed.
 */
export async function historySize(host: Host): Promise<number> {
  const r = await host.git.run(['count-objects', '-v'], { allowFail: true });
  if (r.code !== 0) return 0;
  const kib = (key: string) => Number(new RegExp(`^${key}: (\\d+)$`, 'm').exec(r.stdout)?.[1] ?? 0);
  return (kib('size') + kib('size-pack')) * 1024;
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
    path: '/api/storage',
    handle: async (c) => send(c, 200, { history: await historySize(c.host) }),
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

