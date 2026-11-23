// Files a component reads and writes in a workspace itself (.kuraa/run.json, a
// package manifest, renv.lock), never through a symbolic link: anyone who can
// change the workspace could make one point anywhere on this computer
// (decision 0037). A path is refused if any part of it below the workspace is
// a link, and the file itself is opened so that a link put there in the
// meantime is not followed either (where the system can tell: not Windows).
import { constants, lstatSync, openSync, readFileSync, closeSync } from 'node:fs';
import { lstat, mkdir, open } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function linkRefused(rel: string): Error {
  return Object.assign(new Error(`${rel} is, or is inside, a symbolic link, which kuraa does not follow`), { code: 'ELOOP' });
}

/** The parts of a workspace path, refusing one outside the workspace. */
function partsOf(root: string, rel: string): string[] {
  const abs = resolve(root, rel);
  const inside = relative(resolve(root), abs);
  if (!inside || inside.startsWith('..') || resolve(root, inside) !== abs) throw new Error(`${rel} is outside the workspace`);
  return inside.split(sep);
}

/** Refuse a link at any part of the path that is there; parts not there yet have nothing to follow. */
function refuseLinksSync(root: string, rel: string, parts: string[]): string {
  let at = resolve(root);
  for (const part of parts) {
    at = join(at, part);
    let s;
    try {
      s = lstatSync(at);
    } catch {
      break;
    }
    if (s.isSymbolicLink()) throw linkRefused(rel);
  }
  return at;
}

/** A workspace file's bytes, never through a link (ENOENT if it is not there). */
export async function readWorkspaceFile(root: string, rel: string): Promise<Buffer> {
  const file = refuseLinksSync(root, rel, partsOf(root, rel));
  const fh = await open(file, constants.O_RDONLY | NOFOLLOW).catch((e: NodeJS.ErrnoException) => {
    throw e.code === 'ELOOP' ? linkRefused(rel) : e;
  });
  try {
    return await fh.readFile();
  } finally {
    await fh.close();
  }
}

/** readWorkspaceFile, for code that cannot wait. */
export function readWorkspaceFileSync(root: string, rel: string): Buffer {
  const file = refuseLinksSync(root, rel, partsOf(root, rel));
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
  } catch (e) {
    throw (e as NodeJS.ErrnoException).code === 'ELOOP' ? linkRefused(rel) : e;
  }
  try {
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Write a workspace file, making its folders, never through a link. */
export async function writeWorkspaceFile(root: string, rel: string, data: string | Uint8Array): Promise<void> {
  const parts = partsOf(root, rel);
  let at = resolve(root);
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    await mkdir(at).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    if (!(await lstat(at)).isDirectory()) throw linkRefused(rel);
  }
  const file = join(at, parts.at(-1)!);
  // Windows cannot refuse a link as it opens: look at the name first.
  if (!NOFOLLOW && (await lstat(file).catch(() => null))?.isSymbolicLink()) throw linkRefused(rel);
  const fh = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | NOFOLLOW, 0o666).catch((e: NodeJS.ErrnoException) => {
    throw e.code === 'ELOOP' ? linkRefused(rel) : e;
  });
  try {
    await fh.writeFile(data);
  } finally {
    await fh.close();
  }
}
