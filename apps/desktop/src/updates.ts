// The app updating itself (decision 0051), with electron-updater: it looks for
// a newer release where the build says (app-update.yml, written by
// electron-builder from the `publish` setting: GitHub Releases), downloads it
// in the background, only the parts that changed where it can (blockmaps), and
// puts it in place when the app quits, or at once when the person says so
// (Restart now). Each release must be signed as the app is (macOS: the same
// Developer ID; Windows: the same publisher), or it is not installed.
//
// It looks a minute after starting, every four hours, when the app's menu asks
// (Check for Updates…), and when a device of a workspace runs a newer kuraa
// than this one (they do not sync until this one is updated).
//
// Not in a build without a feed (no app-update.yml: run from the repo, or built
// without KURAA_UPDATES), nor in a Linux build not run as an AppImage.
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import electronUpdater from 'electron-updater';

/** Looked for again this often while the app runs. */
const EVERY_MS = 4 * 3600_000;
/** Not looked for more often than this unless asked. */
const AT_MOST_MS = 10 * 60_000;

export interface Updates {
  /** Look for one now. `asked`: the person asked (the menu), so say what was found. */
  check(asked?: boolean): Promise<UpdateCheck>;
  /** The version downloaded and ready to put in place, if any. */
  readonly ready: string | null;
  /** Save (`before`), quit, put the update in place, and start again. */
  restart(before: () => Promise<void>): Promise<void>;
}

export type UpdateCheck =
  | { kind: 'none' }
  | { kind: 'downloading'; version: string }
  | { kind: 'ready'; version: string }
  | { kind: 'failed'; message: string };

/** Whether this build can update itself, and if not, why. */
export function updatable(): string | null {
  if (!app.isPackaged) return 'run from the repository';
  if (!existsSync(join(process.resourcesPath, 'app-update.yml'))) return 'built without a place to look for updates (KURAA_UPDATES)';
  if (process.platform === 'linux' && !process.env.APPIMAGE) return 'not run as an AppImage';
  return null;
}

export function startUpdates(o: { log(m: string): void; ready(version: string): void }): Updates | null {
  const why = updatable();
  if (why) {
    o.log(`[updates] not looking for updates: ${why}`);
    return null;
  }
  // Made on first use, for this platform: only in a build that updates.
  const { autoUpdater } = electronUpdater;
  autoUpdater.logger = { info: (m: unknown) => o.log(`[updates] ${String(m)}`), warn: (m: unknown) => o.log(`[updates] ${String(m)}`), error: (m: unknown) => o.log(`[updates] ${String(m)}`), debug: () => undefined };
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  let ready: string | null = null;
  let last = 0;
  let checking: Promise<UpdateCheck> | null = null;
  autoUpdater.on('update-downloaded', (info: { version: string }) => {
    ready = info.version;
    o.ready(info.version);
  });
  autoUpdater.on('error', (e: Error) => o.log(`[updates] ${e.message}`));

  const check = (asked = false): Promise<UpdateCheck> => {
    if (ready) return Promise.resolve({ kind: 'ready', version: ready });
    if (checking) return checking;
    if (!asked && Date.now() - last < AT_MOST_MS) return Promise.resolve({ kind: 'none' });
    last = Date.now();
    checking = (async (): Promise<UpdateCheck> => {
      try {
        const r = await autoUpdater.checkForUpdates();
        if (!r?.isUpdateAvailable) return { kind: 'none' };
        return ready ? { kind: 'ready', version: ready } : { kind: 'downloading', version: r.updateInfo.version };
      } catch (e) {
        return { kind: 'failed', message: (e as Error).message };
      } finally {
        checking = null;
      }
    })();
    return checking;
  };

  setTimeout(() => void check(), 60_000).unref();
  setInterval(() => void check(), EVERY_MS).unref();

  return {
    check,
    get ready() {
      return ready;
    },
    async restart(before) {
      if (!ready) return;
      await before();
      // Quietly on Windows (no installer window), and start again once in place.
      autoUpdater.quitAndInstall(true, true);
    },
  };
}
