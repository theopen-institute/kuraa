// Check for Updates…: a small window of the app's own, over the main one
// (modal: a sheet on macOS), that stays open and shows how updating goes, as it
// goes: looking, downloading with a bar (how much of how much, how fast), then
// Restart Now or Later; or that this is the latest version, or why it could not
// update. Hide closes it while the download goes on: the page says when it is
// ready (decision 0051). The Dock or taskbar icon shows the download's bar too.
//
// Its page (static/updates.html) draws what it is sent (update-view.ts) and
// says which button was pressed, through a preload of its own
// (updates-preload.ts) that offers nothing else.
import { BrowserWindow, ipcMain, type IpcMainEvent } from 'electron';
import { join } from 'node:path';
import { D } from './strings.js';
import type { Updates } from './updates.js';
import { updateView, type UpdateChoice, type UpdateStatus } from './update-view.js';

export const UPDATES_PAGE = join(__dirname, 'static', 'updates.html');

const WIDTH = 440;

export interface UpdateWindowDeps {
  /** The window it shows over (and whose Dock or taskbar icon shows the bar), if any. */
  parent: () => BrowserWindow | null;
  /** The updater; null if this copy does not update itself, and `why`. */
  updates: Updates | null;
  why: () => string;
  /** This app's version. */
  current: string;
  /** Save, quit, put the update in place, and start again. */
  restart: () => Promise<void>;
  /** The window's own options (sandboxed, and so on: main.ts). */
  webPreferences: Electron.WebPreferences;
}

export function updateWindow(d: UpdateWindowDeps): { show(): Promise<void> } {
  let win: BrowserWindow | null = null;
  let status: UpdateStatus | null = null;

  const fromIt = (e: IpcMainEvent) => !!win && !win.isDestroyed() && e.sender === win.webContents;
  const send = () => {
    if (!win || win.isDestroyed() || !status) return;
    win.webContents.send('kuraa-updates:view', updateView(status, d.current));
  };
  const show = (s: UpdateStatus) => {
    status = s;
    send();
  };

  // The Dock or taskbar icon: the download's bar, whether the window is open or not.
  d.updates?.onStatus((s) => {
    const parent = d.parent();
    if (parent && !parent.isDestroyed()) parent.setProgressBar(s.kind === 'downloading' ? (s.progress && s.progress.total > 0 ? s.progress.percent / 100 : 2) : -1);
    if (win) show(s);
  });

  ipcMain.on('kuraa-updates:ready', (e) => {
    if (fromIt(e)) send();
  });
  // The page's height, as drawn: the window fits it.
  ipcMain.on('kuraa-updates:size', (e, height: unknown) => {
    if (fromIt(e) && typeof height === 'number' && height > 0 && height < 1000) win!.setContentSize(WIDTH, Math.ceil(height));
  });
  ipcMain.on('kuraa-updates:choose', (e, choice: unknown) => {
    if (!fromIt(e)) return;
    const c = choice as UpdateChoice;
    if (c !== 'restart') return void win!.close();
    // Kept open while it saves and quits; if it does not (a package's password refused), it says why.
    void d.restart().catch((err: Error) => show({ kind: 'failed', message: err.message }));
  });

  return {
    async show() {
      if (win && !win.isDestroyed()) {
        win.focus();
      } else {
        const parent = d.parent();
        win = new BrowserWindow({
          title: D.updates.title,
          width: WIDTH,
          height: 150,
          useContentSize: true,
          resizable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          show: false,
          ...(parent && !parent.isDestroyed() ? { parent, modal: true } : {}),
          webPreferences: { ...d.webPreferences, preload: join(__dirname, 'updates-preload.cjs') },
        });
        win.setMenu(null);
        win.once('ready-to-show', () => win?.show());
        win.on('closed', () => (win = null));
        await win.loadFile(UPDATES_PAGE);
      }
      if (!d.updates) return show({ kind: 'off', why: d.why() });
      // What it stands at now, then looks (unless downloading or ready already: it shows how that goes).
      const now = d.updates.status;
      if (now && (now.kind === 'downloading' || now.kind === 'ready')) return show(now);
      show({ kind: 'checking' });
      await d.updates.check(true);
      // The check said nothing as it went (it had looked moments ago): what it found.
      if (status?.kind === 'checking' && d.updates.status) show(d.updates.status);
    },
  };
}
