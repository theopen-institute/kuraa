// Relays: a way through for two devices that cannot connect directly.
//
// Two computers behind routers that change their port for each connection
// ("randomized" NATs) cannot connect directly at all, and one behind one
// connects slowly. Hyperswarm can connect such devices through a blind relay:
// both connect to it, and it passes their encrypted streams on, seeing nothing
// of them (the connection between the two stays end to end, Noise).
//
// No server is needed for it: every device of a workspace whose own network is
// not of that kind runs a relay, with a key made anew each time it starts (kept
// nowhere), and tells it only to the members it is paired with (in its hello).
// A device that cannot connect to another directly goes through one of the
// relays its members offer. Relays run by someone (`kuraa-host relay`) can be
// named too (`--relay <key>`): a workspace of two devices has no third to
// relay through.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { Server as BlindRelay } from 'blind-relay';
import HyperDHT, { type DhtServer, type KeyPair } from 'hyperdht';

/** A relay key as members tell it: 32 bytes, hex. */
export const isRelayKey = (s: unknown): s is string => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s);

export class Relay {
  private server: DhtServer | null = null;
  private relay: BlindRelay | null = null;

  /** `keyPair`: kept (a relay run on its own, whose key people name); default, made anew. */
  constructor(private readonly dht: HyperDHT, readonly keyPair: KeyPair = HyperDHT.keyPair()) {}

  get key(): string {
    return this.keyPair.publicKey.toString('hex');
  }

  async start(): Promise<void> {
    const dht = this.dht;
    const relay = new BlindRelay({ createStream: (opts) => dht.createRawStream({ ...(opts as object), framed: true }) });
    this.relay = relay;
    // Anyone who knows the key may pair through it (both ends need the same token, made by
    // the two devices); members learn it only from each other, and it changes at each start.
    this.server = dht.createServer(undefined, (socket) => {
      socket.on('error', () => undefined);
      relay.accept(socket, { id: socket.remotePublicKey }).on('error', () => socket.destroy());
    });
    await this.server.listen(this.keyPair);
  }

  async close(): Promise<void> {
    await this.server?.close().catch(() => undefined);
    await this.relay?.close().catch(() => undefined);
  }
}

/** Where a relay run on its own keeps its key, so the key people named goes on working. */
export function relayKeyFile(): string {
  return process.env.KURAA_RELAY_KEY || join(homedir(), '.kuraa', 'relay.json');
}

/** The kept key of a relay run on its own, made the first time. */
export async function keptRelayKey(file = relayKeyFile()): Promise<KeyPair> {
  try {
    const { seed } = JSON.parse(await readFile(file, 'utf8')) as { seed?: unknown };
    if (typeof seed === 'string' && /^[0-9a-f]{64}$/.test(seed)) return HyperDHT.keyPair(Buffer.from(seed, 'hex'));
  } catch { /* none yet */ }
  const seed = randomBytes(32);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ seed: seed.toString('hex') }), { mode: 0o600 });
  return HyperDHT.keyPair(seed);
}
