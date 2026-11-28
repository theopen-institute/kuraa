// kuraa-host                              your workspaces, as the desktop app: new ones go in the
//                                          Preferences' folder (default ~/Kuraa Workspaces), the list
//                                          and settings with the app's data (--settings moves them)
// kuraa-host --workspaces <folder> [...]   the same, with new workspaces in <folder> (its list in it)
// kuraa-host --dir <workspace> [--init]    one folder; nothing is added from the app
// Either way the server is a hub (hub.ts): each workspace at /w/<id>, its list at /hub/api.
//   serving:      [--port 4321] [--host 127.0.0.1] [--token T] [--static dir] [--settings file]
//                 [--allow-origin <origin>]...   pages served elsewhere that may use it (origins.ts)
//
// Listening only on this computer (the default), whoever has the access code is
// its owner (decision 0047): Preferences, Open a folder…, their identity and the
// personal backup are in the app. With --host naming a network address, they are not.
//
// The owner's settings (settings.ts; Preferences in the app) can also be given as
// flags, which win over them for as long as the host runs:
//   formats:      [--format pandoc-markdown --format text ...]   (default: all)
//   features:     [--feature <id> ...]   features on here (default: all loaded); each workspace turns them on too (0082)
//   running code: [--engine r | --engine none] [--env podman]
//                 [--allow-write] [--allow-network] [--no-allow-installs] [--data-dir path]
//                 [--render-where-code-runs]   Markdown rendered in Podman too, not by the built-in pandoc (0107)
//                 [--memory 4g] [--cpus 2] [--disk 2g]
//                 [--r-image <image>]...   base images a workspace may name for R (besides the default)
//   devices:      [--bootstrap host:port]...   servers to find other computers through (shared workspaces always sync)
//                 [--relay <key>]...           relays to go through to computers that cannot be reached directly
//                                              (kuraa-host relay runs one; members offer each other theirs anyway)
//   a server's:   [--peer-port N] [--public-address host[:port]]   take devices' connections over TCP, for
//                                              networks that block UDP; told to members, and put in invite links
//                 [--dht-port N]               its DHT node on a fixed port, for members to start from
//                 [--no-serve-dht]             never serve the public DHT (a public address does, by default)
//                 (see peers/cli.ts for invite, join, devices, backup, fork)
//   saving:       [--flush-ms N] [--commit-ms N]
//   updating:     [--auto-update]   a release (@kuraa/server, release.ts) updates itself and restarts (0052);
//                                   one that changes how devices sync, once a device of its runs it (0112)
//                 [--auto-update-all]  and such a release at once
//
// Flags only, because they choose what code runs with your rights (0046, 0047):
//   --component <path or package>...   more run components; @kuraa/run-components always loads
//   --allow-unsandboxed                an environment that is not sandboxed
//   --podman <path>                    the Podman program (also KURAA_PODMAN)
//
// KURAA_GIT_DIR names a git a shell ships (scripts/fetch-git.mjs's layout), run instead of the computer's.
import { parseArgs } from 'node:util';
import { standardRunComponents } from '@kuraa/run-components';
import { standardFeatures } from '@kuraa/features';
import { dirname, join, resolve } from 'node:path';
import { defaultDataDir, lastResort, OWNER_OFF, SettingsStore, startHub, defaultWorkspacesFolder, useGitFolder, type Settings } from './index.js';
import { PEER_COMMANDS, peerCommand } from './peers/cli.js';
import { runsAsService } from './selfupdate.js';

if (PEER_COMMANDS.includes(process.argv[2] ?? '')) {
  try {
    await peerCommand(process.argv.slice(2), { components: standardRunComponents });
    process.exit(0);
  } catch (e) {
    console.error(`[kuraa] ${(e as Error).message}`);
    process.exit(1);
  }
}

// Flags that are gone (decision 0047): what they turned on now follows from where the server listens.
const GONE: Record<string, string> = {
  '--manage-person': 'your identity is managed from the app whenever the host listens only on this computer',
  '--manage-online': 'the personal backup is managed from the app whenever the host listens only on this computer',
  '--allow-invites': 'people may always invite others from the app',
};
for (const arg of process.argv.slice(2)) {
  if (GONE[arg]) {
    console.error(`[kuraa] ${arg} is no longer needed: ${GONE[arg]}.`);
    process.exit(2);
  }
}

