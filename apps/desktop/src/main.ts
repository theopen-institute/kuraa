// The desktop shell. It embeds a hub (loopback, free port, random token): your
// workspaces, added from the app as new folders, folders you open, or joined
// from invitations and links (see @kuraa/host's hub.ts). Or it joins a shared
// host or hub, running none of its own. It loads the web client build, and does
// no file or git work itself: the hub does that, through the helpers @kuraa/host
// exports. The connection reaches the page through the preload bridge
// (kuraa:config), not the URL, so reloading the window keeps it.
//
//   electron .                          your workspaces
//   electron . --open <folder>          your workspaces, with <folder> added and open
//   electron . --join <url> --token <t> join a shared host or hub; none of its own
//   --workspaces <folder>               where new workspaces go (default: Documents/kuraa)
//
// For folders it opens itself, as for any host, the configuration is flags:
//   --engine <id>...     engines to turn on (default: r); --engine none for none
//   --env <id>           where code runs (default: the only environment loaded)
//   --format <id>...     document formats to turn on (default: all)
//   --component <spec>...   more run components (engines, environments)
//   --allow-unsandboxed  allow an environment that is not sandboxed
//   --peer               sync with the folder's paired devices (pair them with kuraa-host invite / join)
// The components that ship (@kuraa/run-components: R, Podman containers) are loaded.
//
// The window shows only the app's own pages: it does not navigate elsewhere or
// open other windows (web links open in the browser), and the bridge answers
// only the app's own pages.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gitIdentity, inspectFolder, startHub, type HostTimings, type RunOptions, type RunningHub } from '@kuraa/host';
import { standardRunComponents } from '@kuraa/run-components';
import type { ShellConfig } from '@kuraa/client';

