// Relays (peers/relay.ts) and the process's one DHT node (peers/dht.ts): two
// devices connect through a relay, which passes on what it cannot read; every
// swarm in a process shares one DHT node, gone once the last lets go of it; and
// the DHT nodes known are kept between runs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Hyperswarm from 'hyperswarm';
import HyperDHT from 'hyperdht';
import createTestnet, { type Testnet } from 'hyperdht/testnet.js';
import { Relay, keptRelayKey } from '../src/peers/relay.js';
import { dhtNodesRunning, useDht } from '../src/peers/dht.js';

let testnet: Testnet;
beforeAll(async () => {
  testnet = await createTestnet(3);
});
afterAll(async () => {
  await testnet.destroy();
});

describe('a relay', () => {
  it('connects two devices through it, passing on what it cannot read', async () => {
    // The relay on a DHT node of its own (another computer), the devices on theirs.
    const relayDht = new HyperDHT({ bootstrap: testnet.bootstrap });
    const relay = new Relay(relayDht);
    await relay.start();
    const through = () => Buffer.from(relay.key, 'hex');
    const a = new Hyperswarm({ bootstrap: testnet.bootstrap as never, relayThrough: through });
    const b = new Hyperswarm({ bootstrap: testnet.bootstrap as never, relayThrough: through });
    const got = new Promise<string>((resolve) => b.on('connection', (c) => {
      c.on('error', () => undefined);
      c.once('data', (d: Buffer) => resolve(d.toString()));
    }));
    a.on('connection', (c) => {
      c.on('error', () => undefined);
      c.write('hello through the relay');
    });
    await b.listen();
    a.joinPeer(b.keyPair.publicKey);
    expect(await got).toBe('hello through the relay');
    // Both went to the relay with the same token, and it paired them.
    const stats = (relay as unknown as { relay: { stats: { pairings: { matched: number } } } }).relay.stats;
    await new Promise((r) => setTimeout(r, 200));
    expect(stats.pairings.matched).toBeGreaterThan(0);
    await a.destroy();
    await b.destroy();
    await relay.close();
    await relayDht.destroy();
  }, 30_000);

  it('run on its own keeps its key, so the key people named goes on working', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kuraa-relay-'));
    try {
      const file = join(dir, 'relay.json');
      const one = await keptRelayKey(file);
      const two = await keptRelayKey(file);
      expect(two.publicKey.equals(one.publicKey)).toBe(true);
      expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')))).toEqual(['seed']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('the process’s DHT node', () => {
  it('is one for every swarm, destroyed once the last lets go of it', async () => {
    const before = dhtNodesRunning();
    const one = await useDht(testnet.bootstrap);
    const two = await useDht(testnet.bootstrap);
    expect(dhtNodesRunning()).toBe(before + 1);
    const a = new Hyperswarm({ dht: one });
    const b = new Hyperswarm({ dht: two });
    // Two swarms on one node still connect to each other (a fork and its origin on one hub).
    const connected = new Promise<void>((resolve) => b.on('connection', (c) => {
      c.on('error', () => undefined);
      resolve();
    }));
    a.on('connection', (c) => c.on('error', () => undefined));
    await b.listen();
    a.joinPeer(b.keyPair.publicKey);
    await connected;
    await a.destroy();
    expect(dhtNodesRunning()).toBe(before + 1);
    expect((one as unknown as { destroyed: boolean }).destroyed).toBe(false);
    await b.destroy();
    expect(dhtNodesRunning()).toBe(before);
  }, 30_000);

  it('on the public network, starts from the DHT nodes it knew last time', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kuraa-dht-'));
    const file = join(dir, 'dht-nodes.json');
    const was = process.env.KURAA_DHT_NODES;
    process.env.KURAA_DHT_NODES = file;
    try {
      // No bootstrap given (the public network); the testnet's nodes, kept from last time, are where it starts.
      const { writeFileSync } = await import('node:fs');
      writeFileSync(file, JSON.stringify(testnet.nodes.map((n) => ({ host: '127.0.0.1', port: n.address().port }))));
      const dht = await useDht();
      const known = (dht as unknown as { toArray(): { port: number }[] }).toArray().map((n) => n.port);
      expect(known.some((p) => testnet.nodes.some((n) => n.address().port === p))).toBe(true);
      await dht.destroy();
      // Kept again as it stops.
      expect(JSON.parse(readFileSync(file, 'utf8')).length).toBeGreaterThan(0);
    } finally {
      if (was === undefined) delete process.env.KURAA_DHT_NODES;
      else process.env.KURAA_DHT_NODES = was;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
