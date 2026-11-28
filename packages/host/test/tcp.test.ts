// The TCP listener's limits on connections that have not said which device they are for (tcp.ts, 0099, 0112): a
// deadline from when each is taken, not an idle time; so many from one address, an IPv6 one counted by its /64.
import { afterEach, describe, expect, it } from 'vitest';
import { connect, type Socket } from 'node:net';
import { addressGroup, listenTcp } from '../src/peers/tcp.js';

const stops: (() => void)[] = [];
const sockets: Socket[] = [];
afterEach(() => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const stop of stops.splice(0)) stop();
});

const KEY = 'ab'.repeat(32);
const closed = (s: Socket) => new Promise<number>((resolve) => {
  const at = Date.now();
  s.once('close', () => resolve(Date.now() - at));
});

describe('the TCP listener (0112)', () => {
  it('counts an IPv6 address by its /64, an IPv4 one (or one mapped into IPv6) as it is', () => {
    expect(addressGroup('2001:db8:1:2:3:4:5:6')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:db8:1:2:ffff::1')).toBe('2001:db8:1:2::/64');
    expect(addressGroup('2001:db8::1')).toBe('2001:db8:0:0::/64');
    expect(addressGroup('fe80::1%en0')).toBe('fe80:0:0:0::/64');
    expect(addressGroup('203.0.113.7')).toBe('203.0.113.7');
    expect(addressGroup('::ffff:203.0.113.7')).toBe('203.0.113.7');
  });

  it('closes a connection that has not said which device it is for within five seconds, however slowly it sends', async () => {
    const l = await listenTcp(KEY, 0, () => undefined, () => undefined);
    stops.push(l!.stop);
    const s = connect(l!.port, '127.0.0.1');
    sockets.push(s);
    s.on('error', () => undefined);
    const gone = closed(s);
    // A byte every second: an idle time would never run out.
    const drip = setInterval(() => s.write('k'), 1000);
    const after = await gone;
    clearInterval(drip);
    expect(after).toBeLessThan(7000);
  }, 15_000);

  it('hands on a connection that says which device it is for at once', async () => {
    let handed = false;
    const l = await listenTcp(KEY, 0, () => void (handed = true), () => undefined);
    stops.push(l!.stop);
    const s = connect(l!.port, '127.0.0.1');
    sockets.push(s);
    s.write(`kuraa ${KEY}\n`);
    await new Promise((r) => setTimeout(r, 300));
    expect(handed).toBe(true);
  });

  it('takes no more than sixteen waiting from one address', async () => {
    const l = await listenTcp(KEY, 0, () => undefined, () => undefined);
    stops.push(l!.stop);
    const open = Array.from({ length: 17 }, () => {
      const s = connect(l!.port, '127.0.0.1');
      s.on('error', () => undefined);
      sockets.push(s);
      return s;
    });
    const state = open.map(() => 'open');
    open.forEach((s, i) => s.once('close', () => void (state[i] = 'closed')));
    await new Promise((r) => setTimeout(r, 500));
    expect(state.filter((x) => x === 'closed')).toHaveLength(1);
  });
});
