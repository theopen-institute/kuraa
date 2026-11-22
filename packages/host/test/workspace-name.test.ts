// A workspace's own name (decision 0061): kept in .kuraa/workspace.json, read
// the same way on every device, even after two renames at once.
import { describe, expect, it } from 'vitest';
import { cleanName, MAX_NAME, nameText, parseName } from '../src/workspace.js';

describe('a workspace’s name', () => {
  it('is kept as one line of JSON, and read back', () => {
    expect(nameText('Field notes')).toBe('{"name":"Field notes"}\n');
    expect(parseName(nameText('Café “Ålesund”'))).toBe('Café “Ålesund”');
    expect(parseName('')).toBeNull();
    expect(parseName('not json\n')).toBeNull();
    expect(parseName('{"name":"  "}\n')).toBeNull();
    expect(parseName('{"name":42}\n')).toBeNull();
  });

  it('after two renames at once, is the first of them, as on every device (and with a merge base shown too)', () => {
    const conflict = '<<<<<<< ours\n{"name":"Shore survey"}\n=======\n{"name":"Tide pools"}\n>>>>>>> theirs\n';
    expect(parseName(conflict)).toBe('Shore survey');
    const diff3 = '<<<<<<< ours\n{"name":"Shore survey"}\n||||||| base\n{"name":"Field notes"}\n=======\n{"name":"Tide pools"}\n>>>>>>> theirs\n';
    expect(parseName(diff3)).toBe('Shore survey');
  });

  it('is something, spaces tidied, and not too long', () => {
    expect(cleanName('  Field \t notes  ')).toBe('Field notes');
    expect(() => cleanName('   ')).toThrow('needs a name');
    expect(() => cleanName(undefined)).toThrow('needs a name');
    expect(cleanName('x'.repeat(MAX_NAME))).toHaveLength(MAX_NAME);
    expect(() => cleanName('x'.repeat(MAX_NAME + 1))).toThrow('at most');
  });
});
