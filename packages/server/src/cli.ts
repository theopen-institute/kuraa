// A server's command line (docs/decisions/0099-servers.md): the program in its server role, always on,
// in workspaces as itself, with no person. From the repository, `pnpm server` (main.ts); released,
// `kuraa-host server` (release.ts), which a service runs, updating itself.
//
// server [options]                     run the server
//   [--data <folder>]                  where it keeps its key, its workspaces and how it is reached
//                                      (default ~/.kuraa/server-data)
//   [--public-address host[:port]]     where members reach it over TCP: told to them, and put in invite links
//   [--peer-port 5872]                 take members' connections over TCP on this port (for networks that block UDP)
//   [--dht-port 5872] [--no-serve-dht] its DHT node on this UDP port, for members to start from; never the public DHT
//                                      (open TCP and UDP 5872 in the firewall; 0 for either: any free port)
//   [--bootstrap host:port]... [--relay <key>]...   a private network's DHT nodes; relays
//   [--port 4322] [--host 127.0.0.1] [--token T]   its own API, for join and list: it serves no app (headless, for now)
//   [--auto-update]                    a release, installed, updates itself (0052); a release that
//                                      changes how devices sync, once one of its devices runs it (0112)
//   [--auto-update-all]                and such a release at once
// server join <invite link | -> [--data <folder>]   bring a workspace onto the running server, by a link for a server
//                                      (-: read from standard input, so it is not on the command line)
//                                      (its owner makes one: People and computers › Add a server…)
// server list [--data <folder>]        the workspaces it holds, and whether each has taken it in
// server remove <id> [--data <folder>] let go of a workspace (its copy here taken away; still in it until its owner takes it out)
// server key [--data <folder>]         its key: what workspaces know it by
import { parseArgs } from 'node:util';
import { lastResort, onNewerRelease, onNewerVersion, autoUpdate, runsAsService, type ServerBuild } from '@kuraa/host';
import { defaultServerData, joinServer, listServer, removeFromServer, serverKey, startServer, PEER_PORT, SERVER_PORT } from './index.js';

export interface ServerCliOptions {
  /** How it is called, in what it says: `kuraa-server` (default), or `kuraa-host server` released. */
  name?: string;
  /** Update itself (a release, installed, run by its service with --auto-update). */
  autoUpdate?: boolean;
  /** And take releases that change the protocol at once (--auto-update-all, 0112). */
  autoUpdateAll?: boolean;
  /** What this release is, and where it was unpacked: none, run from the repository. */
  released?: { here: string; build: ServerBuild };
}

const say = (m: string) => console.log(`[kuraa-server] ${m}`);

function fail(m: string, code = 1): never {
  console.error(`[kuraa-server] ${m}`);
  process.exit(code);
}

/** A whole number flag of at least `min`, if given: refused at once rather than failing later. */
function whole(flag: string, value: string | undefined, min = 1): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) fail(`--${flag} takes a whole number of at least ${min}, not "${value}"`, 2);
  return n;
}

