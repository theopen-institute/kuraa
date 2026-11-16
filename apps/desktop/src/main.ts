// The desktop shell. It either embeds a host on a local folder (loopback, free
// port, random token) or joins a shared host, and loads the web client build.
// It does no file or git work itself: the host does that, through the helpers
// @kuraa/host exports. The connection reaches the page through the preload
// bridge (kuraa:config), not the URL, so reloading the window keeps it.
//
//   electron .                          launcher: open a folder or join a host
//   electron . --open <folder>          embed a host on <folder>
//   electron . --join <url> --token <t> join a shared host; no local host
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { parseArgs } from 'node:util';
import { gitIdentity, inspectFolder, startHost, type HostTimings, type RunningHost } from '@kuraa/host';
import type { ShellConfig } from '@kuraa/client';

const WEB_INDEX = join(__dirname, 'web', 'index.html');
const LAUNCHER = join(__dirname, 'static', 'launcher.html');

let window: BrowserWindow | null = null;
let host: RunningHost | null = null;
let quitting = false;
/** What the page gets from kuraa:config; null while the launcher shows. */
let config: ShellConfig | null = null;

/** Host timings may be shortened for automated tests. */
function timings(): Partial<HostTimings> {
  try {
    return JSON.parse(process.env.KURAA_TIMINGS ?? '{}') as Partial<HostTimings>;
  } catch {
    return {};
  }
}

async function stopHost(): Promise<void> {
  const h = host;
  host = null;
  if (h) await h.close(); // flushes and commits open rooms
}

/** The client sets the window title itself, from the workspace and open file. */
function loadClient(next: ShellConfig): Promise<void> {
  config = next;
  return window!.loadFile(WEB_INDEX);
}

/** Open a local folder with an embedded host. Returns false if the user declined. */
async function openFolder(path: string): Promise<boolean> {
  if (!existsSync(path)) throw new Error(`No such folder: ${path}`);
  const folder = await inspectFolder(path);
  if (!folder.repoRoot) {
    const { response } = await dialog.showMessageBox(window!, {
      type: 'question',
      buttons: ['Initialise', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `${basename(folder.dir)} is not a git repository.`,
      detail: `Initialise one here${folder.entries ? ` and commit the ${folder.entries} item(s) already in the folder` : ''}? The folder stays usable by git and other tools.`,
    });
    if (response !== 0) return false;
  }
  const dir = folder.repoRoot ?? folder.dir;

  await stopHost();
  host = await startHost({
    dir,
    init: !folder.repoRoot,
    host: '127.0.0.1',
    port: 0,
    timings: timings(),
    log: (m) => console.log(`[host] ${m}`),
  });
  console.log(`[desktop] embedded host ${host.url} on ${dir}`);
  const who = await gitIdentity(dir);
  await loadClient({ hostUrl: host.url, token: host.token, ...who, managesHost: true });
  return true;
}

/** Join a shared host. No local host runs. */
async function joinHost(url: string, token: string): Promise<void> {
  await stopHost();
  const who = await gitIdentity(app.getPath('home'));
  await loadClient({ hostUrl: url.replace(/\/$/, ''), token, ...who, managesHost: false });
}

/** Back to the launcher, stopping any embedded host (which flushes and commits). */
async function leave(): Promise<void> {
  await stopHost();
  await showLauncher();
}

async function pickFolder(): Promise<void> {
  const r = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'], message: 'Choose a workspace folder' });
  if (r.canceled || !r.filePaths[0]) return;
  try {
    await openFolder(r.filePaths[0]);
  } catch (e) {
    dialog.showErrorBox('Could not open the folder', (e as Error).message);
  }
}

function showLauncher(): Promise<void> {
  config = null;
  window!.setTitle('kuraa');
  return window!.loadFile(LAUNCHER);
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => void pickFolder() },
        { label: 'Join Shared Host…', click: () => void leave() },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

ipcMain.on('kuraa:config', (e) => {
  e.returnValue = config;
});
ipcMain.handle('kuraa:open-folder', () => pickFolder());
ipcMain.handle('kuraa:leave', () => leave());
ipcMain.handle('kuraa:join', async (_e, url: string, token: string) => {
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/workspace`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return res.status === 401 ? 'The host rejected the token.' : `The host answered ${res.status}.`;
  } catch (e) {
    return `Cannot reach ${url}: ${(e as Error).message}`;
  }
  await joinHost(url, token);
  return null;
});

app.whenReady().then(async () => {
  buildMenu();
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'kuraa',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true },
  });
  window.on('closed', () => (window = null));

  const { values } = parseArgs({
    args: process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => a !== '.'),
    options: { open: { type: 'string' }, join: { type: 'string' }, token: { type: 'string' } },
    strict: false,
  });
  try {
    if (typeof values.open === 'string') {
      if (!(await openFolder(values.open))) await showLauncher();
    } else if (typeof values.join === 'string') {
      await joinHost(values.join, typeof values.token === 'string' ? values.token : '');
    } else {
      await showLauncher();
    }
  } catch (e) {
    dialog.showErrorBox('kuraa', (e as Error).message);
    await showLauncher();
  }
});

// Flush and commit before quitting.
app.on('before-quit', (event) => {
  if (quitting || !host) return;
  event.preventDefault();
  quitting = true;
  void stopHost().finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
