import { describe, expect, it } from 'vitest';
import { searchFeature } from '../src/index.js';
import { S } from '../src/strings.js';
import { badQuery, MAX_PER_FILE, searchText } from '../src/search.js';

describe('search, as a component (0089)', () => {
  it('says its counts with the plural rules', () => {
    expect(S.summary(1, 1, false)).toBe('1 match in 1 file.');
    expect(S.summary(3, 2, true)).toBe('3 matches in 2 files (only the first are shown).');
  });

  it('is on by default', () => {
    expect(searchFeature.onByDefault).toBe(true);
  });
});

describe('matches in a text (0120)', () => {
  it('finds each match on each line, and says where there were more than it lists', () => {
    expect(searchText('a tide\nno\nTide, tide', 'tide', false)).toEqual({
      matches: [
        { line: 1, at: 2, column: 2, text: 'a tide' },
        { line: 3, at: 0, column: 0, text: 'Tide, tide' },
        { line: 3, at: 6, column: 6, text: 'Tide, tide' },
      ],
      more: false,
    });
    expect(searchText('Tide, tide', 'Tide', true).matches).toHaveLength(1);
    const many = searchText('x\n'.repeat(MAX_PER_FILE + 5), 'x', false);
    expect(many.matches).toHaveLength(MAX_PER_FILE);
    expect(many.more).toBe(true);
    expect(searchText('x\n'.repeat(MAX_PER_FILE), 'x', false).more).toBe(false);
  });

  it('refuses an empty phrase, a long one, or one of more than a line', () => {
    expect(badQuery('tide')).toBeNull();
    expect(badQuery('  ')).not.toBeNull();
    expect(badQuery('x'.repeat(501))).not.toBeNull();
    expect(badQuery('a\nb')).not.toBeNull();
  });
});