const { values } = parseArgs({
  allowNegative: true,
  options: {
    dir: { type: 'string' },
    settings: { type: 'string' },
    workspaces: { type: 'string' },
    init: { type: 'boolean', default: false },
    format: { type: 'string', multiple: true },
    feature: { type: 'string', multiple: true },
    engine: { type: 'string', multiple: true },
    env: { type: 'string' },
    component: { type: 'string', multiple: true },
    'allow-unsandboxed': { type: 'boolean', default: false },
    'allow-write': { type: 'boolean' },
    'allow-network': { type: 'boolean' },
    'allow-installs': { type: 'boolean' },
    'render-where-code-runs': { type: 'boolean' },
    'data-dir': { type: 'string' },
    memory: { type: 'string' },
    cpus: { type: 'string' },
    disk: { type: 'string' },
    'r-image': { type: 'string', multiple: true },
    podman: { type: 'string' },
    port: { type: 'string', default: '4321' },
    host: { type: 'string', default: '127.0.0.1' },
    token: { type: 'string' },
    static: { type: 'string' },
    'allow-origin': { type: 'string', multiple: true },
    bootstrap: { type: 'string', multiple: true },
    relay: { type: 'string', multiple: true },
    'peer-port': { type: 'string' },
    'public-address': { type: 'string' },
    'dht-port': { type: 'string' },
    'serve-dht': { type: 'boolean' },
    'flush-ms': { type: 'string' },
    'auto-update': { type: 'boolean', default: false },
    'auto-update-all': { type: 'boolean', default: false },
    'commit-ms': { type: 'string' },
  },
});

/** A number flag, if given: refused at once rather than failing later as NaN. */
function numberFlag(flag: string, value: string | undefined, o: { min: number; whole: boolean }): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < o.min || (o.whole && !Number.isInteger(n))) {
    console.error(`[kuraa] --${flag} takes ${o.whole ? 'a whole number' : 'a number'} of at least ${o.min}, not "${value}"`);
    process.exit(2);
  }
  return n;
}
const port = numberFlag('port', values.port, { min: 0, whole: true })!;
const flushMs = numberFlag('flush-ms', values['flush-ms'], { min: 1, whole: true });
const commitMs = numberFlag('commit-ms', values['commit-ms'], { min: 1, whole: true });

const cpus = numberFlag('cpus', values.cpus, { min: 0.1, whole: false });

// The settings the flags give: they win over the saved ones, and the app says so.
const flags: Partial<Settings> = Object.fromEntries(Object.entries({
  bootstrap: values.bootstrap,
  relays: values.relay,
  runCode: values.engine ? values.engine.some((e) => e !== 'none') : undefined,
  environment: values.env,
  rImages: values['r-image'],
  memory: values.memory,
  cpus,
  disk: values.disk,
  allowWrite: values['allow-write'],
  allowNetwork: values['allow-network'],
  allowInstalls: values['allow-installs'],
  renderWhereCodeRuns: values['render-where-code-runs'],
  dataDir: values['data-dir'] ? resolve(values['data-dir']) : undefined,
  formats: values.format,
  features: values.feature,
  saveSeconds: flushMs !== undefined ? flushMs / 1000 : undefined,
  versionSeconds: commitMs !== undefined ? commitMs / 1000 : undefined,
  workspaces: values.workspaces ? resolve(values.workspaces) : undefined,
}).filter(([, v]) => v !== undefined));

// Kept with the app's data, apart from the desktop app's (its preferences.json and list).
const settingsFile = resolve(values.settings ?? join(defaultDataDir(), 'settings.json'));
const settings = new SettingsStore(settingsFile, flags);

// A shell that ships its own git says where it is (the Tauri app; the Electron app calls useGitFolder itself).
if (process.env.KURAA_GIT_DIR) useGitFolder(process.env.KURAA_GIT_DIR);

