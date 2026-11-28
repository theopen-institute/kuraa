// Watching a workspace's folder for changes made outside the app (host.ts's
// startWatcher): every file and folder in it, by its path from the top.
//
// On macOS and Windows, the system's own recursive watching (fs.watch with
// `recursive`: FSEvents, ReadDirectoryChangesW), which follows paths. Not on
// Linux: there Node watches each file itself (inotify on the file), and once a
// file is replaced by another under its name (as the host saves: a temporary
// file renamed over it) it goes on watching the old one, so edits made to the
// file afterwards are never seen (Node 24). So on Linux each folder is watched
// instead, which tells of any change to a name in it, whichever file it is now;
// folders made later are watched as they appear, and those removed let go.
import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, relative, sep } from 'node:path';

export interface TreeWatcher {
  close(): void;
}

export interface WatchTreeOptions {
  /** Watch each folder (as on Linux), whatever the platform: for tests. */
  folders?: boolean;
  /** Folders not to look into (their own changes are still told, as names in the folder above), by path from the top. */
  skip?: (rel: string) => boolean;
}

/**
 * Watch `dir` and everything in it: `changed` hears each path (from the top, with
 * forward slashes) that changed; `failed`, that watching had to stop (watches run
 * out on Linux, in a large folder).
 */
export function watchTree(dir: string, changed: (rel: string) => void, failed: (err: Error) => void, o: WatchTreeOptions = {}): TreeWatcher {
  const slashed = (p: string) => p.split(sep).join('/');
  if (process.platform !== 'linux' && !o.folders) {
    const w = watch(dir, { recursive: true }, (_event, filename) => {
      if (filename) changed(slashed(String(filename)));
    });
    w.on('error', failed);
    return { close: () => w.close() };
  }

  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  const stop = (err: Error) => {
    if (closed) return;
    close();
    failed(err);
  };
  const close = () => {
    closed = true;
    for (const w of watchers.values()) w.close();
    watchers.clear();
  };
  const isFolder = (abs: string) => {
    try {
      return statSync(abs).isDirectory();
    } catch {
      return false;
    }
  };
  /** Watch a folder and those in it, unless skipped. */
  const add = (abs: string) => {
    if (closed || watchers.has(abs)) return;
    const rel = slashed(relative(dir, abs));
    if (rel && o.skip?.(rel)) return;
    let w: FSWatcher;
    try {
      w = watch(abs, (_event, filename) => {
        if (!filename) return;
        const child = join(abs, String(filename));
        changed(slashed(relative(dir, child)));
        // A folder made (or moved here) is watched too; one gone is let go, with what was in it.
        if (isFolder(child)) {
          add(child);
          scan(child, true);
        } else drop(child);
      });
    } catch (e) {
      // Gone already (made and removed at once): nothing to watch. Out of watches: watching stops.
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      return stop(e as Error);
    }
    w.on('error', (e: NodeJS.ErrnoException) => (e.code === 'ENOENT' || e.code === 'EPERM' ? drop(abs) : stop(e)));
    watchers.set(abs, w);
  };
  /**
   * The folders in a folder, watched. `tell`: a folder that has just appeared (made, or moved here), whose files may
   * have come before its watch did: each is told as changed.
   */
  const scan = (abs: string, tell = false) => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const child = join(abs, e.name);
      if (tell) changed(slashed(relative(dir, child)));
      if (e.isDirectory() && !o.skip?.(slashed(relative(dir, child)))) {
        add(child);
        scan(child, tell);
      }
    }
  };
  const drop = (abs: string) => {
    for (const [path, w] of watchers) {
      if (path === abs || path.startsWith(abs + sep)) {
        w.close();
        watchers.delete(path);
      }
    }
  };
  add(dir);
  scan(dir);
  return { close };
}
