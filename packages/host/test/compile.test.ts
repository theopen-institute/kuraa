// A folder compiled (0091): its documents in the file tree's order, those left
// out skipped, joined under the book's title with each title its chapter's heading.
import { describe, expect, it } from 'vitest';
import { documentsInOrder, headingsDown, joinBook, withoutHeader } from '../src/compile.js';

describe('a folder’s documents for a book', () => {
  const entries = [
    { path: 'novel/b.md', title: 'Boats' },
    { path: 'novel/a.md', title: 'Arrival' },
    { path: 'novel/notes.md', title: null },
    { path: 'novel/map.png' },
    { path: 'novel/.kuraa-order' },
    { path: 'novel/.kuraa-compile.yml' },
    { path: 'novel/coast/cliffs.md', title: 'Cliffs' },
    { path: 'novel/coast/beach.Rmd', title: 'Beach' },
    { path: 'novel/research/sources.md', title: 'Sources' },
    { path: 'elsewhere.md', title: 'Elsewhere' },
  ];

  it('are in the tree’s order: by name (folders first, then titles), or as arranged', () => {
    expect(documentsInOrder('novel', entries, new Map(), [])).toEqual(['novel/coast/beach.Rmd', 'novel/coast/cliffs.md', 'novel/research/sources.md', 'novel/a.md', 'novel/b.md', 'novel/notes.md']);
    const orders = new Map([['novel', ['b.md', 'coast', 'a.md']], ['novel/coast', ['cliffs.md']]]);
    expect(documentsInOrder('novel', entries, orders, [])).toEqual(['novel/b.md', 'novel/coast/cliffs.md', 'novel/coast/beach.Rmd', 'novel/a.md', 'novel/research/sources.md', 'novel/notes.md']);
  });

  it('leave out what is left out, a folder with all in it', () => {
    expect(documentsInOrder('novel', entries, new Map(), ['novel/coast', 'novel/notes.md'])).toEqual(['novel/research/sources.md', 'novel/a.md', 'novel/b.md']);
    expect(documentsInOrder('', entries, new Map(), ['novel'])).toEqual(['elsewhere.md']);
  });
});

describe('a book joined', () => {
  it('has its title as its header, each document’s title as a chapter heading and its sections below it', () => {
    const book = joinBook('The "Coast"', [
      { title: 'Arrival', text: '---\ntitle: Arrival\n---\n\nWe came.\n\n# The quay\n\nBoats.\n' },
      { title: 'Cliffs', text: '# Cliffs\n\nHigh.\n' },
      { title: null, text: 'Untitled words.\n' },
    ]);
    expect(book).toBe('---\ntitle: "The \\"Coast\\""\n---\n\n# Arrival\n\nWe came.\n\n## The quay\n\nBoats.\n\n# Cliffs\n\nHigh.\n\nUntitled words.\n');
  });

  it('moves headings down outside code only, and takes a header off', () => {
    expect(headingsDown('# A\n```\n# not a heading\n```\n## B\n###### six stays')).toBe('## A\n```\n# not a heading\n```\n### B\n###### six stays');
    expect(withoutHeader('---\ntitle: X\n---\nBody\n')).toBe('Body\n');
    expect(withoutHeader('No header\n---\n')).toBe('No header\n---\n');
  });
});
