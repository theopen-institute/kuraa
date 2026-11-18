// kuraa-host --dir <workspace> [--init] [--port 4321] [--host 127.0.0.1] [--token T] [--static dir] [--upstream origin]
// kuraa-host --workspaces <folder> [...]   a hub: many workspaces, added from the app (new folders
//                                          in <folder>, or joined by invitation or link); see hub.ts
//   formats:      [--format pandoc-markdown --format text ...]   (default: all)
//   running code: --engine r [--env podman] [--component <path or package>]...
//                 [--allow-write] [--allow-network] [--allow-installs] [--data-dir path]
//                 [--memory 4g] [--cpus 2] [--podman path] [--allow-unsandboxed]
//
// The run components that ship (@kuraa/run-components: R, and Podman containers) are
// always loaded; --component adds more. --env picks the environment code runs in;
// with only one loaded, that one. One that is not sandboxed needs --allow-unsandboxed.
//
// Everything that configures the host is a flag: people using the app can see
// what is on, but change nothing about the host.
//   devices:      --peer [--bootstrap host:port]...   sync with paired devices (see peers/cli.ts
//                 for invite, join, devices, upstream, fork)
import { parseArgs } from 'node:util';
import { standardRunComponents } from '@kuraa/run-components';
import { startHost, startHub } from './index.js';
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
    'device-name': { type: 'string' },
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
    podman: { type: 'string' },
    port: { type: 'string', default: '4321' },
    host: { type: 'string', default: '127.0.0.1' },
    token: { type: 'string' },
    static: { type: 'string' },
    upstream: { type: 'string' },
    peer: { type: 'boolean', default: false },
    bootstrap: { type: 'string', multiple: true },
    'flush-ms': { type: 'string' },
    'commit-ms': { type: 'string' },
  },
});

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
  cpus: values.cpus ? Number(values.cpus) : undefined,
  options: { podman: { podman: values.podman } },
};
const timings = {
  ...(values['flush-ms'] ? { flushMs: Number(values['flush-ms']) } : {}),
  ...(values['commit-ms'] ? { idleCommitMs: Number(values['commit-ms']) } : {}),
};

let close: () => Promise<void>;
if (values.workspaces) {
  const hub = await startHub({
    root: values.workspaces,
    port: Number(values.port),
    host: values.host!,
    token: values.token ?? process.env.KURAA_TOKEN,
    staticDir: values.static,
    hosts: { formats: values.format, run: runOptions, upstream: values.upstream, timings },
    peers: { bootstrap: values.bootstrap, everywhere: values.peer },
    deviceName: values['device-name'],
    log: (m) => console.log(`[kuraa] ${m}`),
  });
  console.log(`[kuraa] workspaces: ${hub.hub.root}`);
  console.log(`[kuraa] url:        ${hub.url}`);
  console.log(`[kuraa] token:      ${hub.token}`);
  if (values.static) console.log(`[kuraa] open:       ${hub.url}/?token=${hub.token}`);
  close = () => hub.close();
} else {
  const running = await startHost({
    dir: values.dir!,
    init: values.init,
    formats: values.format,
    // Nothing runs unless an engine is on.
    run: runOptions,
    port: Number(values.port),
    host: values.host!,
    token: values.token ?? process.env.KURAA_TOKEN,
    staticDir: values.static,
    upstream: values.upstream,
    peers: values.peer ? { bootstrap: values.bootstrap } : undefined,
    timings,
    log: (m) => console.log(`[kuraa] ${m}`),
  });
  console.log(`[kuraa] workspace: ${running.host.dir}`);
  console.log(`[kuraa] url:       ${running.url}`);
  console.log(`[kuraa] token:     ${running.token}`);
  if (values.static) console.log(`[kuraa] open:      ${running.url}/?token=${running.token}`);
  console.log(`[kuraa] git clone: git clone http://kuraa:${running.token}@${running.url.replace(/^https?:\/\//, '')}/git ${running.host.workspace}`);
  close = () => running.close();
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
