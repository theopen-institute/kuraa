// pnpm dev [--dir <folder>] [--port 5173]
//
// The web client against a live host, for development, in one command:
//   - the host runs under `tsx watch`, so it restarts when host, session, kernel
//     or format code changes (it writes and commits pending edits as it stops,
//     and keeps room state in .git/kuraa, so open editors reconnect);
//   - Vite serves the client with hot reloading, and proxies /api, /git and
//     /collab to the host, so page and host share one origin;
//   - the token reaches the page through Vite's environment, so there is
//     nothing to paste.
// Without --dir it uses .dev-workspace/ in this repository (git-ignored),
// creating it with a sample file the first time.
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { gitIdentity, initWorkspace } from '../packages/host/src/index.js';

const ROOT = resolve(import.meta.dirname, '..');
const { values } = parseArgs({
  // `pnpm dev -- --dir x` passes the `--` through.
  args: process.argv.slice(2).filter((a) => a !== '--'),
  options: { dir: { type: 'string' }, port: { type: 'string', default: '5173' } },
});

const SAMPLE = `---
title: Scratch
---

# Scratch

A workspace for trying the editor. Type markdown: **bold**, *italic*, \`code\`, [links](https://example.org).

- a list
- of things
`;

async function workspace(): Promise<string> {
  if (values.dir) return resolve(values.dir);
  const dir = join(ROOT, '.dev-workspace');
  // Its own repository, not a folder of this one.
  if (!existsSync(join(dir, '.git'))) {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(join(dir, 'scratch.md'))) writeFileSync(join(dir, 'scratch.md'), SAMPLE);
    await initWorkspace(dir);
  }
  return dir;
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

const dir = await workspace();
const hostPort = await freePort();
const token = randomBytes(18).toString('base64url');
const who = await gitIdentity(dir);
const bin = (name: string) => join(ROOT, 'node_modules', '.bin', name);

const host = run('host', bin('tsx'), [
  'watch', '--clear-screen=false', 'packages/host/src/cli.ts',
  '--dir', dir, '--port', String(hostPort), '--host', '127.0.0.1',
], { KURAA_TOKEN: token });

const web = run('web', bin('vite'), ['--port', values.port!, '--strictPort', '--host', '127.0.0.1'], {
  KURAA_DEV_HOST: `http://127.0.0.1:${hostPort}`,
  VITE_KURAA_DEV_TOKEN: token,
  VITE_KURAA_DEV_NAME: who.name,
  VITE_KURAA_DEV_EMAIL: who.email,
}, join(ROOT, 'apps', 'web'));

console.log(`[dev] workspace ${dir}`);
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
for (const child of [host, web]) {
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(`[dev] a process exited (${code}); stopping`);
      stop(true);
    }
    if (host.exitCode !== null && web.exitCode !== null) process.exit(0);
  });
}
