// kuraa-server: a host that is always on, in workspaces as itself, with no person (docs/decisions/0099-servers.md).
//
// kuraa-server [options]               run the server
//   [--data <folder>]                  where it keeps its key, its workspaces and how it is reached
//                                      (default ~/.kuraa/server-data)
//   [--public-address host[:port]]     where members reach it over TCP: told to them, and put in invite links
//   [--peer-port N]                    take members' connections over TCP on this port (for networks that block UDP)
//   [--dht-port N] [--no-serve-dht]    its DHT node on a fixed port, for members to start from; never the public DHT
//   [--bootstrap host:port]... [--relay <key>]...   a private network's DHT nodes; relays
//   [--port 4322] [--host 127.0.0.1] [--token T] [--static dir]   its own page and API (whoever runs it reads only)
// kuraa-server join <invite link> [--data <folder>]   bring a workspace onto the running server, by a link for a server
//                                      (its owner makes one: People and computers › Add a server…)
// kuraa-server list [--data <folder>]  the workspaces it holds, and whether each has taken it in
// kuraa-server key [--data <folder>]   its key: what workspaces know it by
import { parseArgs } from 'node:util';
import { defaultServerData, joinServer, listServer, serverKey, startServer, SERVER_PORT } from './index.js';

const say = (m: string) => console.log(`[kuraa-server] ${m}`);

function fail(m: string, code = 1): never {
  console.error(`[kuraa-server] ${m}`);
  process.exit(code);
}

const { values, positionals } = parseArgs({
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
    static: { type: 'string' },
  },
});

/** A whole number flag of at least `min`, if given: refused at once rather than failing later. */
function whole(flag: string, value: string | undefined, min = 1): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min) fail(`--${flag} takes a whole number of at least ${min}, not "${value}"`, 2);
  return n;
}

const data = values.data ?? defaultServerData();
const [command, ...rest] = positionals;

try {
  if (command === 'join') {
    const link = rest[0];
    if (!link) fail('kuraa-server join <invite link>: the workspace’s owner makes one (People and computers › Add a server…)', 2);
    say('joining…');
    const w = await joinServer(link, data);
    say(`holding ${w.name} (${w.id}) in ${w.path}`);
    say(w.in ? 'the workspace has taken this server in' : 'the workspace will take this server in once its join reaches a device of it');
    process.exit(0);
  }
  if (command === 'list') {
    const list = await listServer(data);
    if (!list.length) say('no workspaces yet: kuraa-server join <invite link>');
    for (const w of list) console.log(`${w.id}  ${w.name}  ${w.error ? `(not open: ${w.error})` : w.in ? 'in' : 'not taken in yet'}`);
    process.exit(0);
  }
  if (command === 'key') {
    console.log((await serverKey(data)).publicKey.toString('hex'));
    process.exit(0);
  }
  if (command !== undefined) fail(`No command ${command}: kuraa-server, kuraa-server join <link>, list, key`, 2);
} catch (e) {
  fail((e as Error).message);
}

const peerPort = whole('peer-port', values['peer-port']);
const dhtPort = whole('dht-port', values['dht-port']);
const port = whole('port', values.port, 0) ?? SERVER_PORT;
const server = await startServer({
  data,
  host: values.host,
  port,
  token: values.token ?? process.env.KURAA_TOKEN,
  staticDir: values.static,
  publicAddress: values['public-address'],
  peerPort,
  dhtPort,
  serveDht: values['serve-dht'],
  bootstrap: values.bootstrap,
  relays: values.relay,
  log: say,
}).catch((e: Error) => fail(e.message));

say(`key:        ${server.key}`);
say(`data:       ${server.data}`);
say(`url:        ${server.hub.url}  (its page, read only; token in ${server.data}/server.json)`);
if (values['public-address'] && peerPort) say(`reached at: ${values['public-address']} (TCP ${peerPort})`);
else say('no --public-address and --peer-port: members reach this server through the DHT only, as any device');
say('bring a workspace here: kuraa-server join <invite link for a server>');

let stopping = false;
const stop = (signal: string) => {
  if (stopping) process.exit(1);
  stopping = true;
  say(`${signal}: stopping`);
  void server.close().then(() => process.exit(0), (e: Error) => fail(`stopping failed: ${e.message}`));
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
