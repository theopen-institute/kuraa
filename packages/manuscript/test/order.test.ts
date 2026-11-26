import { describe, expect, it } from 'vitest';
import { addPart, moveTo, placeOf, type Order } from '../src/order.js';

const order: Order = {
  chapters: [{ chapter: 'index.qmd' }, { chapter: 'a.md' }, { part: 'Coast', chapters: ['b.md', 'c.md'] }, { chapter: 'd.md' }],
  appendices: ['e.md'],
};

describe('reordering a manuscript (0088)', () => {
  it('moves a chapter among the chapters, before the place it is dropped on', () => {
    expect(moveTo(order, { chapter: 'd.md' }, { list: 'top' }, 1).chapters.map((e) => ('chapter' in e ? e.chapter : e.part))).toEqual(['index.qmd', 'd.md', 'a.md', 'Coast']);
    // Downwards: the place counts with it still there, as the list showed it.
    expect(moveTo(order, { chapter: 'a.md' }, { list: 'top' }, 4).chapters.map((e) => ('chapter' in e ? e.chapter : e.part))).toEqual(['index.qmd', 'Coast', 'd.md', 'a.md']);
  });

  it('moves a chapter into a part, out of one, into the appendices, and out of the manuscript', () => {
    const into = moveTo(order, { chapter: 'a.md' }, { list: 'part', part: 2 }, 1);
    expect(into.chapters).toEqual([{ chapter: 'index.qmd' }, { part: 'Coast', chapters: ['b.md', 'a.md', 'c.md'] }, { chapter: 'd.md' }]);
    const outOf = moveTo(order, { chapter: 'c.md' }, { list: 'top' }, 0);
    expect(outOf.chapters[0]).toEqual({ chapter: 'c.md' });
    expect(outOf.chapters[3]).toEqual({ part: 'Coast', chapters: ['b.md'] });
    expect(moveTo(order, { chapter: 'a.md' }, { list: 'appendices' }, 0).appendices).toEqual(['a.md', 'e.md']);
    const gone = moveTo(order, { chapter: 'b.md' }, { list: 'out' }, 0);
    expect(placeOf(gone, 'b.md')).toBeNull();
    // A document not yet in it, added.
    expect(placeOf(moveTo(order, { chapter: 'new.md' }, { list: 'top' }, 99), 'new.md')).toEqual({ place: { list: 'top' }, index: 4 });
  });

  it('moves a part among the chapters, and only there', () => {
    expect(moveTo(order, { partAt: 2 }, { list: 'top' }, 0).chapters[0]).toEqual({ part: 'Coast', chapters: ['b.md', 'c.md'] });
    expect(moveTo(order, { partAt: 2 }, { list: 'appendices' }, 0)).toBe(order);
    expect(addPart(order, 'Inland').chapters.at(-1)).toEqual({ part: 'Inland', chapters: [] });
  });
});
