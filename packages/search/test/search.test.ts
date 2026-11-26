import { describe, expect, it } from 'vitest';
import { searchFeature } from '../src/index.js';
import { S } from '../src/strings.js';

describe('search, as a component (0089)', () => {
  it('says its counts with the plural rules', () => {
    expect(S.summary(1, 1, false)).toBe('1 match in 1 file.');
    expect(S.summary(3, 2, true)).toBe('3 matches in 2 files (only the first are shown).');
  });

  it('is on by default', () => {
    expect(searchFeature.onByDefault).toBe(true);
  });
});
