// kuraa-host as released (scripts/build-server.mjs builds this into one file,
// with the web client beside it; decision 0052). The same server as cli.ts,
// serving the web client it came with, and:
//
//   kuraa-host install [--to ~/.kuraa/server] [--service] [-- <server flags>]
//                       put this release in a folder of its own, from which it updates
//                       itself; --service: and a service that runs it with --auto-update
//                       and the flags after --, restarting it when it stops
//   kuraa-host update   put the latest release in place, for the next start
//   kuraa-host --version
//   kuraa-host --auto-update [...]   the server, updating itself (selfupdate.ts)
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentVersion, defaultServerRoot, installServer, installedRoot, updateFrom, type ServerBuild } from './selfupdate.js';

declare const __KURAA_SERVER__: ServerBuild;
const build = __KURAA_SERVER__;
const here = dirname(fileURLToPath(import.meta.url));
const [command] = process.argv.slice(2);

function done(lines: string[], code = 0): never {
  for (const l of lines) console.log(l);
  process.exit(code);
}

try {
  if (command === '--version') done([build.version]);
  if (command === 'install') {
    const args = process.argv.slice(3);
    const split = args.indexOf('--');
    const own = split < 0 ? args : args.slice(0, split);
    const to = own.includes('--to') ? own[own.indexOf('--to') + 1] : undefined;
    if (own.includes('--to') && !to) throw new Error('--to needs a folder');
    done(installServer({ here, version: build.version, root: to ?? defaultServerRoot(), service: own.includes('--service'), args: split < 0 ? [] : args.slice(split + 1) }));
  }
  if (command === 'update') {
    const root = installedRoot(here);
    if (!root) throw new Error('This copy is not installed: run kuraa-host install first');
    if (!build.repo) throw new Error('This server was built without a place to look for releases');
    const v = await updateFrom({ root, build });
    done([v ? `kuraa ${v} is in place: restart the server to use it.` : `kuraa ${currentVersion(root)} is the latest.`]);
  }
} catch (e) {
  done([`[kuraa] ${(e as Error).message}`], 1);
}

// The server, with the web client it came with unless told otherwise (not for a command: invite, devices…).
if ((command === undefined || command.startsWith('-')) && !process.argv.includes('--static')) process.argv.push('--static', join(here, 'web'));
// Read by cli.ts: what this build is, for --auto-update.
(globalThis as { kuraaServer?: { here: string; build: ServerBuild } }).kuraaServer = { here, build };
await import('./cli.js');
