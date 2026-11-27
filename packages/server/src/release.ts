// kuraa as released (scripts/build-server.mjs builds this into one file, kuraa-host.mjs, with the
// web client beside it; decisions 0052, 0099). One program, two roles: a host, as cli.ts in
// @kuraa/host, serving the web client it came with; or, with `server`, a server (cli.ts here):
// headless, in workspaces as itself. And, for either:
//
//   kuraa-host install [--to ~/.kuraa/server] [--service] [-- <flags>]
//                       put this release in a folder of its own, from which it updates
//                       itself; --service: and a service that runs it with --auto-update
//                       and the flags after --, restarting it when it stops. As a server:
//                       -- server --public-address kuraa.example.org --peer-port 443
//   kuraa-host update   put the latest release in place, for the next start
//   kuraa-host --version
//   kuraa-host [server] --auto-update [...]   updating itself (selfupdate.ts)
//
// Its names (the archive kuraa-server-<version>.tar.gz, kuraa-host.mjs, ~/.kuraa/server, the
// service org.kuraa.server) are what installed computers look for and run: they stay.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { currentVersion, defaultServerRoot, installServer, installedRoot, setKuraaVersion, updateFrom, type ServerBuild } from '@kuraa/host';
import { roleOf } from './roles.js';
import { runServerCli } from './cli.js';

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

// Said to other devices, as either role (0099): one on an older release learns a newer is out.
await setKuraaVersion(build.version);
const role = roleOf(process.argv.slice(2));
if (role.role === 'server') {
  // A server (0099): headless, so no web client, whatever it came with.
  await runServerCli(role.args, { autoUpdate: role.autoUpdate, released: { here, build } });
} else {
  // A host, with the web client it came with unless told otherwise (not for a command: invite, devices…).
  if ((command === undefined || command.startsWith('-')) && !process.argv.includes('--static')) process.argv.push('--static', join(here, 'web'));
  // Read by cli.ts: what this build is, for --auto-update.
  (globalThis as { kuraaServer?: { here: string; build: ServerBuild } }).kuraaServer = { here, build };
  await import('@kuraa/host/cli');
}
