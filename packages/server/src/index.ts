// A server (docs/decisions/0099-servers.md): a host that is always on, in the
// workspaces shared with it as itself, with no person. What a server may do in a
// workspace (in by the owner's link for a server, reading, never writing) is in
// the host's peer layer, which every device keeps; this is what running one is:
//
// - its own signing key (`signing.json` in its folder), one for all its
//   workspaces, never a person's: a server's join signed by a key someone vouched
//   for counts for nothing, so it is not the computer's own key;
// - a hub of its workspaces (`workspaces/`), each host with no person, none made
//   here: each comes by a link for a server (join);
// - no code run;
// - headless: no app, no workspace's files, history or people over HTTP, until
//   people can sign in to one; its port answers only what `kuraa-server join`
//   and `list` ask (the hub's serverApi);
// - where it is reached (`server.json`: its address and access code, readable by
//   whoever runs it alone), for those commands to ask it.
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { standardFeatures } from '@kuraa/features';
import { standardRunComponents } from '@kuraa/run-components';
import { keptKey, startHub, type KeyPair, type PeerOptions, type RunningHub } from '@kuraa/host';

/** Where a server keeps everything, unless told: its key, its workspaces, how it is reached. */
export const defaultServerData = () => join(homedir(), '.kuraa', 'server-data');

/** The port a server's own API (for kuraa-server join and list) listens on, unless told: beside a host's 4321. */
export const SERVER_PORT = 4322;

/**
 * Where members reach a server, unless told (0099): TCP for their connections,
 * UDP for its DHT node, the same number. KURA on a phone's keys; unassigned by
 * IANA for both, as are its neighbours.
 */
export const PEER_PORT = 5872;

export interface ServerOptions {
  /** Its folder (default ~/.kuraa/server-data). */
  data?: string;
  /** Its own API (join, list: no app, 0099): where it listens (default 127.0.0.1, port 4322) and with which access code (default: a new one). */
  host?: string;
  port?: number;
  token?: string;
  /**
   * Where members reach it (0053): over TCP on `peerPort`, at `publicAddress`
   * (`host` or `host:port`), told to members and put in invite links; its DHT
   * node on `dhtPort`, for members to start from; `serveDht: false`, never the
   * public DHT. And DHT nodes and relays of a private network. Both ports are
   * PEER_PORT (5872) unless told; 0, any free one.
   */
  publicAddress?: string;
  peerPort?: number;
  dhtPort?: number;
  serveDht?: boolean;
  bootstrap?: PeerOptions['bootstrap'];
  relays?: string[];
  log?: (m: string) => void;
}

export interface RunningServer {
  hub: RunningHub;
  /** Its signing key, hex: what workspaces know it by. */
  key: string;
  /** Its folder. */
  data: string;
  close(): Promise<void>;
}

/** How a running server is reached, as it wrote it in its folder. */
export interface ServerAddress { url: string; token: string; key: string; pid: number }

/** A server's signing key: made the first time, in its folder, and kept (0099: one for all its workspaces). */
export function serverKey(data = defaultServerData()): Promise<KeyPair> {
  return keptKey(join(resolve(data), 'signing.json'));
}

/** Start a server: a hub of its workspaces as no person, with its own key (0099). */
export async function startServer(o: ServerOptions = {}): Promise<RunningServer> {
  const data = resolve(o.data ?? defaultServerData());
  // Its folder, and all it holds, for whoever runs it alone (0099): the workspaces it holds, private ones included.
  await mkdir(data, { recursive: true, mode: 0o700 });
  await chmod(data, 0o700);
  const signing = await serverKey(data);
  const key = signing.publicKey.toString('hex');
  const peers: PeerOptions = Object.fromEntries(Object.entries({
    signing,
    person: null,
    publicAddress: o.publicAddress,
    peerPort: o.peerPort ?? PEER_PORT,
    dhtPort: o.dhtPort ?? PEER_PORT,
    serveDht: o.serveDht,
    bootstrap: o.bootstrap,
    relays: o.relays,
  }).filter(([, v]) => v !== undefined));
  const hub = await startHub({
    server: true,
    root: join(data, 'workspaces'),
    host: o.host ?? '127.0.0.1',
    port: o.port ?? SERVER_PORT,
    token: o.token,
    // Formats and features to read with; no code run on a server yet (0099: running code for a device that cannot is to come).
    hosts: { features: standardFeatures, run: { engines: [], components: standardRunComponents } },
    peers,
    log: o.log,
  });
  const address: ServerAddress = { url: hub.url, token: hub.token, key, pid: process.pid };
  const file = join(data, 'server.json');
  // Readable only by whoever runs it: it holds the access code.
  await writeFile(file, JSON.stringify(address, null, 1), { mode: 0o600 });
  return {
    hub, key, data,
    close: async () => {
      await hub.close();
      // Only its own: another started since in the same folder keeps its.
      const now = await readAddress(data).catch(() => null);
      if (now?.pid === process.pid && now.url === hub.url) await rm(file, { force: true });
    },
  };
}

