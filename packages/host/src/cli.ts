// kuraa-host --dir <workspace> [--init] [--port 4321] [--host 127.0.0.1] [--token T] [--static dir]
//                                          one folder; nothing is added from the app
// kuraa-host --workspaces <folder> [...]   many workspaces, added from the app (new folders
//                                          in <folder>, or joined by invitation or link)
// Either way the server is a hub (hub.ts): each workspace at /w/<id>, its list at /hub/api.
//   formats:      [--format pandoc-markdown --format text ...]   (default: all)
//   running code: --engine r [--env podman] [--component <path or package>]...
//                 [--allow-write] [--allow-network] [--allow-installs] [--data-dir path]
//                 [--memory 4g] [--cpus 2] [--disk 2g] [--podman path] [--allow-unsandboxed]
//                 [--r-image <image>]...   base images a workspace may name for R (besides the default)
//
// The run components that ship (@kuraa/run-components: R, and Podman containers) are
// always loaded; --component adds more. --env picks the environment code runs in;
// with only one loaded, that one. One that is not sandboxed needs --allow-unsandboxed.
//
// Everything that configures the host is a flag: people using the app can see
// what is on, but change nothing about the host.
//   devices:      --peer [--bootstrap host:port]...   sync with paired devices (see peers/cli.ts
//                 for invite, join, devices, sync-remote, fork); --allow-invites lets people make
//                 invitations and links from the app (a hub always does, for its workspaces)
//   people:       --manage-person   let people using the app see, make and import this computer's
//                 person's key (for one's own computer, as pnpm dev; refused unless --host is
//                 this computer alone, 127.0.0.1; never on a shared server)
//   backups:      --manage-backups  let people using the app add and remove backups (git servers
//                 pushed to with this computer's credentials); kuraa-host backup … from the command line
import { parseArgs } from 'node:util';
import { standardRunComponents } from '@kuraa/run-components';
import { startHub } from './index.js';
import { PEER_COMMANDS, peerCommand } from './peers/cli.js';

if (PEER_COMMANDS.includes(process.argv[2] ?? '')) {
  try {
    await peerCommand(process.argv.slice(2));
    process.exit(0);
  } catch (e) {
    console.error(`[kuraa] ${(e as Error).message}`);
    process.exit(1);
  }
}

const { values } = parseArgs({
  options: {
    dir: { type: 'string', default: '.' },
    workspaces: { type: 'string' },
    init: { type: 'boolean', default: false },
    format: { type: 'string', multiple: true },
    engine: { type: 'string', multiple: true },
    env: { type: 'string' },
    component: { type: 'string', multiple: true },
    'allow-unsandboxed': { type: 'boolean', default: false },
    'allow-write': { type: 'boolean', default: false },
    'allow-network': { type: 'boolean', default: false },
    'allow-installs': { type: 'boolean', default: false },
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
    peer: { type: 'boolean', default: false },
    'allow-invites': { type: 'boolean', default: false },
    'manage-person': { type: 'boolean', default: false },
    'manage-backups': { type: 'boolean', default: false },
    bootstrap: { type: 'string', multiple: true },
    'flush-ms': { type: 'string' },
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

const runOptions = {
  engines: values.engine ?? [],
  environment: values.env,
  components: [...standardRunComponents, ...(values.component ?? [])],
  allowUnsandboxed: values['allow-unsandboxed'],
  allowWorkspaceWrite: values['allow-write'],
  allowNetwork: values['allow-network'],
  allowInstalls: values['allow-installs'],
  dataDir: values['data-dir'],
  memory: values.memory,
  cpus: numberFlag('cpus', values.cpus, { min: 0.1, whole: false }),
  disk: values.disk,
  options: { podman: { podman: values.podman }, r: { images: values['r-image'] ?? [] } },
};
const timings = {
  ...(flushMs ? { flushMs } : {}),
  ...(commitMs ? { idleCommitMs: commitMs } : {}),
};

// Every server is a hub (docs/decisions/0030-one-kind-of-server.md): of a folder
// of workspaces people may add to (--workspaces), or of one folder (--dir).
const hub = await startHub({
  ...(values.workspaces ? { root: values.workspaces } : { folder: { dir: values.dir!, init: values.init } }),
  port,
  host: values.host!,
  token: values.token ?? process.env.KURAA_TOKEN,
  staticDir: values.static,
  // Nothing runs unless an engine is on.
  hosts: { formats: values.format, run: runOptions, timings, managePerson: values['manage-person'], manageBackups: values['manage-backups'] },
  peers: { bootstrap: values.bootstrap, everywhere: values.peer },
  // A hub of many lets people invite others to its workspaces; for one folder, the operator says (--allow-invites).
  invites: !!values.workspaces || values['allow-invites'],
  log: (m) => console.log(`[kuraa] ${m}`),
});
const close = () => hub.close();
if (values.workspaces) console.log(`[kuraa] workspaces: ${hub.hub.root}`);
else console.log(`[kuraa] workspace: ${hub.hub.root}`);
console.log(`[kuraa] url:       ${hub.url}`);
console.log(`[kuraa] token:     ${hub.token}`);
if (values.static) console.log(`[kuraa] open:      ${hub.url}/?token=${hub.token}`);
if (!values.workspaces) {
  const [w] = hub.hub.list();
  console.log(`[kuraa] git clone: git clone http://kuraa:${hub.token}@${hub.url.replace(/^https?:\/\//, '')}/w/${w!.id}/git ${w!.id}`);
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
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
