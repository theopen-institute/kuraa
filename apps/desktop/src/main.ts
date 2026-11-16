// The desktop shell. It either embeds a host on a local folder (loopback, free
// port, random token) or joins a shared host, and loads the web client build.
//
//   electron .                          launcher: open a folder or join a host
//   electron . --open <folder>          embed a host on <folder>
//   electron . --join <url> --token <t> join a shared host; no local host
import { app, BrowserWindow, dialog, ipcMain, Menu } from 'electron';
import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { startHost, type HostTimings, type RunningHost } from '@kuraa/host';

const run = promisify(execFile);
const git = async (cwd: string, ...args: string[]) => (await run('git', args, { cwd })).stdout.trim();
const gitMaybe = (cwd: string, ...args: string[]) => git(cwd, ...args).catch(() => '');

const WEB_INDEX = join(__dirname, 'web', 'index.html');
const LAUNCHER = join(__dirname, 'static', 'launcher.html');

let window: BrowserWindow | null = null;
let host: RunningHost | null = null;
let quitting = false;

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
function loadClient(params: Record<string, string>): Promise<void> {
  return window!.loadFile(WEB_INDEX, { query: params });
}

async function identityFor(dir: string): Promise<{ name: string; email: string }> {
  return {
    name: (await gitMaybe(dir, 'config', 'user.name')) || '',
    email: (await gitMaybe(dir, 'config', 'user.email')) || '',
  };
}

/** Open a local folder with an embedded host. Returns false if the user declined. */
async function openFolder(dir: string): Promise<boolean> {
  dir = resolve(dir);
  if (!existsSync(dir)) throw new Error(`No such folder: ${dir}`);
  const top = await gitMaybe(dir, 'rev-parse', '--show-toplevel');
  if (!top) {
    const files = readdirSync(dir).filter((f) => !f.startsWith('.'));
    const { response } = await dialog.showMessageBox(window!, {
      type: 'question',
      buttons: ['Initialise', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `${basename(dir)} is not a git repository.`,
      detail: `Initialise one here${files.length ? ` and commit the ${files.length} item(s) already in the folder` : ''}? The folder stays usable by git and other tools.`,
    });
    if (response !== 0) return false;
    await git(dir, 'init', '-q');
    await git(dir, 'add', '-A');
    await run('git', ['commit', '-q', '--allow-empty', '-m', 'Initialise workspace'], { cwd: dir, env: { ...process.env, ...(await fallbackIdentityEnv(dir)) } });
  } else {
    dir = top;
  }

  await stopHost();
  const who = await identityFor(dir);
  host = await startHost({
    dir,
    host: '127.0.0.1',
    port: 0,
    // Commits use the folder's git identity; a machine without one still gets a working host.
    identity: who.name && who.email ? undefined : { name: who.name || 'kuraa', email: who.email || 'kuraa@localhost' },
    timings: timings(),
    log: (m) => console.log(`[host] ${m}`),
  });
  console.log(`[desktop] embedded host ${host.url} on ${dir}`);
  await loadClient({ host: host.url, token: host.token, name: who.name, email: who.email });
  return true;
}

async function fallbackIdentityEnv(dir: string): Promise<Record<string, string>> {
  const who = await identityFor(dir);
  if (who.name && who.email) return {};
  const name = who.name || 'kuraa';
  const email = who.email || 'kuraa@localhost';
  return { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email };
}

/** Join a shared host. No local host runs. */
async function joinHost(url: string, token: string): Promise<void> {
  await stopHost();
  const home = app.getPath('home');
  const who = await identityFor(home);
  await loadClient({ host: url.replace(/\/$/, ''), token, name: who.name, email: who.email });
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
        { label: 'Join Shared Host…', click: () => void stopHost().then(showLauncher) },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]));
}

ipcMain.handle('kuraa:open-folder', () => pickFolder());
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
