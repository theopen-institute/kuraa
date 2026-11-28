// The order of a folder's files and folders, as people arrange them (0093): a
// plain file in the folder, `.kuraa-order`, one name per line, read by anyone
// and by any tool. It lives where what it orders lives, so it moves with its
// folder, is read by those who read the folder (in the folder's space, 0069),
// and goes when the folder goes. What it does not name comes after what it
// does, as the views sort it; a name of nothing there is passed over, and left
// out when it is next written.

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ORDER_FILE, orderedFolder, orderFileOf, parseOrder } from '@kuraa/feature-kit';
import { NotAllowed } from './errors.js';

// The file's name and how it is read are the contract's (0122), for components to read it as the core does.
export { ORDER_FILE, orderedFolder, orderFileOf, parseOrder };

const HEADER = '# The order of this folder in Kuraa: one file or folder name per line; others follow, by name.\n';

/** An order file's text: null (no file) for no names. */
export function formatOrder(names: readonly string[]): string | null {
  return names.length ? HEADER + names.map((n) => `${n}\n`).join('') : null;
}

const folderOf = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p: string) => p.slice(p.lastIndexOf('/') + 1);

/**
 * How the orders change when a file or folder is renamed or moved (`from` to
 * `to`), by folder: in its own folder, the new name where the old was; moved
 * to another, out of the old folder's order and, where the new folder has an
 * order, at its end. Only the folders whose order changes. A folder's own
 * order file moves with it, so what is inside it needs nothing.
 */
export function ordersAfterRename(orders: ReadonlyMap<string, readonly string[]>, from: string, to: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const [fromDir, toDir] = [folderOf(from), folderOf(to)];
  const was = orders.get(fromDir);
  if (fromDir === toDir) {
    if (was?.includes(nameOf(from))) out.set(fromDir, was.map((n) => (n === nameOf(from) ? nameOf(to) : n)).filter((n, i, all) => all.indexOf(n) === i));
    return out;
  }
  if (was?.includes(nameOf(from))) out.set(fromDir, was.filter((n) => n !== nameOf(from)));
  const into = orders.get(toDir);
  if (into && !into.includes(nameOf(to))) out.set(toDir, [...into, nameOf(to)]);
  return out;
}

/** How the orders change when a file or folder is deleted: out of its folder's order. */
export function ordersAfterDelete(orders: ReadonlyMap<string, readonly string[]>, path: string): Map<string, string[]> {
  const dir = folderOf(path);
  const was = orders.get(dir);
  return was?.includes(nameOf(path)) ? new Map([[dir, was.filter((n) => n !== nameOf(path))]]) : new Map();
}

/** What reading and writing orders needs of the host. */
export interface OrderHost {
  resolvePath(path: string): string;
  serial<T>(fn: () => Promise<T>): Promise<T>;
  requireWritable(): Promise<void>;
  commitPaths(paths: string[], message: string): Promise<string | null>;
  commitIntoSpace(id: string, paths: string[], message: string): Promise<string | null>;
  readonly peers: { spaceForNew(path: string): Promise<string | null>; access(path: string): Promise<{ canWrite: boolean }> } | null;
}

/** The orders of the folders among `paths` that have one, by folder ('' for the top). */
export async function readOrders(host: Pick<OrderHost, 'resolvePath'>, paths: readonly string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  for (const p of paths) {
    const folder = orderedFolder(p);
    if (folder === null) continue;
    const text = await readFile(host.resolvePath(p), 'utf8').catch(() => null);
    if (text !== null) out.set(folder, parseOrder(text));
  }
  return out;
}

/**
 * Write folders' orders (none: the file removed) and commit them, each in its
 * folder's space. With `check`, refused (NotAllowed) where this person may not
 * change one of the folders.
 */
export async function writeOrders(host: OrderHost, orders: ReadonlyMap<string, readonly string[]>, message: string, o: { check?: boolean } = {}): Promise<string | null> {
  if (!orders.size) return null;
  const files = [...orders].map(([folder, names]) => ({ folder, path: orderFileOf(folder), text: formatOrder(names) }));
  if (o.check && host.peers) {
    for (const f of files) if (!(await host.peers.access(f.path)).canWrite) throw new NotAllowed(`You may not change the order of ${f.folder ? `${f.folder}/` : 'the top level'}`);
  }
  // Made in a folder fewer read: into their space (0069), as a new file is.
  const spaces = new Map<string, string | null>();
  for (const f of files) spaces.set(f.path, existsSync(host.resolvePath(f.path)) || !host.peers ? null : await host.peers.spaceForNew(f.path));
  return host.serial(async () => {
    await host.requireWritable();
    let commit: string | null = null;
    const rest: string[] = [];
    for (const f of files) {
      const abs = host.resolvePath(f.path);
      if (f.text === null) {
        await rm(abs, { force: true });
      } else {
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, f.text);
      }
      const space = spaces.get(f.path);
      if (space && f.text !== null) commit = (await host.commitIntoSpace(space, [f.path], message)) ?? commit;
      else rest.push(f.path);
    }
    if (rest.length) commit = (await host.commitPaths(rest, message)) ?? commit;
    return commit;
  });
}
