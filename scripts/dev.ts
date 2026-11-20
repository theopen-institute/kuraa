// pnpm dev [--workspaces <folder> | --dir <folder>] [--port 5173] [--allow-write] [--allow-network]
//
// The web client against a live host, for development, in one command:
//   - the host runs under `tsx watch`, so it restarts when host, session, kernel
//     or format code changes (it writes and commits pending edits as it stops,
//     and keeps room state in .git/kuraa, so open editors reconnect);
//   - Vite serves the client with hot reloading, and proxies /api, /git and
//     /collab to the host, so page and host share one origin;
//   - the token reaches the page through Vite's environment, so there is
//     nothing to paste.
// It serves a folder of workspaces, as the desktop app does: .dev-workspaces/ in
// this repository (git-ignored), or --workspaces. The first time, it starts with a
// Scratch workspace holding a sample file. --dir serves one folder instead, as
// `kuraa-host --dir` does.
//
// Its Preferences (the hub's settings, decision 0047) are kept in
// .dev-workspaces/settings.json, or beside --workspaces; the page changes them as
// in the desktop app. R chunks run in Podman containers, as everywhere (never on
// this computer itself). --allow-write and --allow-network let the workspace ask
// for those in .kuraa/run.json (as flags, they win over the Preferences).
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gitIdentity, startHub } from '../packages/host/src/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  // `pnpm dev -- --dir x` passes the `--` through.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: {
    dir: { type: 'string' },
    workspaces: { type: 'string' },
    port: { type: 'string', default: '5173' },
    'allow-write': { type: 'boolean', default: false },
    'allow-network': { type: 'boolean', default: false },
  },
});

const SAMPLE = `---
title: Scratch
---

# Scratch

A workspace for trying the editor. Type markdown: **bold**, *italic*, \`code\`, [links](https://example.org).

- a list
- of things
`;

/** What the host serves: one folder (--dir), or a folder of workspaces, made with one the first time. */
async function served(): Promise<{ flag: '--dir' | '--workspaces'; dir: string }> {
  if (values.dir) return { flag: '--dir', dir: resolve(values.dir) };
  const root = resolve(values.workspaces ?? join(ROOT, '.dev-workspaces'));
  if (!existsSync(join(root, '.kuraa-workspaces.json'))) {
    const hub = await startHub({ root, log: (m) => console.log(`[dev] ${m}`) });
    try {
      const scratch = join(root, 'scratch');
      mkdirSync(scratch, { recursive: true });
      if (!existsSync(join(scratch, 'scratch.md'))) writeFileSync(join(scratch, 'scratch.md'), SAMPLE);
      await hub.hub.addFolder(scratch, true, 'Scratch');
    } finally {
      await hub.close();
    }
  }
  return { flag: '--workspaces', dir: root };
}

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const server = createServer();
    server.once('error', fail);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => done(port));
    });
  });
}

function run(name: string, command: string, args: string[], env: NodeJS.ProcessEnv, cwd = ROOT): ChildProcess {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const prefix = (chunk: Buffer) => chunk.toString().replace(/\n(?!$)/g, `\n[${name}] `).replace(/^/, `[${name}] `);
  child.stdout!.on('data', (d: Buffer) => process.stdout.write(prefix(d)));
  child.stderr!.on('data', (d: Buffer) => process.stderr.write(prefix(d)));
  return child;
}

const { flag, dir } = await served();
const hostPort = await freePort();
const token = randomBytes(18).toString('base64url');
const who = await gitIdentity(dir);
const bin = (name: string) => join(ROOT, 'node_modules', '.bin', name);

// Never the app's own settings: the developer's are kept with the workspaces they develop with.
const settings = values.workspaces ? join(dir, '.kuraa-settings.json') : join(ROOT, '.dev-workspaces', 'settings.json');
const host = run('host', bin('tsx'), [
  'watch', '--clear-screen=false', 'packages/host/src/cli.ts',
  flag, dir, '--port', String(hostPort), '--host', '127.0.0.1', '--settings', settings,
  // Listening only on this computer: the page has Preferences, Open a folder…, your identity
  // and the online copy, as the desktop app has (decision 0047).
  ...(values['allow-write'] ? ['--allow-write'] : []),
  ...(values['allow-network'] ? ['--allow-network'] : []),
], { KURAA_TOKEN: token });

const web = run('web', bin('vite'), ['--port', values.port!, '--strictPort', '--host', '127.0.0.1'], {
  KURAA_DEV_HOST: `http://127.0.0.1:${hostPort}`,
  VITE_KURAA_DEV_TOKEN: token,
  VITE_KURAA_DEV_NAME: who.name,
  VITE_KURAA_DEV_EMAIL: who.email,
}, join(ROOT, 'apps', 'web'));

console.log(`[dev] ${flag === '--dir' ? 'workspace ' : 'workspaces'} ${dir}`);
console.log(`[dev] open      http://127.0.0.1:${values.port}/`);

// The host writes and commits pending edits before it exits. Ctrl+C reaches every
// process in the terminal's group, children included, so on SIGINT there is
// nothing to forward: a second signal would make tsx kill the host mid-flush.
let stopping = false;
const stop = (forward: boolean) => {
  if (stopping) return;
  stopping = true;
  if (forward) for (const child of [web, host]) child.kill('SIGTERM');
};
process.on('SIGINT', () => stop(false));
process.on('SIGTERM', () => stop(true));
// The host saves its own edits on an unexpected error (cli.ts); here, one is said, and the processes go on.
process.on('unhandledRejection', (e) => console.error(`[dev] unexpected error: ${String(e)}`));
process.on('uncaughtException', (e) => console.error(`[dev] unexpected error: ${e.stack ?? e.message}`));
for (const child of [host, web]) {
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`[dev] a process exited (${code}); stopping`);
      stop(true);
    }
    if (host.exitCode !== null && web.exitCode !== null) process.exit(0);
  });
}