const WEB_INDEX = join(__dirname, 'web', 'index.html');
const LAUNCHER = join(__dirname, 'static', 'launcher.html');
/** The only pages the window may show. */
const OWN_PAGES = [WEB_INDEX, LAUNCHER].map((p) => pathToFileURL(p).href);
const isOwnPage = (url: string) => OWN_PAGES.includes(url.split(/[?#]/)[0]!);

const { values: flags } = parseArgs({
  args: process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => a !== '.'),
  options: {
    open: { type: 'string' }, join: { type: 'string' }, token: { type: 'string' },
    engine: { type: 'string', multiple: true }, env: { type: 'string' }, format: { type: 'string', multiple: true },
    component: { type: 'string', multiple: true }, 'allow-unsandboxed': { type: 'boolean' }, peer: { type: 'boolean' },
    workspaces: { type: 'string' },
  },
  strict: false,
});
const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

let window: BrowserWindow | null = null;
let hub: RunningHub | null = null;
let quitting = false;
/** What the page gets from kuraa:config; null while the launcher shows. */
let config: ShellConfig | null = null;

/** What runs, for folders this app opens itself: R unless --engine says otherwise, where --env says. */
function runOptions(): RunOptions {
  const engines = (list(flags.engine) ?? ['r']).filter((e) => e !== 'none');
  return {
    engines,
    environment: typeof flags.env === 'string' ? flags.env : undefined,
    components: [...standardRunComponents, ...(list(flags.component) ?? [])],
    allowUnsandboxed: flags['allow-unsandboxed'] === true,
    allowInstalls: true,
  };
}

/** Host timings may be shortened for automated tests. */
function timings(): Partial<HostTimings> {
  try {
    return JSON.parse(process.env.KURAA_TIMINGS ?? '{}') as Partial<HostTimings>;
  } catch {
    return {};
  }
}

async function stopHub(): Promise<void> {
  const h = hub;
  hub = null;
  if (h) await h.close(); // flushes and commits open rooms
}

/** The client sets the window title itself, from the workspace and open file. */
function loadClient(next: ShellConfig): Promise<void> {
  config = next;
  return window!.loadFile(WEB_INDEX);
}

/** This app's hub, started if it is not running. */
async function ensureHub(): Promise<RunningHub> {
  if (hub) return hub;
  const custom = typeof flags.workspaces === 'string';
  hub = await startHub({
    root: custom ? (flags.workspaces as string) : join(app.getPath('documents'), 'kuraa'),
    // With the default folder, the list lives with the app's own data, not in Documents.
    registry: custom ? undefined : join(app.getPath('userData'), 'workspaces.json'),
    host: '127.0.0.1',
    port: 0,
    // What runs and which formats are on: this app's flags.
    hosts: { run: runOptions(), formats: list(flags.format), timings: timings() },
    peers: { everywhere: flags.peer === true },
    log: (m) => console.log(`[hub] ${m}`),
  });
  console.log(`[desktop] hub ${hub.url} on ${hub.hub.root}`);
  return hub;
}

/**
 * Your workspaces: the hub, in the client, with `workspace` open if given. The
 * name and email suggested are git's, for `folder` (a folder just opened) or in general.
 */
async function showWorkspaces(workspace?: string, folder = app.getPath('home')): Promise<void> {
  const h = await ensureHub();
  const who = await gitIdentity(folder);
  await loadClient({ hostUrl: h.url, token: h.token, ...who, managesHost: true, workspace });
}

/** Add a local folder to the workspaces, and open it. Returns false if the user declined. */
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
  const h = await ensureHub();
  const w = await h.hub.addFolder(folder.repoRoot ?? folder.dir, !folder.repoRoot);
  await showWorkspaces(w.id, w.path);
  return true;
}

/** Join a shared host or hub. None of this app's own runs. */
async function joinHost(url: string, token: string): Promise<void> {
  await stopHub();
  const who = await gitIdentity(app.getPath('home'));
  await loadClient({ hostUrl: url.replace(/\/$/, ''), token, ...who, managesHost: false });
}

/** Back to the launcher, stopping this app's hub (which flushes and commits). */
async function leave(): Promise<void> {
  await stopHub();
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
        { label: 'Your Workspaces', click: () => void showWorkspaces() },
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

/** Whether a bridge call comes from one of the app's own pages (not a page that got into the window somehow). */
const fromOwnPage = (e: IpcMainEvent | IpcMainInvokeEvent) => !!e.senderFrame && isOwnPage(e.senderFrame.url);

ipcMain.on('kuraa:config', (e) => {
  e.returnValue = fromOwnPage(e) ? config : null;
});
ipcMain.handle('kuraa:open-folder', (e) => (fromOwnPage(e) ? pickFolder() : undefined));
ipcMain.handle('kuraa:leave', (e) => (fromOwnPage(e) ? leave() : undefined));
ipcMain.handle('kuraa:home', (e) => (fromOwnPage(e) ? showWorkspaces() : undefined));
ipcMain.handle('kuraa:join', async (e, url: string, token: string) => {
  if (!fromOwnPage(e)) return 'Not allowed.';
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/workspace`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return res.status === 401 ? 'The host rejected the token.' : `The host answered ${res.status}.`;
  } catch (e) {
    return `Cannot reach ${url}: ${(e as Error).message}`;
  }
  await joinHost(url, token);
  return null;
});

// No page in this app opens windows, navigates away, or embeds web views. A
// link to the web opens in the browser; anything else goes nowhere.
app.on('web-contents-created', (_e, contents) => {
  const openOutside = (url: string) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
  };
  contents.setWindowOpenHandler(({ url }) => {
    openOutside(url);
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => {
    if (isOwnPage(url)) return;
    event.preventDefault();
    openOutside(url);
  });
  contents.on('will-redirect', (event, url) => {
    if (!isOwnPage(url)) event.preventDefault();
  });
  contents.on('will-attach-webview', (event) => event.preventDefault());
});

app.whenReady().then(async () => {
  buildMenu();
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'kuraa',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false },
  });
  window.on('closed', () => (window = null));

  const values = flags;
  try {
    if (typeof values.open === 'string') {
      if (!(await openFolder(values.open))) await showLauncher();
    } else if (typeof values.join === 'string') {
      await joinHost(values.join, typeof values.token === 'string' ? values.token : '');
    } else {
      await showWorkspaces();
    }
  } catch (e) {
    dialog.showErrorBox('kuraa', (e as Error).message);
    await showLauncher();
  }
});

// Flush and commit before quitting.
app.on('before-quit', (event) => {
  if (quitting || !hub) return;
  event.preventDefault();
  quitting = true;
  void stopHub().finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
