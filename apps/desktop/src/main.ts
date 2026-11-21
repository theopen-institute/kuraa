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
// For folders it opens itself, the configuration is its Preferences: the hub's
// settings (@kuraa/host's settings.ts, decisions 0046 and 0047), kept in
// preferences.json with the app's data, changed in the client's Preferences
// dialog as in a browser, and applied by the hub in place. These flags win:
//   --engine <id>...     engines to turn on (default: r); --engine none for none
//   --env <id>           where code runs (default: the only environment loaded)
//   --format <id>...     document formats to turn on (default: all)
//   --component <spec>...   more run components (engines, environments): flag only, see 0047
//   --allow-unsandboxed  allow an environment that is not sandboxed: flag only, see 0047
//   --podman <path>      the Podman program (also KURAA_PODMAN): flag only, see 0047
//   --r-image <image>... base images a workspace may name for R (besides the default)
// The components that ship (@kuraa/run-components: R, Podman containers) are loaded.
//
// It runs the git it ships with (vendor/git, see scripts/fetch-git.mjs), so the
// computer needs none, and every device runs the same one. Run from the repo
// without it fetched, it uses the computer's git.
//
// It updates itself from the releases it was built to look at (updates.ts,
// decision 0051): in the background, put in place when it quits, or at once
// from the page's Restart now.
//
// The window shows only the app's own pages: it does not navigate elsewhere or
// open other windows (web links open in the browser), and the bridge answers
// only the app's own pages.
import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type ContextMenuParams, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gitIdentity, inspectFolder, lastResort, onNewerVersion, SettingsStore, startHub, useGit, type HostTimings, type RunningHub, type Settings } from '@kuraa/host';
import { standardRunComponents } from '@kuraa/run-components';
import type { ShellConfig } from '@kuraa/client';
import { D } from './strings.js';
import { startUpdates, updatable, type Updates } from './updates.js';
import { keepLog, logFile } from './log.js';

