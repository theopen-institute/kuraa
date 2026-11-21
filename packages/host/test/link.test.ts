// One connection between two devices: room messages go as bytes on their own
// channel, sent at once (before the other end has opened it), and arrive whole.
import { describe, expect, it } from 'vitest';
import { duplexPair } from 'node:stream';
import type { SwarmConnection } from 'hyperswarm';
import { PeerLink, type ControlMessage } from '../src/peers/link.js';
import { bytesOf } from '../src/peers/rooms.js';

function linked(): [PeerLink, PeerLink] {
  const [x, y] = duplexPair();
  const conn = (s: typeof x, key: number) => Object.assign(s, { remotePublicKey: Buffer.alloc(32, key), publicKey: Buffer.alloc(32, 9 - key) }) as unknown as SwarmConnection;
  return [new PeerLink(conn(x, 1), () => undefined), new PeerLink(conn(y, 2), () => undefined)];
}

const next = (link: PeerLink) => new Promise<ControlMessage>((resolve) => {
  const stop = link.onMessage((m) => {
    stop();
    resolve(m);
  });
});

describe('room messages between devices', () => {
  const update = new Uint8Array([0, 1, 2, 250, 255, 7]);

  it('arrive whole, as bytes, even sent as the connection opens', async () => {
    const [a, b] = linked();
    const got = next(b);
    a.sendRoom({ type: 'room', op: 'update', key: 'main\0notes.md\0pandoc@1', update, by: null });
    const m = (await got) as Extract<ControlMessage, { type: 'room' }>;
    expect(m).toMatchObject({ type: 'room', op: 'update', key: 'main\0notes.md\0pandoc@1', by: null });
    expect([...bytesOf(m.update)]).toEqual([...update]);
    a.close();
    b.close();
  });

  it('are not taken from the control channel', async () => {
    const [a, b] = linked();
    const got: ControlMessage[] = [];
    b.onMessage((m) => got.push(m));
    a.send({ type: 'room', op: 'update', key: 'k', update: 'AAEC', by: null } as ControlMessage);
    a.send({ type: 'refs' });
    for (let i = 0; i < 100 && !got.length; i++) await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual([{ type: 'refs' }]);
    a.close();
    b.close();
  });
});

describe('git streams between devices', () => {
  it('make a fast writer wait for a slow reader, rather than pile up what it sent', async () => {
    const [a, b] = linked();
    let served: import('node:stream').Duplex | null = null;
    b.onGit((_service, _protocol, stream) => (served = stream));
    const reading = a.openGit('git-upload-pack', '');
    reading.write(Buffer.from('want'));
    for (let i = 0; i < 100 && !served; i++) await new Promise((r) => setTimeout(r, 10));
    const writer = served as unknown as import('node:stream').Duplex;
    // 8 MiB, written as fast as the stream takes it; the reader takes nothing yet.
    const chunk = Buffer.alloc(64 * 1024, 7);
    let written = 0;
    const writing = (async () => {
      while (written < 8 * 1024 * 1024) {
        if (!writer.write(chunk)) await new Promise((r) => writer.once('drain', r));
        written += chunk.length;
      }
      writer.end();
    })();
    await new Promise((r) => setTimeout(r, 300));
    // Held back at about the window (1 MiB) and the streams' own buffers, not all 8 MiB.
    expect(written).toBeLessThan(3 * 1024 * 1024);
    expect(reading.readableLength).toBeLessThan(3 * 1024 * 1024);
    // Read, everything comes, whole.
    let got = 0;
    reading.on('data', (d: Buffer) => (got += d.length));
    await writing;
    await new Promise((r) => reading.once('end', r));
    expect(got).toBe(8 * 1024 * 1024);
    a.close();
    b.close();
  });
});
