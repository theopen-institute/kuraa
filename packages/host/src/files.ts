// Files and names that work on every computer a workspace goes to, Windows too.
import { rename } from 'node:fs/promises';

/** Names Windows keeps for devices, with or without an extension (nul.txt is the device too). */
const RESERVED = /^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]|conin\$|conout\$)(\..*)?$/i;

/** Whether Windows keeps this name (one path segment) for a device. */
export function reservedName(name: string): boolean {
  return RESERVED.test(name);
}

/**
 * Why a new workspace path (relative, with '/') could not be a file on every
 * computer, or null if it could. Windows refuses some characters and the names
 * it keeps, and drops dots and spaces at the end of a name; a file made with one
 * elsewhere could not be checked out on Windows.
 */
export function unportablePath(path: string): string | null {
  for (const part of path.split('/')) {
    if (/[<>:"\\|?*\x00-\x1f]/.test(part)) return `“${part}”: names cannot have any of < > : " \\ | ? * (Windows does not allow them)`;
    if (/[. ]$/.test(part)) return `“${part}”: names cannot end with a dot or a space (Windows drops them)`;
    if (reservedName(part)) return `“${part}”: Windows keeps that name for a device`;
  }
  return null;
}

const BUSY = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Rename `from` over `to`. On Windows that fails while another program has `to`
 * open (a virus scanner, the search indexer, an editor), or another rename onto
 * it is under way, usually only for a moment: try again for about a second.
 */
export async function renameOver(from: string, to: string): Promise<void> {
  for (let wait = 10; ; wait *= 2) {
    try {
      return await rename(from, to);
    } catch (e) {
      if (process.platform !== 'win32' || !BUSY.has((e as NodeJS.ErrnoException).code ?? '') || wait > 1000) throw e;
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}