const WEB_INDEX = join(__dirname, 'web', 'index.html');
const LAUNCHER = join(__dirname, 'static', 'launcher.html');
/** The only pages the windows may show. */
const OWN_PAGES = [WEB_INDEX, LAUNCHER].map((p) => pathToFileURL(p).href);
const isOwnPage = (url: string) => OWN_PAGES.includes(url.split(/[?#]/)[0]!);

const { values: flags } = parseArgs({
  args: process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => a !== '.'),
  options: {
    open: { type: 'string' }, join: { type: 'string' }, token: { type: 'string' },
    engine: { type: 'string', multiple: true }, env: { type: 'string' }, format: { type: 'string', multiple: true },
    component: { type: 'string', multiple: true }, 'allow-unsandboxed': { type: 'boolean' },
    workspaces: { type: 'string' },
    'r-image': { type: 'string', multiple: true },
    podman: { type: 'string' },
  },
  strict: false,
});
const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);

/** The git this app ships, if it has one here; else the computer's. */
function useBundledGit(): void {
  const os = ({ darwin: 'mac', win32: 'win', linux: 'linux' } as Record<string, string>)[process.platform] ?? process.platform;
  const dir = app.isPackaged ? join(process.resourcesPath, 'git') : join(__dirname, '..', 'vendor', 'git', `${os}-${process.arch}`);
  if (!existsSync(dir)) {
    if (app.isPackaged) console.error(`[desktop] no git at ${dir}; using the computer's`);
    return;
  }
  // Its own system-wide settings are left out (the Windows build's turn on autocrlf,
  // which would change the line endings of files the app writes); the person's own (~/.gitconfig) apply.
  const env: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1' };
  if (process.platform === 'win32') {
    // MinGit's layout: the programs git runs (and sh, for git-remote-kuraa) on PATH. Git
    // itself is run directly, not through cmd\git.exe, a launcher that stopping would leave git running.
    env.PATH = [join(dir, 'ucrt64', 'bin'), join(dir, 'usr', 'bin'), join(dir, 'cmd'), process.env.PATH ?? process.env.Path ?? ''].join(';');
    env.GIT_EXEC_PATH = join(dir, 'ucrt64', 'libexec', 'git-core');
    useGit(join(dir, 'ucrt64', 'bin', 'git.exe'), env);
  } else {
    env.GIT_EXEC_PATH = join(dir, 'libexec', 'git-core');
    env.GIT_TEMPLATE_DIR = join(dir, 'share', 'git-core', 'templates');
    useGit(join(dir, 'bin', 'git'), env);
  }
}
useBundledGit();

// Tests keep the app's own data (preferences, the list of workspaces) apart from the person's.
if (process.env.KURAA_USER_DATA) app.setPath('userData', process.env.KURAA_USER_DATA);
// The log, in a file: with its data when that is given (tests), else where the system keeps apps' logs.
keepLog(process.env.KURAA_USER_DATA ? join(app.getPath('userData'), 'logs') : undefined);
// Tests run the app out of sight: its windows are never shown, and on a Mac it stays out of the
// Dock and never comes to the front, so it does not take the screen from whoever is working.
const HIDDEN = process.env.KURAA_HIDDEN_WINDOWS === '1';
if (HIDDEN && process.platform === 'darwin') app.setActivationPolicy('accessory');
/** What every window of the app is made with. */
const windowOptions = () => ({
  show: !HIDDEN,
  webPreferences: {
    preload: join(__dirname, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webviewTag: false,
    // A hidden window is otherwise slowed down as if in the background.
    backgroundThrottling: !HIDDEN,
  },
});
// Its preferences: the hub's settings, kept where they always were, with the app's data.
const PREFERENCES_FILE = join(app.getPath('userData'), 'preferences.json');

/** The settings flags set, which win over the preferences, and which the Preferences dialog shows as such. */
function flagSettings(): Partial<Settings> {
  const engines = list(flags.engine);
  return {
    ...(engines ? { runCode: engines.some((e) => e !== 'none') } : {}),
    ...(list(flags['r-image']) ? { rImages: list(flags['r-image']) } : {}),
    ...(list(flags.format) ? { formats: list(flags.format) } : {}),
    ...(typeof flags.env === 'string' ? { environment: flags.env } : {}),
    ...(typeof flags.workspaces === 'string' ? { workspaces: resolve(flags.workspaces) } : {}),
  };
}
const settings = new SettingsStore(PREFERENCES_FILE, flagSettings());

const defaultWorkspaces = () => join(app.getPath('documents'), 'kuraa');

let window: BrowserWindow | null = null;
let hub: RunningHub | null = null;
let quitting = false;
let updates: Updates | null = null;
/** What the page gets from kuraa:config; null while the launcher shows. */
let config: ShellConfig | null = null;

/** Automated tests may shorten the host's timings (KURAA_TIMINGS): they win over the preferences. */
function testTimings(): Partial<HostTimings> {
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
  // --workspaces keeps the list in that folder; otherwise it lives with the app's own data, so it survives choosing another folder.
  const custom = typeof flags.workspaces === 'string';
  const engines = list(flags.engine);
  hub = await startHub({
    ...(custom ? { root: flags.workspaces as string } : { registry: join(app.getPath('userData'), 'workspaces.json') }),
    defaultRoot: defaultWorkspaces(),
    // Loopback: the person using the app is its owner (Preferences, Open a folder…, identity, online copy).
    host: '127.0.0.1',
    port: 0,
    settings,
    // What only flags set: more components, the sandbox, the Podman program, engines named; and tests' timings.
    hosts: {
      run: {
        ...(engines ? { engines } : {}),
        components: [...standardRunComponents, ...(list(flags.component) ?? [])],
        allowUnsandboxed: flags['allow-unsandboxed'] === true,
        options: { podman: { podman: typeof flags.podman === 'string' ? flags.podman : undefined } },
      },
      timings: testTimings(),
    },
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
  if (!existsSync(path)) throw new Error(D.folder.missing(path));
  const folder = await inspectFolder(path);
  if (!folder.repoRoot) {
    // Not yet a git repository: say what using it means, in plain words (git is named once, in passing).
    const { response } = await dialog.showMessageBox(window!, {
      type: 'question',
      buttons: [D.folder.use, D.folder.cancel],
      defaultId: 0,
      cancelId: 1,
      message: D.folder.useAsk(basename(folder.dir)),
      detail: D.folder.useDetail(folder.entries),
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

/**
 * Open a folder… from the app's menu: the page does it, through the hub, as in a
 * browser (its own dialogs). From the launcher, or while joined to another
 * server, this app's own workspaces are opened with it.
 */
async function pickFolder(): Promise<void> {
  if (config?.managesHost && window) return void window.webContents.send('kuraa:open-folder');
  const r = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'], message: D.folder.choose });
  if (r.canceled || !r.filePaths[0]) return;
  try {
    await openFolder(r.filePaths[0]);
  } catch (e) {
    dialog.showErrorBox(D.folder.couldNotOpen, (e as Error).message);
  }
}

function showLauncher(): Promise<void> {
  config = null;
  window!.setTitle('kuraa');
  return window!.loadFile(LAUNCHER);
}

/** Preferences: the client's dialog, in the page (this app's own workspaces opened first, from the launcher). */
async function showPreferences(): Promise<void> {
  if (!window) return;
  if (!config) {
    await showWorkspaces();
  }
  window.webContents.send('kuraa:preferences');
}

/** Ask the page to show its Markdown and shortcuts sheet (the client, if it is loaded). */
function showHelp(): void {
  if (config && window) window.webContents.send('kuraa:help');
}

/** Check for Updates… in the app's menu: look now, and say what was found. */
async function checkForUpdates(): Promise<void> {
  const why = updatable();
  const r = updates ? await updates.check(true) : { kind: 'off' as const };
  const message = r.kind === 'off' ? D.updates.off(why ?? '') : r.kind === 'none' ? D.updates.latest(app.getVersion()) : r.kind === 'downloading' ? D.updates.downloading(r.version) : r.kind === 'ready' ? D.updates.ready(r.version) : D.updates.failed(r.message);
  const buttons = r.kind === 'ready' ? [D.updates.restart, D.updates.later] : [D.updates.ok];
  const { response } = await dialog.showMessageBox(window ?? undefined as unknown as BrowserWindow, { type: r.kind === 'failed' ? 'warning' : 'info', message, buttons, defaultId: 0 });
  if (r.kind === 'ready' && response === 0) await restartToUpdate();
}

/** Save every workspace, quit, put the update in place, and start again. */
async function restartToUpdate(): Promise<void> {
  await updates?.restart(async () => {
    quitting = true;
    await stopHub();
  });
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const updatesItem = { label: D.menu.checkUpdates, click: () => void checkForUpdates().catch((e: Error) => dialog.showErrorBox(D.updates.title, e.message)) };
  // Not "Settings", which in the client are the person's own (name, email, colour). ⌘, is the
  // page's own (its menu, which holds your settings), so Preferences takes ⌥⌘, (decision 0044);
  // the in-app menu also opens it (Preferences…). Both open the client's dialog.
  const preferencesItem = { label: D.menu.preferences, accelerator: 'CmdOrCtrl+Alt+,', click: () => void showPreferences().catch((e: Error) => dialog.showErrorBox(D.errors.workspaces, e.message)) };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const }, updatesItem, { type: 'separator' as const }, preferencesItem, { type: 'separator' as const },
        { role: 'services' as const }, { type: 'separator' as const },
        { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const }, { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: D.menu.yourWorkspaces, click: () => void showWorkspaces() },
        { label: D.menu.openFolder, accelerator: 'CmdOrCtrl+O', click: () => void pickFolder() },
        { label: D.menu.join, click: () => void leave() },
        ...(isMac ? [] : [{ type: 'separator' as const }, preferencesItem]),
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    // Edit's standard items (undo, cut, copy, paste, select all…). Find (⌘F) is the page's own, so no item takes its key.
    { role: 'editMenu' },
    // The standard View menu, less Force Reload, whose ⇧⌘R renders the document in the page.
    {
      label: 'View',
      submenu: [
        { role: 'reload' as const }, { role: 'toggleDevTools' as const }, { type: 'separator' as const },
        { role: 'resetZoom' as const }, { role: 'zoomIn' as const }, { role: 'zoomOut' as const }, { type: 'separator' as const },
        { role: 'togglefullscreen' as const },
      ],
    },
    { role: 'windowMenu' },
    // ⌘/ is the page's own key for the sheet: shown here, not taken from the page.
    { role: 'help', label: D.menu.help, submenu: [
      { label: D.menu.shortcuts, accelerator: 'CmdOrCtrl+/', registerAccelerator: false, click: () => showHelp() },
      // What the app said, connecting to other devices above all (log.ts).
      { label: D.menu.showLog, click: () => {
        const f = logFile();
        if (f) shell.showItemInFolder(f);
      } },
      ...(isMac ? [] : [{ type: 'separator' as const }, updatesItem]),
    ] },
  ]));
}

/** Whether a bridge call comes from one of the app's own pages (not a page that got into the window somehow). */
const fromOwnPage = (e: IpcMainEvent | IpcMainInvokeEvent) => !!e.senderFrame && isOwnPage(e.senderFrame.url);

// An update downloaded: the page asks when it starts (a reload, another workspace), and is told when it is.
ipcMain.on('kuraa:update-ready?', (e) => {
  if (fromOwnPage(e) && updates?.ready) e.sender.send('kuraa:update-ready', updates.ready);
});
ipcMain.on('kuraa:restart-to-update', (e) => {
  if (fromOwnPage(e)) void restartToUpdate().catch((err: Error) => dialog.showErrorBox(D.updates.title, err.message));
});

ipcMain.on('kuraa:config', (e) => {
  e.returnValue = fromOwnPage(e) ? config : null;
});
ipcMain.handle('kuraa:open-folder', (e) => (fromOwnPage(e) ? pickFolder() : undefined));
ipcMain.handle('kuraa:leave', (e) => (fromOwnPage(e) ? leave() : undefined));
ipcMain.handle('kuraa:home', (e) => (fromOwnPage(e) ? showWorkspaces() : undefined));
// A folder the person picks (to open as a workspace, for new workspaces, or for packages and tools), or null.
ipcMain.handle('kuraa:choose-folder', async (e, purpose: unknown) => {
  if (!fromOwnPage(e) || !window) return null;
  const message = purpose === 'data' ? D.folder.whereData : purpose === 'workspaces' ? D.folder.whereNew : D.folder.choose;
  const r = await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'], message });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
ipcMain.handle('kuraa:join', async (e, url: string, token: string) => {
  if (!fromOwnPage(e)) return D.errors.notAllowed;
  try {
    const res = await fetch(`${url.replace(/\/$/, '')}/api/workspace`, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) return res.status === 401 ? D.join.rejected : D.join.answered(res.status);
  } catch (e) {
    return D.join.unreachable(url, (e as Error).message);
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
  // A link followed inside a frame (the Preview panel's rendered document) does not load
  // another site in the window: a web link opens in the browser instead.
  contents.on('will-frame-navigate', (event) => {
    const { url, isMainFrame } = event;
    if (isMainFrame || isOwnPage(url) || /^about:(srcdoc|blank)/.test(url)) return;
    event.preventDefault();
    openOutside(url);
  });
  contents.on('context-menu', (_event, params) => {
    // Only if the page did not show a menu of its own: the preload says, usually first; wait briefly for it.
    const decide = (tries: number) => {
      if (Date.now() - pageMenu.at < 500) {
        const { prevented } = pageMenu;
        pageMenu = { prevented: false, at: 0 };
        if (!prevented) showContextMenu(contents, params);
      } else if (tries > 0) setTimeout(() => decide(tries - 1), 20);
      else showContextMenu(contents, params);
    };
    decide(5);
  });
});

/** The page's word on its latest right-click: whether it answered it itself (preload.ts). */
let pageMenu = { prevented: false, at: 0 };
ipcMain.on('kuraa:context-menu', (e, prevented: unknown) => {
  if (fromOwnPage(e)) pageMenu = { prevented: prevented === true, at: Date.now() };
});

/**
 * The right-click menu: spelling suggestions and Add to Dictionary for a
 * misspelled word, Look Up on a Mac, then Cut, Copy, Paste and Select All, as
 * the place allows.
 */
function showContextMenu(contents: WebContents, params: ContextMenuParams): void {
  const items: MenuItemConstructorOptions[] = [];
  const word = params.misspelledWord;
  if (word) {
    for (const suggestion of params.dictionarySuggestions.slice(0, 6)) {
      items.push({ label: suggestion, click: () => contents.replaceMisspelling(suggestion) });
    }
    if (!params.dictionarySuggestions.length) items.push({ label: D.noSuggestions, enabled: false });
    items.push({ label: D.addToDictionary, click: () => contents.session.addWordToSpellCheckerDictionary(word) });
    items.push({ type: 'separator' });
  }
  const selected = params.selectionText.trim();
  if (process.platform === 'darwin' && selected) {
    items.push({ label: D.lookUp(selected.length > 24 ? `${selected.slice(0, 24)}…` : selected), click: () => contents.showDefinitionForSelection() });
    items.push({ type: 'separator' });
  }
  const { editFlags } = params;
  if (params.isEditable) items.push({ role: 'cut', enabled: editFlags.canCut });
  if (params.isEditable || selected) items.push({ role: 'copy', enabled: editFlags.canCopy });
  if (params.isEditable) items.push({ role: 'paste', enabled: editFlags.canPaste });
  if (items.length && items[items.length - 1]!.type !== 'separator') items.push({ type: 'separator' });
  items.push({ role: 'selectAll', enabled: editFlags.canSelectAll });
  Menu.buildFromTemplate(items).popup({ window: BrowserWindow.fromWebContents(contents) ?? undefined });
}

app.whenReady().then(async () => {
  buildMenu();
  updates = startUpdates({ log: (m) => console.log(m), ready: (version) => window?.webContents.send('kuraa:update-ready', version) });
  // A device of a workspace runs a newer kuraa: this one does not sync with it until updated, so look now.
  void onNewerVersion(() => void updates?.check());
  window = new BrowserWindow({
    width: 1280,
    height: 820,
    title: 'kuraa',
    ...windowOptions(),
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

// An error nothing caught: said, every workspace's edits saved that can be, and the app goes on (no
// dialog, no quitting over one workspace's error); errors coming too fast quit, saving first.
lastResort({ log: (m) => console.error(`[kuraa] ${m}`), save: async () => hub?.hub.saveAll(), stop: () => app.quit() });

// Flush and commit before quitting.
app.on('before-quit', (event) => {
  if (quitting || !hub) return;
  event.preventDefault();
  quitting = true;
  void stopHub().finally(() => app.quit());
});

app.on('window-all-closed', () => app.quit());
