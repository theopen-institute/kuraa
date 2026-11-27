import { describe, expect, it } from 'vitest';
import { countWords, markdownWords, wordChange } from '../src/index.js';

describe('counting words (0094)', () => {
  it('counts runs of letters and digits, with apostrophes and hyphens inside them', () => {
    expect(countWords('The harbour’s well-kept boats, 12 of them — all blue.')).toBe(9);
    expect(countWords("don't stop-")).toBe(2);
    expect(countWords('Café naïve résumé')).toBe(3);
    expect(countWords('  \n ')).toBe(0);
    // Written without spaces: a word a character.
    expect(countWords('東京へ行く')).toBe(5);
  });

  it('counts a Markdown document’s words as a reader sees them', () => {
    const md = [
      '---',
      'title: Not counted',
      '---',
      '',
      '# The quay',
      '',
      'We came by *sea*, [as planned](https://example.org/plan) [@smith2020; @lee].',
      '',
      '```{r}',
      'x <- not + counted',
      '```',
      '',
      '- One `inline code` two^[A note.] three[^n] ![a map](map.png)',
      '<!-- a comment -->',
      '',
      '[^n]: Its note.',
    ].join('\n');
    // The quay (2); We came by sea as planned (6); One two A note three a map (7); Its note (2).
    expect(markdownWords(md)).toBe(17);
  });

  it('says how words changed: net, and added (a rewrite counts, a move does not)', () => {
    expect(wordChange(null, 'One two three.')).toEqual({ net: 3, added: 3 });
    expect(wordChange('One two three.', null)).toEqual({ net: -3, added: 0 });
    // A word rewritten: as many as before, one written.
    expect(wordChange('The red boat.', 'The blue boat.')).toEqual({ net: 0, added: 1 });
    // A paragraph moved: nothing written.
    expect(wordChange('Alpha beta.\n\nGamma delta.', 'Gamma delta.\n\nAlpha beta.')).toEqual({ net: 0, added: 0 });
    // Case aside; the header and code not prose.
    expect(wordChange('---\ntitle: A\n---\n\nThe sea.', '---\ntitle: B C D\n---\n\nthe sea, the sea.\n\n```\nx\n```')).toEqual({ net: 2, added: 2 });
  });
});
