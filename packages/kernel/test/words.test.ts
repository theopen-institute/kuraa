import { describe, expect, it } from 'vitest';
import { countWords, markdownWords } from '../src/index.js';

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
});
