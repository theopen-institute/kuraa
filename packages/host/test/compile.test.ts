// A folder compiled (0093): its folders and documents in the file tree's order,
// those left out skipped, how deep each is its heading's level; joined under
// the book's title.
import { describe, expect, it } from 'vitest';
import { bookItems, chapters, documentsInOrder, headingsDown, joinBook, separatorBlock, withoutHeader, type BookPart } from '../src/compile.js';

describe('a folder’s book', () => {
  const entries = [
    { path: 'novel/b.md', title: 'Boats', book: true },
    { path: 'novel/a.md', title: 'Arrival', book: true },
    { path: 'novel/notes.md', title: null, book: true },
    { path: 'novel/map.png' },
    { path: 'novel/.kuraa-order' },
    { path: 'novel/.kuraa-compile.yml' },
    { path: 'novel/coast/cliffs.md', title: 'Cliffs', book: true },
    { path: 'novel/coast/beach.Rmd', title: 'Beach', book: true },
    { path: 'novel/research/sources.md', title: 'Sources', book: true },
    { path: 'novel/pictures/map.png' },
    { path: 'elsewhere.md', title: 'Elsewhere', book: true },
  ];

  it('is in the tree’s order: by name (folders first, then titles), or as arranged', () => {
    expect(documentsInOrder('novel', entries, new Map(), [])).toEqual(['novel/coast/beach.Rmd', 'novel/coast/cliffs.md', 'novel/research/sources.md', 'novel/a.md', 'novel/b.md', 'novel/notes.md']);
    const orders = new Map([['novel', ['b.md', 'coast', 'a.md']], ['novel/coast', ['cliffs.md']]]);
    expect(documentsInOrder('novel', entries, orders, [])).toEqual(['novel/b.md', 'novel/coast/cliffs.md', 'novel/coast/beach.Rmd', 'novel/a.md', 'novel/research/sources.md', 'novel/notes.md']);
  });

  it('leaves out what is left out, a folder with all in it', () => {
    expect(documentsInOrder('novel', entries, new Map(), ['novel/coast', 'novel/notes.md'])).toEqual(['novel/research/sources.md', 'novel/a.md', 'novel/b.md']);
    expect(documentsInOrder('', entries, new Map(), ['novel'])).toEqual(['elsewhere.md']);
  });

  it('gives each its level: folders’ headings one deeper each folder down; a folder with no heading adds none; a folder with no documents, nothing', () => {
    const levels = (noHeading: string[] = []) => bookItems('novel', entries, new Map([['novel', ['coast', 'a.md', 'research']]]), ['novel/b.md', 'novel/notes.md'], noHeading).map((i) => `${i.level} ${i.path}`);
    expect(levels()).toEqual(['1 novel/coast', '2 novel/coast/beach.Rmd', '2 novel/coast/cliffs.md', '1 novel/a.md', '1 novel/research', '2 novel/research/sources.md']);
    expect(levels(['novel/coast'])).toEqual(['1 novel/coast/beach.Rmd', '1 novel/coast/cliffs.md', '1 novel/a.md', '1 novel/research', '2 novel/research/sources.md']);
  });
});