/**
 * How the server in a folder is reached, as it wrote it when it started. `waitMs`:
 * how long to wait for one that is starting (a restart takes a moment, its file
 * gone meanwhile).
 */
export async function readAddress(data = defaultServerData(), o: { waitMs?: number } = {}): Promise<ServerAddress> {
  const file = join(resolve(data), 'server.json');
  const until = Date.now() + (o.waitMs ?? 0);
  for (;;) {
    let text: string | null = null;
    try {
      text = await readFile(file, 'utf8');
    } catch { /* not running, or starting */ }
    if (text !== null) {
      const a = JSON.parse(text) as Partial<ServerAddress>;
      if (typeof a.url !== 'string' || typeof a.token !== 'string' || typeof a.key !== 'string') throw new Error(`${file} is damaged: start the server again`);
      return a as ServerAddress;
    }
    if (Date.now() >= until) throw new Error(`No server is running from ${resolve(data)}: start it (as a service: systemctl --user start kuraa; by hand: kuraa-host server, or pnpm server)`);
    await new Promise((r) => setTimeout(r, 500));
  }
}

/** How long a command waits for a server that is starting, or restarting. */
const STARTING_MS = 20_000;

/**
 * Ask the running server: its API, with its access code; the answer, or why not.
 * Over node:http, with no time limit of its own (a join copying a large workspace
 * takes as long as it takes: fetch's would give up after five minutes). A server
 * not answering yet (restarting) is asked again, for a while.
 */
function ask<T>(a: ServerAddress, path: string, o: { method?: string; body?: unknown } = {}): Promise<T> {
  const until = Date.now() + STARTING_MS;
  const once = () => new Promise<T>((done, fail) => {
    const body = o.body === undefined ? undefined : JSON.stringify(o.body);
    const req = request(a.url + path, { method: o.method ?? 'GET', headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json', ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) } }, (res) => {
      const parts: Buffer[] = [];
      res.on('data', (d: Buffer) => parts.push(d));
      res.on('end', () => {
        let answer: T & { error?: string };
        try {
          answer = JSON.parse(Buffer.concat(parts).toString('utf8')) as T & { error?: string };
        } catch {
          answer = {} as T & { error?: string };
        }
        if ((res.statusCode ?? 500) >= 400) fail(new Error(answer.error ?? `The server answered ${res.statusCode}`));
        else done(answer);
      });
      res.on('error', fail);
    });
    req.on('error', (e: NodeJS.ErrnoException) => fail(Object.assign(new Error(`The server at ${a.url} does not answer: is it running?`), { code: e.code })));
    req.end(body);
  });
  const attempt = async (): Promise<T> => {
    try {
      return await once();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ECONNREFUSED' && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 500));
        return attempt();
      }
      throw e;
    }
  };
  return attempt();
}

/** A workspace the server holds, and whether the workspace has taken it in yet (its join reached the policy there). */
export interface ServerWorkspace { id: string; name: string; path: string; in: boolean; error?: string }

/** How a join is going, as the server says it (its steps, and how far a copy is). */
export interface JoinStep { step: 'waiting' | 'looking' | 'letting-in' | 'copying' | 'opening'; slowNetwork: boolean; from?: string; copied?: string }

/**
 * Bring a workspace onto the running server, by an invite link for a server
 * (0099). `progress`: how it is going, each time that changes (asked every
 * second, while the join itself is asked once, and waited for however long).
 */
export async function joinServer(link: string, data = defaultServerData(), o: { progress?: (s: JoinStep) => void } = {}): Promise<ServerWorkspace> {
  const a = await readAddress(data, { waitMs: STARTING_MS });
  const id = randomBytes(12).toString('base64url');
  let said = '';
  let polling = true;
  const poll = async () => {
    while (polling) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!polling) return;
      const now = await ask<JoinStep>(a, `/hub/api/joins/${id}`).catch(() => null);
      const text = JSON.stringify(now);
      if (now && polling && text !== said) {
        said = text;
        o.progress?.(now);
      }
    }
  };
  const watching = o.progress ? poll() : Promise.resolve();
  try {
    const { workspace } = await ask<{ workspace: { id: string } }>(a, '/hub/api/workspaces', { method: 'POST', body: { kind: 'join', invitation: link, progress: id } });
    const held = (await listing(a)).find((w) => w.id === workspace.id);
    if (!held) throw new Error('The server joined, but does not list the workspace: see its log');
    return held;
  } finally {
    polling = false;
    await watching;
  }
}

/** What the running server holds (GET /hub/api/server): each workspace, and whether it has taken the server in. */
const listing = async (a: ServerAddress) => (await ask<{ workspaces: ServerWorkspace[] }>(a, '/hub/api/server')).workspaces;

/** The workspaces the running server holds. */
export async function listServer(data = defaultServerData()): Promise<ServerWorkspace[]> {
  return listing(await readAddress(data, { waitMs: STARTING_MS }));
}
