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