/** Run the server's command line on `argv` (what follows the program, and `server` where released). */
export async function runServerCli(argv: string[], o: ServerCliOptions = {}): Promise<void> {
  const name = o.name ?? (o.released ? 'kuraa-host server' : 'kuraa-server');
  // What it writes (its workspaces' files, git's), for whoever runs it alone (0099).
  process.umask(0o077);
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    fail(`${(e as Error).message}: ${name} [--data <folder>] [--public-address host[:port]] [--peer-port N] …, or ${name} join <link>, list, key`, 2);
  }
  const { values, positionals } = parsed;
  const data = values.data ?? defaultServerData();
  const [command, ...rest] = positionals;

  try {
    if (command === 'join') {
      // `-`: the link from standard input, so it is not on the command line, where others on this computer see it.
      const link = rest[0] === '-' ? (await readStdin()).trim() : rest[0];
      if (!link) fail(`${name} join <invite link>: the workspace’s owner makes one (People and computers › Add a server…)`, 2);
      say('joining…');
      // How it is going, as it changes: each step; while copying, each tenth of each of git's stages.
      let last = '';
      const w = await joinServer(link, data, {
        progress: (p) => {
          const m = p.copied ? /^([A-Za-z ]+):\s+(\d+)%/.exec(p.copied) : null;
          const mark = `${p.step} ${m ? `${m[1]} ${Math.floor(Number(m[2]) / 10)}` : ''}`;
          if (mark === last) return;
          last = mark;
          if (p.step === 'waiting') say('waiting for another join on this server to finish…');
          else if (p.step === 'looking') say(`looking for a device of the workspace…${p.slowNetwork ? ' (this network makes connecting slow: it may take a minute or two)' : ''}`);
          else if (p.step === 'letting-in') say('found a device of the workspace; being let in…');
          else if (p.step === 'copying') say(`copying the workspace${p.from ? ` from ${p.from}` : ''}${p.copied ? `: ${p.copied}` : '…'}`);
          else if (p.step === 'opening') say('opening it…');
        },
      });
      say(`holding ${w.name} (${w.id}) in ${w.path}`);
      say(w.in ? 'the workspace has taken this server in' : 'the workspace will take this server in once its join reaches a device of it');
      process.exit(0);
    }
    if (command === 'list') {
      const list = await listServer(data);
      if (!list.length) say(`no workspaces yet: ${name} join <invite link>`);
      for (const w of list) console.log(`${w.id}  ${w.name}  ${w.error ? `(not open: ${w.error})` : w.opening ? 'opening…' : w.in ? 'in' : 'not taken in yet'}`);
      process.exit(0);
    }
    if (command === 'remove') {
      const id = rest[0];
      if (!id) fail(`${name} remove <id>: the workspace's id, as ${name} list says it`, 2);
      await removeFromServer(id, data);
      say(`let go of ${id}: its copy here is gone. The server is still in the workspace until its owner takes it out (People and computers › Servers › Remove…).`);
      process.exit(0);
    }
    if (command === 'key') {
      console.log((await serverKey(data)).publicKey.toString('hex'));
      process.exit(0);
    }
    if (command !== undefined) fail(`No command ${command}: ${name}, ${name} join <link>, list, remove <id>, key`, 2);
  } catch (e) {
    fail((e as Error).message);
  }

  // Stopping, from the moment it starts (0099): a signal while it opens its workspaces saves what it can rather than
  // cutting git off mid-write; and never waiting for ever, under the service's own limit.
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  let starting: Promise<unknown> = Promise.resolve();
  let stopping = 0;
  const stop = (why: string) => {
    if (stopping) {
      if (Date.now() - stopping > 1000) {
        say(`${why} again: exiting without waiting`);
        process.exit(1);
      }
      return;
    }
    stopping = Date.now();
    say(`${why}: stopping, saving everything`);
    setTimeout(() => {
      say('stopping took more than a minute: exiting without waiting');
      process.exit(1);
    }, 60_000).unref();
    void starting.catch(() => undefined).then(() => server?.close()).then(() => process.exit(0), (e: Error) => fail(`stopping failed: ${e.message}`));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));
  // An error nothing caught (lastresort.ts): one thrown, and it stops, to be started again by its service; promises no
  // one waited on, said and borne, up to twenty a minute.
  lastResort({ log: (m) => console.error(`[kuraa-server] ${m}`), save: async () => server?.hub.hub.saveAll(), stop: () => stop('an unexpected error'), stopOnException: true });

  const peerPort = whole('peer-port', values['peer-port'], 0) ?? PEER_PORT;
  const dhtPort = whole('dht-port', values['dht-port'], 0) ?? PEER_PORT;
  const port = whole('port', values.port, 0) ?? SERVER_PORT;
  const started = startServer({
    data,
    host: values.host,
    port,
    // As a service, its access code is the service's (KURAA_TOKEN), the same across restarts; never printed.
    token: values.token ?? process.env.KURAA_TOKEN,
    publicAddress: values['public-address'],
    peerPort,
    dhtPort,
    serveDht: values['serve-dht'],
    bootstrap: values.bootstrap,
    relays: values.relay,
    log: say,
  });
  starting = started;
  server = await started.catch((e: Error) => fail(e.message));

  say(`${o.released ? `kuraa ${o.released.build.version}, ` : ''}${runsAsService() ? 'as a service' : 'by hand'}`);
  say(`key:        ${server.key}`);
  say(`data:       ${server.data}`);
  say(`api:        ${server.hub.url}  (for ${name} join and list; no app: headless)`);
  say(`ports:      TCP ${peerPort || 'any'} (members' connections), UDP ${dhtPort || 'any'} (its DHT node)`);
  if (values['public-address']) say(`reached at: ${values['public-address']}`);
  else say('no --public-address: members are not told where it is, and reach it through the DHT, as any device');
  say(`bring a workspace here: ${name} join <invite link for a server>`);

  // Save everything, then exit (for its service to start it again, after an update). A signal often comes twice
  // at once (the terminal and a supervisor): repeats are let go; a second a moment later exits at once.
  if (o.autoUpdate || values['auto-update'] || values['auto-update-all']) {
    if (!o.released) say('--auto-update: this server runs from the repository; update it with git pull');
    else {
      // Restarting to update waits for a join under way (an hour at most): else it would be cut off, half done (0099).
      const running = server;
      const whenIdle = (fn: () => void, since = Date.now()) => {
        if (!running.hub.hub.joinsUnderWay || Date.now() - since > 3600_000) return fn();
        setTimeout(() => whenIdle(fn, since), 5000).unref();
      };
      autoUpdate({ ...o.released, all: !!(o.autoUpdateAll || values['auto-update-all']), log: say, restart: () => whenIdle(() => stop('update')), newer: (fn) => void onNewerVersion(fn), newerRelease: (fn) => void onNewerRelease(fn) });
    }
  }
}

/** All of standard input, as text. */
async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) parts.push(chunk as Buffer);
  return Buffer.concat(parts).toString('utf8');
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    allowNegative: true,
    options: {
      data: { type: 'string' },
      'public-address': { type: 'string' },
      'peer-port': { type: 'string' },
      'dht-port': { type: 'string' },
      'serve-dht': { type: 'boolean' },
      bootstrap: { type: 'string', multiple: true },
      relay: { type: 'string', multiple: true },
      port: { type: 'string' },
      host: { type: 'string' },
      token: { type: 'string' },
      'auto-update': { type: 'boolean' },
      'auto-update-all': { type: 'boolean' },
    },
  });
}
