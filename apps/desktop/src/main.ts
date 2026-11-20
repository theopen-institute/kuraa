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
// For folders it opens itself, the configuration is its Preferences
// (preferences.ts), or flags, which win over them:
//   --engine <id>...     engines to turn on (default: r); --engine none for none
//   --env <id>           where code runs (default: the only environment loaded)
//   --format <id>...     document formats to turn on (default: all)
//   --component <spec>...   more run components (engines, environments)
//   --allow-unsandboxed  allow an environment that is not sandboxed
//   --r-image <image>... base images a workspace may name for R (besides the default)
//   --peer               sync with the folder's paired devices (pair them with kuraa-host invite / join)
// The components that ship (@kuraa/run-components: R, Podman containers) are loaded.
//
// It runs the git it ships with (vendor/git, see scripts/fetch-git.mjs), so the
// computer needs none, and every device runs the same one. Run from the repo
// without it fetched, it uses the computer's git.
//
// The window shows only the app's own pages: it does not navigate elsewhere or
// open other windows (web links open in the browser), and the bridge answers
// only the app's own pages.
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, shell, type ContextMenuParams, type IpcMainEvent, type IpcMainInvokeEvent, type MenuItemConstructorOptions, type WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { gitIdentity, inspectFolder, lastResort, personKeys, startHub, useGit, type HostTimings, type RunOptions, type RunningHub } from '@kuraa/host';
import { standardRunComponents } from '@kuraa/run-components';
import type { ShellConfig } from '@kuraa/client';
import { preferencesFrom, readPreferences, writePreferences, type Preferences, type PreferencesView } from './preferences.js';

