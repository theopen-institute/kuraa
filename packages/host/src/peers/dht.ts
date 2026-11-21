// One DHT node for the whole process, shared by every workspace's swarm (and
// the relay a device offers, relay.ts). Each workspace keeps its own key: only
// the node that finds devices and punches through routers is shared. A computer
// with many workspaces then probes its router once, starts once from the
// bootstrap servers, keeps one table of DHT nodes, and spends the few direct
// connections a hard router allows every 20 s once, not once per workspace.
//
// The DHT nodes it knows are kept between runs (~/.kuraa/dht-nodes.json), so
// the public bootstrap servers are needed only the first time, or when none of
// those answer. Not with bootstrap servers given (a private network, tests).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import HyperDHT from 'hyperdht';

interface Entry {
  dht: HyperDHT;
  users: number;
  /** Where the DHT nodes it knows are kept between runs (public network only). */
  nodesFile: string | null;
  saveTimer?: NodeJS.Timeout;
}

const entries = new Map<string, Entry>();

/** Where the DHT nodes this computer knows are kept between runs. */
export function dhtNodesFile(): string {
  return process.env.KURAA_DHT_NODES || join(homedir(), '.kuraa', 'dht-nodes.json');
}

/** How often the DHT nodes known are saved while running. */
const SAVE_MS = 10 * 60_000;

async function readNodes(file: string): Promise<{ host: string; port: number }[]> {
  try {
    const list = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!Array.isArray(list)) return [];
    return list.filter((n): n is { host: string; port: number } => !!n && typeof n.host === 'string' && Number.isInteger(n.port) && n.port > 0 && n.port < 65536).slice(0, 128);
  } catch {
    return [];
  }
}

async function saveNodes(e: Entry): Promise<void> {
  if (!e.nodesFile || e.dht.destroyed) return;
  const nodes = e.dht.toArray({ limit: 64 });
  if (!nodes.length) return;
  await mkdir(dirname(e.nodesFile), { recursive: true });
  await writeFile(e.nodesFile, JSON.stringify(nodes));
}

/**
 * The process's DHT node for these bootstrap servers (none: the public ones),
 * made on first use. Each user gets its own handle: destroying it (as a swarm
 * does when it is destroyed) lets go of the listeners added through it, and the
 * node is destroyed when the last handle is.
 */
export async function useDht(bootstrap?: unknown[], o: { port?: number; ephemeral?: boolean } = {}): Promise<HyperDHT> {
  const id = bootstrap ? JSON.stringify(bootstrap) : 'public';
  let e = entries.get(id);
  if (!e) {
    const nodesFile = bootstrap ? null : dhtNodesFile();
    const nodes = nodesFile ? await readNodes(nodesFile) : [];
    // Made meanwhile by another caller.
    e = entries.get(id);
    if (!e) {
      // A server's: on a fixed port, for members to start from (--dht-port); never serving the DHT if told.
      const dht = new HyperDHT({ ...(bootstrap ? { bootstrap } : {}), ...(nodes.length ? { nodes } : {}), ...(o.port ? { port: o.port } : {}), ...(o.ephemeral !== undefined ? { ephemeral: o.ephemeral } : {}) });
      e = { dht, users: 0, nodesFile };
      if (nodesFile) {
        e.saveTimer = setInterval(() => void saveNodes(e!).catch(() => undefined), SAVE_MS);
        e.saveTimer.unref();
      }
      entries.set(id, e);
    }
  }
  e.users++;
  return handle(id, e);
}

function handle(id: string, e: Entry): HyperDHT {
  const added: [string | symbol, (...a: unknown[]) => void][] = [];
  let released = false;
  const target = e.dht as unknown as Record<string | symbol, unknown> & HyperDHT;
  const proxy: HyperDHT = new Proxy(target, {
    get(t, prop) {
      if (prop === 'destroy') {
        return async () => {
          if (released) return;
          released = true;
          for (const [event, fn] of added) t.off(event, fn);
          if (--e.users > 0) return;
          entries.delete(id);
          clearInterval(e.saveTimer);
          await saveNodes(e).catch(() => undefined);
          await t.destroy();
        };
      }
      if (prop === 'on' || prop === 'addListener' || prop === 'once') {
        return (event: string | symbol, fn: (...a: unknown[]) => void) => {
          added.push([event, fn]);
          (t[prop] as (ev: string | symbol, f: (...a: unknown[]) => void) => unknown).call(t, event, fn);
          return proxy;
        };
      }
      const v = Reflect.get(t, prop, t);
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
    },
  }) as HyperDHT;
  return proxy;
}

/** How many DHT nodes the process runs (tests). */
export function dhtNodesRunning(): number {
  return entries.size;
}
