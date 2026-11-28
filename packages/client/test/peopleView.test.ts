// Whether a server holds this device's latest work, as People and its view say (peopleView.ts, 0112): only once it has
// been behind for more than a moment, and flagged once it has been for long.
import { describe, expect, it } from 'vitest';
import { serverHolds, type Device } from '../src/peopleView.js';

const device = (o: Partial<Device>): Device => ({ name: 'srv', key: 'ab'.repeat(32), person: null, online: true, through: [], related: false, otherVersion: false, server: true, ...o }) as Device;

describe('a server holding your work (0112)', () => {
  const now = 1_000_000_000;
  it('holds it, or is behind only after a moment, and long after ten minutes', () => {
    expect(serverHolds([device({ holdsMine: true, behindSince: null })], now)).toEqual({ state: 'holds' });
    // Behind for 30 s: work on its way, said as held.
    expect(serverHolds([device({ holdsMine: false, behindSince: now - 30_000 })], now)).toEqual({ state: 'holds' });
    expect(serverHolds([device({ holdsMine: false, behindSince: now - 5 * 60_000 })], now)).toEqual({ state: 'behind', since: now - 5 * 60_000, long: false });
    expect(serverHolds([device({ holdsMine: false, behindSince: now - 11 * 60_000 })], now)).toMatchObject({ state: 'behind', long: true });
  });

  it('says nothing where none of its devices is connected', () => {
    expect(serverHolds([device({ online: false })], now)).toBeNull();
    expect(serverHolds([], now)).toBeNull();
  });
});