const WEB_INDEX = join(__dirname, 'web', 'index.html');
const LAUNCHER = join(__dirname, 'static', 'launcher.html');
const PREFERENCES = join(__dirname, 'static', 'preferences.html');
/** The only pages the windows may show. */
const OWN_PAGES = [WEB_INDEX, LAUNCHER, PREFERENCES].map((p) => pathToFileURL(p).href);
const isOwnPage = (url: string) => OWN_PAGES.includes(url.split(/[?#]/)[0]!);

const { values: flags } = parseArgs({
  args: process.argv.slice(app.isPackaged ? 1 : 2).filter((a) => a !== '.'),
  options: {
    open: { type: 'string' }, join: { type: 'string' }, token: { type: 'string' },
    engine: { type: 'string', multiple: true }, env: { type: 'string' }, format: { type: 'string', multiple: true },
    component: { type: 'string', multiple: true }, 'allow-unsandboxed': { type: 'boolean' }, peer: { type: 'boolean' },
    workspaces: { type: 'string' },
    'r-image': { type: 'string', multiple: true },
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
const PREFERENCES_FILE = join(app.getPath('userData'), 'preferences.json');
let preferences = readPreferences(PREFERENCES_FILE);

/** The preferences that flags set, which the Preferences window shows as such. */
function setByFlags(): (keyof Preferences)[] {
  const keys: (keyof Preferences)[] = [];
  if (flags.peer === true) keys.push('syncDevices');
  if (list(flags.engine)) keys.push('runCode');
  if (list(flags['r-image'])) keys.push('rImages');
  if (typeof flags.workspaces === 'string') keys.push('workspaces');
  return keys;
}

const defaultWorkspaces = () => join(app.getPath('documents'), 'kuraa');

let window: BrowserWindow | null = null;
let preferencesWindow: BrowserWindow | null = null;
let hub: RunningHub | null = null;
let quitting = false;
/** What the page gets from kuraa:config; null while the launcher shows. */
let config: ShellConfig | null = null;

/** What runs, for folders this app opens itself: R if the preferences say so, unless --engine says otherwise, where --env says. */
function runOptions(): RunOptions {
  const engines = (list(flags.engine) ?? (preferences.runCode ? ['r'] : [])).filter((e) => e !== 'none');
  return {
    engines,
    environment: typeof flags.env === 'string' ? flags.env : undefined,
    components: [...standardRunComponents, ...(list(flags.component) ?? [])],
    allowUnsandboxed: flags['allow-unsandboxed'] === true,
    allowInstalls: true,
    // Base images a workspace may name for R, besides the default.
    options: { r: { images: list(flags['r-image']) ?? preferences.rImages } },
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
  // --workspaces keeps the list in that folder; otherwise it lives with the app's own data, so it survives choosing another folder.
  const custom = typeof flags.workspaces === 'string';
  hub = await startHub({
    root: custom ? (flags.workspaces as string) : (preferences.workspaces ?? defaultWorkspaces()),
    registry: custom ? undefined : join(app.getPath('userData'), 'workspaces.json'),
    host: '127.0.0.1',
    port: 0,
    // What runs and which formats are on: this app's flags.
    // This app is its own operator: the person using it sets up backups, with their own git credentials.
    hosts: { run: runOptions(), formats: list(flags.format), timings: timings(), manageBackups: true },
    peers: { everywhere: flags.peer === true || preferences.syncDevices },
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

/** The Preferences window, over the main one. */
function showPreferences(): void {
  if (preferencesWindow) {
    if (!HIDDEN) preferencesWindow.focus();
    return;
  }
  preferencesWindow = new BrowserWindow({
    parent: window ?? undefined,
    modal: process.platform !== 'darwin',
    width: 560,
    height: 560,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: 'Preferences',
    ...windowOptions(),
  });
  preferencesWindow.setMenuBarVisibility(false);
  preferencesWindow.on('closed', () => (preferencesWindow = null));
  void preferencesWindow.loadFile(PREFERENCES);
}

/** What the Preferences window shows: the preferences, which flags override, and whether code can run. */
async function preferencesView(): Promise<PreferencesView> {
  const run = runOptions();
  const environments = await Promise.all(standardRunComponents.flatMap((c) => c.environments ?? []).map(async (e) => {
    try {
      return { label: e.label, ...(await e.check(run.options?.[e.id])) };
    } catch (err) {
      return { label: e.label, available: false, message: (err as Error).message };
    }
  }));
  return { preferences, fromFlags: setByFlags(), defaultWorkspaces: defaultWorkspaces(), environments };
}

/**
 * This computer now acts for a person (made or imported): restart the workspaces,
 * so each says so to its other devices as it starts syncing (and commits first).
 */
async function personChanged(): Promise<void> {
  if (!hub) return;
  await stopHub();
  try {
    await showWorkspaces();
  } catch (e) {
    dialog.showErrorBox('Could not open your workspaces', (e as Error).message);
    await showLauncher();
  }
}

/** Run a change to this computer's person; an error message for the window, or null. */
async function personDo(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
  } catch (e) {
    return (e as Error).message;
  }
  void personChanged();
  return null;
}

/** Save the preferences; if they changed, restart this app's hub (which commits first) so they apply. */
async function savePreferences(v: unknown): Promise<void> {
  const next = preferencesFrom(v);
  const changed = JSON.stringify(next) !== JSON.stringify(preferences);
  preferences = next;
  await writePreferences(PREFERENCES_FILE, next);
  preferencesWindow?.close();
  if (!changed || !hub) return;
  await stopHub();
  try {
    await showWorkspaces();
  } catch (e) {
    dialog.showErrorBox('Could not open your workspaces', (e as Error).message);
    await showLauncher();
  }
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  // Not "Settings", which in the client are the person's own (name, email, colour).
  const preferencesItem = { label: 'Preferences…', accelerator: 'CmdOrCtrl+,', click: () => showPreferences() };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const }, { type: 'separator' as const }, preferencesItem, { type: 'separator' as const },
        { role: 'services' as const }, { type: 'separator' as const },
        { role: 'hide' as const }, { role: 'hideOthers' as const }, { role: 'unhide' as const }, { type: 'separator' as const }, { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Your Workspaces', click: () => void showWorkspaces() },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+O', click: () => void pickFolder() },
        { label: 'Join Shared Host…', click: () => void leave() },
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
ipcMain.handle('kuraa:preferences', (e) => (fromOwnPage(e) ? preferencesView() : null));
ipcMain.handle('kuraa:save-preferences', (e, v: unknown) => (fromOwnPage(e) ? savePreferences(v) : undefined));
ipcMain.handle('kuraa:choose-folder', async (e) => {
  if (!fromOwnPage(e) || !preferencesWindow) return null;
  const r = await dialog.showOpenDialog(preferencesWindow, { properties: ['openDirectory', 'createDirectory'], message: 'Where new workspaces go' });
  return r.canceled ? null : (r.filePaths[0] ?? null);
});
// This computer's person's key, for the menu's You section (packages/client/src/PersonKey.vue).
ipcMain.handle('kuraa:person', async (e) => {
  if (!fromOwnPage(e)) return null;
  const keys = await personKeys();
  const person = await keys.readPerson();
  // Your keys the workspaces know of (vouched for by your identity), from each one open here.
  const known: string[] = [];
  for (const w of hub?.hub.list() ?? []) {
    const ids = hub?.hub.hostOf(w.id)?.host.peers?.node.identity;
    const mine = person && ids ? (await ids.people()).find((p) => p.key === person.publicKey.toString('hex')) : undefined;
    if (mine) known.push(...mine.keys);
  }
  return keys.personInfo(known);
});
ipcMain.handle('kuraa:revoke-key', async (e, key: unknown) => {
  if (!fromOwnPage(e)) return 'Not allowed.';
  return personDo(async () => (await personKeys()).revokeKey(String(key ?? '')));
});
ipcMain.handle('kuraa:create-person', async (e, name: unknown) => {
  if (!fromOwnPage(e)) return 'Not allowed.';
  return personDo(async () => (await personKeys()).createPerson(String(name ?? '')));
});
ipcMain.handle('kuraa:import-person', async (e, line: unknown) => {
  if (!fromOwnPage(e)) return 'Not allowed.';
  return personDo(async () => (await personKeys()).importPerson(String(line ?? '')));
});
ipcMain.handle('kuraa:copy-person', async (e) => {
  if (!fromOwnPage(e)) return false;
  const keys = await personKeys();
  const person = await keys.readPerson();
  if (!person) return false;
  clipboard.writeText(keys.exportPerson(person));
  return true;
});
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
  // A link followed inside a frame (the Preview panel's rendered document) does not load
  // another site in the window: a web link opens in the browser instead.
  contents.on('will-frame-navigate', (event) => {
    const { url, isMainFrame } = event;
    if (isMainFrame || isOwnPage(url) || /^about:(srcdoc|blank)/.test(url)) return;
    event.preventDefault();
    openOutside(url);
  });
  contents.on('context-menu', (_event, params) => showContextMenu(contents, params));
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
    if (!params.dictionarySuggestions.length) items.push({ label: 'No suggestions', enabled: false });
    items.push({ label: 'Add to Dictionary', click: () => contents.session.addWordToSpellCheckerDictionary(word) });
    items.push({ type: 'separator' });
  }
  const selected = params.selectionText.trim();
  if (process.platform === 'darwin' && selected) {
    items.push({ label: `Look Up “${selected.length > 24 ? `${selected.slice(0, 24)}…` : selected}”`, click: () => contents.showDefinitionForSelection() });
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
