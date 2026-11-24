// Settings kept in the browser: an access code is only ever sent to the host it
// was given for, whatever a link or the address says.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadSettings, saveSettings, hostOf } from '../src/settings.js';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
});

const ANN = { name: 'Ann', email: 'a@x', color: '#000' };

describe('access codes, by host', () => {
  beforeEach(() => store.clear());

  it('never sends a code kept for one host to another named by a link', () => {
    saveSettings({ ...ANN, hostUrl: 'http://127.0.0.1:4321', token: 'VICTIM-SECRET' });
    // ?host=https://evil.example with no code (the review's proof).
    const s = loadSettings({ hostUrl: 'https://evil.example', token: '' });
    expect(s.hostUrl).toBe('https://evil.example');
    expect(s.token).toBe('');
    // A code alone (no address) is not taken for the host kept either.
    expect(loadSettings({ token: 'FROM-A-LINK' }).token).toBe('VICTIM-SECRET');
    expect(loadSettings().token).toBe('VICTIM-SECRET');
  });

  it('keeps a code for each host, and an override pairs its address with its code', () => {
    saveSettings({ ...ANN, hostUrl: 'http://127.0.0.1:4321', token: 'one' });
    saveSettings({ ...ANN, hostUrl: 'https://two.example/', token: 'two' });
    expect(loadSettings()).toMatchObject({ hostUrl: 'https://two.example/', token: 'two' });
    expect(loadSettings({ hostUrl: 'http://127.0.0.1:4321' }).token).toBe('one');
    expect(loadSettings({ hostUrl: 'http://127.0.0.1:4321', token: 'new' }).token).toBe('new');
    expect(JSON.parse(store.get('kuraa:settings')!)).not.toHaveProperty('token');
  });

  it('takes a code kept the old way as the kept address’s', () => {
    store.set('kuraa:settings', JSON.stringify({ ...ANN, hostUrl: 'http://127.0.0.1:4321', token: 'old' }));
    expect(loadSettings().token).toBe('old');
    expect(loadSettings({ hostUrl: 'https://evil.example' }).token).toBe('');
    saveSettings({ ...ANN, hostUrl: 'https://two.example', token: 'two' });
    expect(loadSettings({ hostUrl: 'http://127.0.0.1:4321/' }).token).toBe('old');
  });

  it('keeps the codes of the latest few hosts only', () => {
    for (let port = 5000; port < 5030; port++) saveSettings({ ...ANN, hostUrl: `http://127.0.0.1:${port}`, token: `t${port}` });
    const kept = JSON.parse(store.get('kuraa:settings')!) as { tokens: Record<string, string> };
    expect(Object.keys(kept.tokens)).toHaveLength(10);
    expect(loadSettings().token).toBe('t5029');
    expect(loadSettings({ hostUrl: 'http://127.0.0.1:5000' }).token).toBe('');
  });

  it('knows a host by its origin', () => {
    expect(hostOf('http://127.0.0.1:4321/')).toBe('http://127.0.0.1:4321');
    expect(hostOf('HTTPS://Example.org:443/w/x')).toBe('https://example.org');
  });
});
