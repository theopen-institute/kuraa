// What another device says, before it is logged (node.ts, saidByPeer, 0112): no control characters, so no forged log
// lines or terminal escapes, and not long.
import { describe, expect, it } from 'vitest';
import { saidByPeer } from '../src/peers/node.js';

describe('what another device says, logged (0112)', () => {
  it('has no new lines or escapes, and is cut short', () => {
    expect(saidByPeer('not in this workspace')).toBe('not in this workspace');
    expect(saidByPeer('a\nkuraa: forged line\r\u001b[31mred')).toBe('a kuraa: forged line  [31mred');
    expect(saidByPeer('x'.repeat(500))).toBe(`${'x'.repeat(200)}…`);
    expect(saidByPeer(undefined)).toBe('');
    expect(saidByPeer({ toString: () => 'odd' })).toBe('odd');
  });
});
