// The desktop app's hub, in the Node the Tauri app carries (decision 0127): what
// the Electron app's main process does with the host, without its windows. The
// shell (src-tauri/src/main.rs) starts it, and asks it things over stdin, one
// JSON line each ({ id, op, ... }); it answers on stdout, on lines starting
// `@kuraa ` ({ id, ok } or { id, error }; or { event }, unasked). Every other
// line it writes is its log, which it also keeps in a file (log.ts's rules, as
// the Electron app does: decision 0053).
//
//   start      this app's hub, started if it is not running: { url, token, root }
//   stop       the hub stopped (it writes and commits pending edits): joining another host, or leaving
//   inspect    a folder, before it is added: { dir, repoRoot, entries }
//   add        a folder added to the workspaces (made a repository if `init`), the hub started: { id, path }
//   identity   git's name and email, for a folder or in general
//   join       whether a host takes an access code: an error to show, or null
//   log        a line from the shell, for the log
//   quit       the hub stopped, and this process gone
//
// Unasked: `newer` (a device runs a newer kuraa: the shell looks for an update).
// Its stdin closing (the shell gone) stops it as `quit` does.
//
// It takes the Electron app's flags (main.ts), which the shell passes on as it
// was given them: --open, --join and --token say what to show first (`hello`);
// the others set what runs, as there. Its data is the Electron app's, in the same
// folder (preferences.json, workspaces.json), so moving from that app to this one
// keeps everything; KURAA_USER_DATA puts it elsewhere (tests), KURAA_TIMINGS
// shortens the host's timings (tests), KURAA_GIT_DIR names the git it ships.
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, type WriteStream } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { format, parseArgs } from 'node:util';
import { defaultWorkspacesFolder, gitIdentity, inspectFolder, lastResort, onNewerRelease, onNewerVersion, setKuraaVersion, SettingsStore, startHub, useGitFolder, type HostTimings, type RunningHub, type Settings } from '@kuraa/host';
import { standardRunComponents } from '@kuraa/run-components';
import { standardFeatures } from '@kuraa/features';

const { values: flags } = parseArgs({
  args: process.argv.slice(2),
  options: {
    open: { type: 'string' }, join: { type: 'string' }, token: { type: 'string' },
    engine: { type: 'string', multiple: true }, env: { type: 'string' }, format: { type: 'string', multiple: true }, feature: { type: 'string', multiple: true },
    component: { type: 'string', multiple: true }, 'allow-unsandboxed': { type: 'boolean' },
    workspaces: { type: 'string' },
    'r-image': { type: 'string', multiple: true },
    podman: { type: 'string' },
  },
  strict: false,
  allowPositionals: true,
});
const list = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined);
const text = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** The Electron app's data folder (its userData: app data, then `kuraa`), which this app keeps using. */
export function appDataFolder(): string {
  if (process.env.KURAA_USER_DATA) return resolve(process.env.KURAA_USER_DATA);
  const home = homedir();
  if (process.platform === 'darwin') return join(home, 'Library', 'Application Support', 'kuraa');
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'kuraa');
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'kuraa');
}

/** Where the log is kept: with the data when it is given (tests), else where the system keeps apps' logs (as Electron's app.getPath('logs')). */
function logFolder(data: string): string {
  if (!process.env.KURAA_USER_DATA && process.platform === 'darwin') return join(homedir(), 'Library', 'Logs', 'kuraa');
  return join(data, 'logs');
}

const DATA = appDataFolder();
const LOG_MAX = 5 * 1024 * 1024;
/** Where the log is (once kept). */
let logFile: string | null = null;

