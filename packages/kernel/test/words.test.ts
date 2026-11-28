import { describe, expect, it } from 'vitest';
import { countWords, proseWords, wordChange } from '../src/index.js';

describe('counting words (0094)', () => {
  it('counts runs of letters and digits, with apostrophes and hyphens inside them', () => {
    expect(countWords('The harbour’s well-kept boats, 12 of them — all blue.')).toBe(9);
    expect(countWords("don't stop-")).toBe(2);
    expect(countWords('Café naïve résumé')).toBe(3);
    expect(countWords('  \n ')).toBe(0);
    // Written without spaces: a word a character.
    expect(countWords('東京へ行く')).toBe(5);
  });

  it('counts a document’s words as its type reads them, and none for a type without prose (0123)', () => {
    const shouting = { prose: (text: string) => text.replace(/[A-Z]+/g, ' ') };
    expect(proseWords(shouting, 'one TWO three')).toBe(2);
    expect(proseWords({}, 'one two three')).toBeNull();
    expect(proseWords(undefined, 'one two three')).toBeNull();
  });

  it('says how words changed: net, and added (a rewrite counts, a move does not)', () => {
    expect(wordChange(null, 'One two three.')).toEqual({ net: 3, added: 3 });
    expect(wordChange('One two three.', null)).toEqual({ net: -3, added: 0 });
    // A word rewritten: as many as before, one written.
    expect(wordChange('The red boat.', 'The blue boat.')).toEqual({ net: 0, added: 1 });
    // A paragraph moved: nothing written.
    expect(wordChange('Alpha beta.\n\nGamma delta.', 'Gamma delta.\n\nAlpha beta.')).toEqual({ net: 0, added: 0 });
    // Case aside.
    expect(wordChange('The sea.', 'the sea, the sea.')).toEqual({ net: 2, added: 2 });
  });
});
