// What Check for Updates… shows as updating goes (update-view.ts): a bar while
// it looks and downloads, how far and how fast, then Restart Now or Later.
import { describe, expect, it } from 'vitest';
import { bytes, updateView } from '../src/update-view.js';

describe('the updates window', () => {
  it('shows a bar that goes while it looks, and while a download has not said its size', () => {
    expect(updateView({ kind: 'checking' }, '0.1.6')).toMatchObject({ message: 'Looking for a newer version of kuraa…', progress: null, buttons: [{ choice: 'hide' }] });
    expect(updateView({ kind: 'downloading', version: '0.1.7', progress: null }, '0.1.6')).toMatchObject({ message: 'Downloading kuraa 0.1.7…', detail: 'Starting the download…', progress: null });
  });

  it('shows how far a download has come, how much of how much, and how fast, staying open with Hide', () => {
    const v = updateView({ kind: 'downloading', version: '0.1.7', progress: { percent: 42.5, transferred: 41_700_000, total: 98_100_000, bytesPerSecond: 4_150_000 } }, '0.1.6');
    expect(v.progress).toBeCloseTo(0.425);
    expect(v.detail).toBe('42 MB of 98 MB · 4.2 MB a second');
    expect(v.buttons).toEqual([{ choice: 'hide', label: 'Hide' }]);
    // No speed yet: not said.
    expect(updateView({ kind: 'downloading', version: '0.1.7', progress: { percent: 1, transferred: 900, total: 90_000, bytesPerSecond: 0 } }, '0.1.6').detail).toBe('900 B of 90 KB');
  });

  it('offers Restart Now, then Later, once ready; says the latest, failures and a copy that does not update', () => {
    expect(updateView({ kind: 'ready', version: '0.1.7' }, '0.1.6')).toMatchObject({ message: 'kuraa 0.1.7 is ready.', progress: 1, buttons: [{ choice: 'restart', label: 'Restart Now' }, { choice: 'later', label: 'Later' }] });
    expect(updateView({ kind: 'none' }, '0.1.6')).toMatchObject({ message: 'kuraa 0.1.6 is the latest version.', buttons: [{ choice: 'ok' }] });
    expect(updateView({ kind: 'none' }, '0.1.6').progress).toBeUndefined();
    expect(updateView({ kind: 'failed', message: 'net::ERR_INTERNET_DISCONNECTED' }, '0.1.6')).toMatchObject({ tone: 'warning', detail: 'net::ERR_INTERNET_DISCONNECTED', buttons: [{ choice: 'ok' }] });
    expect(updateView({ kind: 'off', why: 'run from the repository' }, '0.1.6').message).toBe('This copy of kuraa does not update itself (run from the repository).');
  });

  it('says sizes as people read them', () => {
    expect([bytes(512), bytes(840_000), bytes(1_250_000), bytes(98_100_000), bytes(2_400_000_000)]).toEqual(['512 B', '840 KB', '1.3 MB', '98 MB', '2.4 GB']);
  });
});