/** Keep what console.log and console.error say in the log file too (as the Electron app's log.ts). */
function keepLog(): void {
  let out: WriteStream;
  try {
    const dir = logFolder(DATA);
    mkdirSync(dir, { recursive: true });
    logFile = join(dir, 'kuraa.log');
    if (existsSync(logFile) && statSync(logFile).size > LOG_MAX) renameSync(logFile, join(dir, 'kuraa.old.log'));
    out = createWriteStream(logFile, { flags: 'a' });
    out.on('error', () => undefined);
  } catch {
    return;
  }
  let written = 0;
  const tee = (original: (...a: unknown[]) => void) => (...args: unknown[]) => {
    original(...args);
    if (written > LOG_MAX) return;
    const line = `${new Date().toISOString()} ${format(...args)}\n`;
    written += line.length;
    out.write(line);
  };
  console.log = tee(console.log.bind(console));
  console.error = tee(console.error.bind(console));
}

/** A line to the shell. */
function tell(message: object): void {
  process.stdout.write(`@kuraa ${JSON.stringify(message)}\n`);
}

if (process.env.KURAA_GIT_DIR) useGitFolder(process.env.KURAA_GIT_DIR);
keepLog();
const VERSION = process.env.KURAA_APP_VERSION || null;
console.log(`[desktop] kuraa ${VERSION ?? '(from the repository)'} on ${process.platform} ${process.arch}`);

/** The settings flags set, which win over the preferences, and which the Preferences dialog shows as such. */
function flagSettings(): Partial<Settings> {
  const engines = list(flags.engine);
  return {
    ...(engines ? { runCode: engines.some((e) => e !== 'none') } : {}),
    ...(list(flags['r-image']) ? { rImages: list(flags['r-image']) } : {}),
    ...(list(flags.format) ? { formats: list(flags.format) } : {}),
    ...(list(flags.feature) ? { features: list(flags.feature) } : {}),
    ...(text(flags.env) ? { environment: text(flags.env) } : {}),
    ...(text(flags.workspaces) ? { workspaces: resolve(text(flags.workspaces)!) } : {}),
  };
}
// Its preferences: the hub's settings, where the Electron app keeps them.
const settings = new SettingsStore(join(DATA, 'preferences.json'), flagSettings());

/** Automated tests may shorten the host's timings (KURAA_TIMINGS): they win over the preferences. */
function testTimings(): Partial<HostTimings> {
  try {
    return JSON.parse(process.env.KURAA_TIMINGS ?? '{}') as Partial<HostTimings>;
  } catch {
    return {};
  }
}

let hub: RunningHub | null = null;
/** The hub while it starts: anything asking for it meanwhile waits for this one, never starting another. */
let hubStarting: Promise<RunningHub> | null = null;

async function startOwnHub(): Promise<RunningHub> {
  // --workspaces keeps the list in that folder; otherwise it lives with the app's own data, so it survives choosing another folder.
  const custom = text(flags.workspaces);
  const engines = list(flags.engine);
  const started = await startHub({
    ...(custom ? { root: custom } : { registry: join(DATA, 'workspaces.json') }),
    // In the home folder, never Documents: iCloud keeps Documents on many Macs (0103).
    defaultRoot: defaultWorkspacesFolder(),
    // Loopback: the person using the app is its owner (Preferences, Open a folder…, identity, online copy).
    host: '127.0.0.1',
    port: 0,
    settings,
    // The web client, served by the hub: the window shows it from there (0127).
    staticDir: join(import.meta.dirname, 'web'),
    // What only flags set: more components, the sandbox, the Podman program, engines named; and tests' timings.
    hosts: {
      features: standardFeatures,
      run: {
        ...(engines ? { engines } : {}),
        components: [...standardRunComponents, ...(list(flags.component) ?? [])],
        allowUnsandboxed: flags['allow-unsandboxed'] === true,
        options: { podman: { podman: text(flags.podman) } },
      },
      timings: testTimings(),
    },
    log: (m) => console.log(`[hub] ${m}`),
  });
  hub = started;
  console.log(`[desktop] hub ${started.url} on ${started.hub.root}`);
  return started;
}

/** This app's hub, started if it is not running (or the one starting). */
async function ensureHub(): Promise<RunningHub> {
  if (hub) return hub;
  hubStarting ??= startOwnHub().finally(() => (hubStarting = null));
  return hubStarting;
}

