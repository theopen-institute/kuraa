// The workspace last open is kept by its host's address: one on this computer by its name alone.
import { describe, expect, it } from 'vitest';
import { keptAs } from '../src/workspaces.js';

describe('the workspace last open', () => {
  it('is kept for a host on this computer whatever port it takes this time (the desktop app’s changes at each start)', () => {
    expect(keptAs('http://127.0.0.1:53211')).toBe(keptAs('http://127.0.0.1:61002'));
    expect(keptAs('http://localhost:4321')).toBe('http://localhost');
  });

  it('is kept per address for a host elsewhere', () => {
    expect(keptAs('https://notes.example.org:8443')).toBe('https://notes.example.org:8443');
    expect(keptAs('http://192.168.1.20:4321')).not.toBe(keptAs('http://192.168.1.20:4322'));
  });
});