describe('a book joined', () => {
  it('has its title as its header, folders’ names and documents’ titles as headings at their levels, and documents’ own headings below them', () => {
    const book = joinBook('The "Coast"', [
      { kind: 'document', level: 1, title: 'Arrival', text: '---\ntitle: Arrival\n---\n\nWe came.\n\n# The quay\n\nBoats.\n' },
      { kind: 'folder', level: 1, name: 'The North' },
      { kind: 'document', level: 2, title: 'Cliffs', text: '# Cliffs\n\nHigh.\n\n## Gulls\n' },
      { kind: 'document', level: 2, title: null, text: 'Untitled words.\n\n# Its own\n' },
    ]);
    expect(book).toBe('---\ntitle: "The \\"Coast\\""\n---\n\n# Arrival\n\nWe came.\n\n## The quay\n\nBoats.\n\n# The North\n\n## Cliffs\n\nHigh.\n\n#### Gulls\n\nUntitled words.\n\n## Its own\n');
  });

  it('keeps headings at ###### at most', () => {
    const deep = joinBook('B', [{ kind: 'folder', level: 7, name: 'Deep' }, { kind: 'document', level: 6, title: 'Six', text: '# Seven\n' }]);
    expect(deep).toContain('###### Deep\n\n###### Six\n\n###### Seven\n');
  });

  it('moves headings down outside code only, and takes a header off', () => {
    expect(headingsDown('# A\n```\n# not a heading\n```\n## B\n###### six stays\n#hashtag')).toBe('## A\n```\n# not a heading\n```\n### B\n###### six stays\n#hashtag');
    expect(headingsDown('# A', 3)).toBe('#### A');
    expect(withoutHeader('---\ntitle: X\n---\nBody\n')).toBe('Body\n');
    expect(withoutHeader('No header\n---\n')).toBe('No header\n---\n');
  });
});

describe('a book’s own settings (0106)', () => {
  const scenes: BookPart[] = [
    { kind: 'folder', level: 1, name: 'Arrival' },
    { kind: 'document', level: 2, title: null, text: 'The boat.\n' },
    { kind: 'document', level: 2, title: null, text: '---\ntitle: Quay\n---\nThe quay.\n' },
    { kind: 'folder', level: 1, name: 'Departure' },
    { kind: 'document', level: 2, title: null, text: 'The tide.\n' },
  ];

  it('gives its title page, table of contents, numbered sections, Word template and cover in its header', () => {
    const book = joinBook({ title: 'The Coast', subtitle: 'A "novel"', author: 'Ada Byron', toc: true, numbering: 'sections', referenceDoc: 'reference.docx', cover: 'cover.png' }, []);
    expect(book).toBe('---\ntitle: "The Coast"\nsubtitle: "A \\"novel\\""\nauthor: "Ada Byron"\ntoc: true\nnumber-sections: true\nreference-doc: "reference.docx"\ncover-image: "cover.png"\n---\n\n\n');
  });

  it('puts the separator between documents with no heading between them: a rule, or the text centred', () => {
    expect(joinBook({ title: 'B', separator: '* * *' }, scenes)).toContain('# Arrival\n\nThe boat.\n\n* * *\n\nThe quay.\n\n# Departure\n\nThe tide.\n');
    expect(joinBook({ title: 'B' }, scenes)).toContain('# Arrival\n\nThe boat.\n\nThe quay.\n\n# Departure');
    expect(separatorBlock('---')).toBe('* * *');
    expect(separatorBlock('#')).toBe('::: {.scene-break custom-style="Scene break" style="text-align: center"}\n\\#\n:::');
    expect(separatorBlock('~ * ~')).toContain('\n\\~ \\* \\~\n');
  });

  it('numbers its top-level headings as chapters, outside code, but those marked unnumbered', () => {
    const book = joinBook({ title: 'B', numbering: 'chapters' }, [
      { kind: 'document', level: 1, title: 'Dedication {-}', text: 'For M.\n' },
      ...scenes,
      { kind: 'document', level: 1, title: 'Notes', text: '```\n# not a heading\n```\n# Its own {#own .unnumbered}\n' },
    ]);
    expect(book).toContain('# Dedication {-}\n\nFor M.\n\n# Chapter 1: Arrival\n');
    expect(book).toContain('# Chapter 2: Departure\n');
    expect(book).toContain('# Chapter 3: Notes\n\n```\n# not a heading\n```\n## Its own {#own .unnumbered}\n');
    expect(chapters('# A\n## B\n# C {.unnumbered}\n#D')).toBe('# Chapter 1: A\n## B\n# C {.unnumbered}\n#D');
  });
});