async function stopHub(): Promise<void> {
  // One still starting is stopped once it has.
  const h = hub ?? (await hubStarting?.catch(() => null)) ?? null;
  hub = null;
  if (h) await h.close(); // flushes and commits open rooms
}

let quitting: Promise<never> | null = null;
/** Stop the hub (writing and committing what is pending), and go. */
function quit(): Promise<never> {
  quitting ??= stopHub()
    .catch((e: Error) => console.error(`[desktop] stopping the hub: ${e.message}`))
    .then(() => process.exit(0));
  return quitting;
}

type Request = { id?: number; op?: string; [k: string]: unknown };

const OPS: Record<string, (r: Request) => Promise<unknown>> = {
  hello: async () => ({
    open: text(flags.open) ? resolve(text(flags.open)!) : null,
    join: text(flags.join) ?? null,
    token: text(flags.token) ?? '',
    log: logFile,
    home: homedir(),
  }),
  start: async () => {
    const h = await ensureHub();
    return { url: h.url, token: h.token, root: h.hub.root };
  },
  stop: async () => {
    await stopHub();
    return null;
  },
  inspect: async (r) => {
    const path = text(r.path);
    if (!path || !existsSync(path)) throw new Error(`There is no folder at ${path ?? ''}.`);
    return inspectFolder(path);
  },
  add: async (r) => {
    const path = text(r.path);
    if (!path) throw new Error('No folder given.');
    const h = await ensureHub();
    const w = await h.hub.addFolder(path, r.init === true);
    return { id: w.id, path: w.path };
  },
  identity: async (r) => gitIdentity(text(r.folder) ?? homedir()),
  join: async (r) => {
    const url = (text(r.url) ?? '').replace(/\/$/, '');
    const token = text(r.token) ?? '';
    try {
      const res = await fetch(`${url}/api/workspace`, { headers: { authorization: `Bearer ${token}` } });
      if (!res.ok) return res.status === 401 ? 'The host did not accept the access code.' : `The host could not be joined (it answered ${res.status}).`;
      // The window shows the host's own pages (0127): a host that serves none cannot be shown.
      const page = await fetch(`${url}/`);
      if (!page.ok || !(page.headers.get('content-type') ?? '').includes('text/html')) return `${url} does not serve Kuraa's pages, so the app cannot show it.`;
    } catch (e) {
      return `Cannot reach ${url}: ${(e as Error).message}`;
    }
    return null;
  },
  log: async (r) => {
    console.log(String(r.text ?? ''));
    return null;
  },
  quit: () => quit(),
};

createInterface({ input: process.stdin }).on('line', (line) => {
  let r: Request;
  try {
    r = JSON.parse(line) as Request;
  } catch {
    console.error(`[desktop] not understood from the shell: ${line.slice(0, 200)}`);
    return;
  }
  const op = OPS[r.op ?? ''];
  if (!op) return tell({ id: r.id, error: `No such request: ${String(r.op)}` });
  op(r).then(
    (ok) => tell({ id: r.id, ok: ok ?? null }),
    (e: Error) => tell({ id: r.id, error: e.message }),
  );
}).on('close', () => void quit());

// Which version this is, said to other devices (0099): one on an older release learns a newer is out.
await setKuraaVersion(VERSION);
// A device of a workspace runs a newer kuraa: this one does not sync with it until updated, so the shell looks now.
void onNewerVersion(() => tell({ event: 'newer' }));
// One runs a newer release, speaking the same protocol (0099): looked for now too, as installed apps would later.
void onNewerRelease(() => tell({ event: 'newer' }));
// An error nothing caught: said, every workspace's edits saved that can be, and the app goes on; errors coming too fast quit, saving first.
lastResort({ log: (m) => console.error(`[kuraa] ${m}`), save: async () => hub?.hub.saveAll(), stop: () => void quit() });
// Signals stop it as quitting does (a terminal's Ctrl+C, the system shutting down).
process.on('SIGINT', () => void quit());
process.on('SIGTERM', () => void quit());
tell({ event: 'ready' });
