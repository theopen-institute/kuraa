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
import { readFile, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { standardFeatures } from '@kuraa/features';
import { standardRunComponents } from '@kuraa/run-components';
import { keptKey, startHub, type KeyPair, type PeerOptions, type RunningHub } from '@kuraa/host';

/** Where a server keeps everything, unless told: its key, its workspaces, how it is reached. */
export const defaultServerData = () => join(homedir(), '.kuraa', 'server-data');

/** The port a server's own API (for kuraa-server join and list) listens on, unless told: beside a host's 4321. */
export const SERVER_PORT = 4322;

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
   * public DHT. And DHT nodes and relays of a private network.
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
  const signing = await serverKey(data);
  const key = signing.publicKey.toString('hex');
  const peers: PeerOptions = Object.fromEntries(Object.entries({
    signing,
    person: null,
    publicAddress: o.publicAddress,
    peerPort: o.peerPort,
    dhtPort: o.dhtPort,
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

/** How the server in a folder is reached, as it wrote it when it started. */
export async function readAddress(data = defaultServerData()): Promise<ServerAddress> {
  let text: string;
  try {
    text = await readFile(join(resolve(data), 'server.json'), 'utf8');
  } catch {
    throw new Error(`No server is running from ${resolve(data)}: start it with kuraa-server`);
  }
  const a = JSON.parse(text) as Partial<ServerAddress>;
  if (typeof a.url !== 'string' || typeof a.token !== 'string' || typeof a.key !== 'string') throw new Error(`${join(resolve(data), 'server.json')} is damaged: start the server again`);
  return a as ServerAddress;
}

/** Ask the running server: its API, with its access code; the answer, or why not. */
async function ask<T>(a: ServerAddress, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(a.url + path, { ...init, headers: { authorization: `Bearer ${a.token}`, 'content-type': 'application/json' } });
  } catch {
    throw new Error(`The server at ${a.url} does not answer: is it running?`);
  }
  const body = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(body.error ?? `The server answered ${res.status}`);
  return body;
}

/** A workspace the server holds, and whether the workspace has taken it in yet (its join reached the policy there). */
export interface ServerWorkspace { id: string; name: string; path: string; in: boolean; error?: string }

/** Bring a workspace onto the running server, by an invite link for a server (0099). */
export async function joinServer(link: string, data = defaultServerData()): Promise<ServerWorkspace> {
  const a = await readAddress(data);
  const { workspace } = await ask<{ workspace: { id: string } }>(a, '/hub/api/workspaces', { method: 'POST', body: JSON.stringify({ kind: 'join', invitation: link }) });
  const held = (await listing(a)).find((w) => w.id === workspace.id);
  if (!held) throw new Error('The server joined, but does not list the workspace: see its log');
  return held;
}

/** What the running server holds (GET /hub/api/server): each workspace, and whether it has taken the server in. */
const listing = async (a: ServerAddress) => (await ask<{ workspaces: ServerWorkspace[] }>(a, '/hub/api/server')).workspaces;

/** The workspaces the running server holds. */
export async function listServer(data = defaultServerData()): Promise<ServerWorkspace[]> {
  return listing(await readAddress(data));
}
