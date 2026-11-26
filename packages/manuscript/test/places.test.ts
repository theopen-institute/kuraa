import { describe, expect, it } from 'vitest';
import { movesFor, slugOf } from '../src/places.js';

describe('where a manuscript keeps its files, where it manages them (0090)', () => {
  it('puts chapters in its home, a part’s in a folder of its name, appendices in appendices/', () => {
    const m = {
      folder: '',
      home: 'novel/',
      chapters: [
        { chapter: 'drafts/arrival.md' },
        { chapter: 'novel/harbour.md' },
        { part: 'The Coast: North', chapters: ['novel/cliffs.md', 'misc/tides.md'] },
        { part: 'parts/inland.qmd', chapters: ['novel/inland/fields.md'] },
      ],
      appendices: ['sources.md'],
    };
    expect(movesFor(m)).toEqual([
      ['drafts/arrival.md', 'novel/arrival.md'],
      ['novel/cliffs.md', 'novel/the-coast-north/cliffs.md'],
      ['misc/tides.md', 'novel/the-coast-north/tides.md'],
      ['parts/inland.qmd', 'novel/inland/inland.qmd'],
      ['sources.md', 'novel/appendices/sources.md'],
    ]);
  });

  it('leaves where they are two files that would go to the same place, but the first', () => {
    expect(movesFor({ folder: '', home: 'b/', chapters: [{ chapter: 'x/a.md' }, { chapter: 'y/a.md' }], appendices: [] })).toEqual([['x/a.md', 'b/a.md']]);
    expect(movesFor({ folder: 'book/', home: null, chapters: [{ chapter: 'book/a.md' }], appendices: [] })).toEqual([]);
    expect(slugOf('Café — Part 1')).toBe('cafe-part-1');
  });
});