// Every server is a hub (docs/decisions/0030-one-kind-of-server.md): of one folder (--dir), or of
// your workspaces, in --workspaces or the settings' folder.
const hub = await startHub({
  ...(values.dir ? { folder: { dir: values.dir, init: values.init } } : values.workspaces ? { root: values.workspaces } : {
    // The list lives beside the settings, so choosing another folder for new workspaces keeps it.
    registry: join(dirname(settingsFile), 'host-workspaces.json'),
  }),
  defaultRoot: defaultWorkspacesFolder(),
  settings,
  port,
  host: values.host!,
  token: values.token ?? process.env.KURAA_TOKEN,
  staticDir: values.static,
  allowOrigins: values['allow-origin'],
  // What only flags set: more components, the sandbox, the Podman program, engines named.
  hosts: {
    features: standardFeatures,
    run: {
      ...(values.engine ? { engines: values.engine } : {}),
      components: [...standardRunComponents, ...(values.component ?? [])],
      allowUnsandboxed: values['allow-unsandboxed'],
      options: { podman: { podman: values.podman } },
    },
  },
  // A server's ways in (0053).
  peers: Object.fromEntries(Object.entries({
    peerPort: numberFlag('peer-port', values['peer-port'], { min: 1, whole: true }),
    publicAddress: values['public-address'],
    dhtPort: numberFlag('dht-port', values['dht-port'], { min: 1, whole: true }),
    serveDht: values['serve-dht'],
  }).filter(([, v]) => v !== undefined)),
  log: (m) => console.log(`[kuraa] ${m}`),
});
const close = () => hub.close();
if (!values.dir) console.log(`[kuraa] workspaces: ${hub.hub.root}`);
else console.log(`[kuraa] workspace: ${hub.hub.root}`);
console.log(`[kuraa] settings:  ${settingsFile}`);
if (!hub.hub.owner) console.log(`[kuraa] ${OWNER_OFF}`);
console.log(`[kuraa] url:       ${hub.url}`);
// As a service its output is a log file, so its access code is not written there: it is in the service's own settings.
const service = runsAsService();
const token = service ? '<token>' : hub.token;
console.log(`[kuraa] token:     ${service ? 'KURAA_TOKEN in the service (not shown in its log)' : token}`);
if (values.static) console.log(`[kuraa] open:      ${hub.url}/?token=${token}`);
if (values.dir) {
  const [w] = hub.hub.list();
  console.log(`[kuraa] git clone: git clone http://kuraa:${token}@${hub.url.replace(/^https?:\/\//, '')}/w/${w!.id}/git ${w!.id}`);
}

// Write and commit pending edits, then exit. A signal often arrives twice at once
// (from the terminal to the whole process group, and relayed by a supervisor such
// as tsx watch), so repeats are ignored; a second Ctrl+C a moment later forces exit.
let stopping = 0;
const stop = (signal: string) => {
  if (stopping) {
    if (Date.now() - stopping > 1000) {
      console.log(`[kuraa] ${signal} again: exiting without waiting`);
      process.exit(1);
    }
    return;
  }
  stopping = Date.now();
  console.log('[kuraa] stopping: writing and committing pending edits');
  void close().then(
    () => process.exit(0),
    (e: Error) => {
      console.error(`[kuraa] stopping failed: ${e.message}`);
      process.exit(1);
    },
  );
};
// A released server updating itself (selfupdate.ts): it stops, saving everything, for its service to start the new version.
const released = (globalThis as { kuraaServer?: { here: string; build: import('./selfupdate.js').ServerBuild } }).kuraaServer;
if (values['auto-update'] || values['auto-update-all']) {
  if (!released) console.log('[kuraa] --auto-update: this host runs from the repository; update it with git pull');
  else {
    const { autoUpdate } = await import('./selfupdate.js');
    const { onNewerVersion, onNewerRelease } = await import('./index.js');
    autoUpdate({ ...released, all: values['auto-update-all'], log: (m) => console.log(`[kuraa] ${m}`), restart: () => stop('update'), newer: (fn) => void onNewerVersion(fn), newerRelease: (fn) => void onNewerRelease(fn) });
  }
}

process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
// An error nothing caught: said, everything saved that can be, and the server goes on (lastresort.ts).
lastResort({ log: (m) => console.error(`[kuraa] ${m}`), save: () => hub.hub.saveAll(), stop: () => stop('too many errors') });
