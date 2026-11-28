// What a reader reads of a Markdown document (0094, 0123): the type's prose,
// whose words the app counts.
import { describe, expect, it } from 'vitest';
import { proseWords, wordChange } from '@kuraa/kernel';
import { markdownProse, markdownWords, pandocMarkdown } from '../src/index.js';

describe('a Markdown document’s prose', () => {
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

  it('counts its words as a reader sees them', () => {
    // The quay (2); We came by sea as planned (6); One two A note three a map (7); Its note (2).
    expect(markdownWords(md)).toBe(17);
    expect(proseWords(pandocMarkdown, md)).toBe(17);
  });

  it('is what the type says a reader reads, so changes leave out the header and code', () => {
    expect(pandocMarkdown.prose).toBe(markdownProse);
    const before = '---\ntitle: A\n---\n\nThe sea.';
    const after = '---\ntitle: B C D\n---\n\nthe sea, the sea.\n\n```\nx\n```';
    expect(wordChange(markdownProse(before), markdownProse(after))).toEqual({ net: 2, added: 2 });
  });

  it('is a type with header fields, whose text is Markdown a book is made of', () => {
    expect(pandocMarkdown.header).toBeDefined();
    expect(pandocMarkdown.markdown).toBe(true);
  });
});
