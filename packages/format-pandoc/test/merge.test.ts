// Merging documents by blocks and words; conflicts kept as conflict blocks.
import { describe, expect, it } from 'vitest';
import { diff3, mergeLines, type MergeSide } from '@kuraa/kernel';
import { countConflicts, pandocMarkdown } from '../src/index.js';

const sides: [MergeSide, MergeSide] = [{ by: 'Ada', commit: '3f2c1e0aaaa' }, { by: 'Bo', commit: '9a41d7bbbbb' }];
const merge = (o: string, a: string, b: string) => pandocMarkdown.merge!(o, a, b, sides);
const doc = (...paras: string[]) => `${paras.join('\n\n')}\n`;

describe('diff3', () => {
  it('takes changes from either side and reports overlapping ones', () => {
    expect(diff3([1, 2, 3], [1, 9, 3], [1, 2, 3, 4])).toEqual([{ ok: [1, 9, 3, 4] }]);
    expect(diff3([1, 2, 3], [1, 8, 3], [1, 9, 3])).toEqual([{ ok: [1] }, { conflict: { base: [2], a: [8], b: [9] } }, { ok: [3] }]);
    expect(diff3([1, 2], [1, 7, 2], [1, 7, 2])).toEqual([{ ok: [1, 7, 2] }]);
  });

  it('merges lines as git does, with markers for conflicts', () => {
    expect(mergeLines('a\nb\nc\n', 'A\nb\nc\n', 'a\nb\nC\n', sides)).toEqual({ text: 'A\nb\nC\n', conflicts: 0 });
    expect(mergeLines('a\n', 'x\n', 'y\n', sides)).toEqual({ text: '<<<<<<< Ada (3f2c1e0)\nx\n=======\ny\n>>>>>>> Bo (9a41d7b)\n', conflicts: 1 });
  });

  it('merges long files quickly, changed far apart on both sides', () => {
    // Too long for the table of common subsequences (it would need gigabytes), and
    // long unchanged runs once overflowed the stack.
    const lines = Array.from({ length: 300_000 }, (_, i) => `${i},value ${i}\n`);
    const a = ['first\n', ...lines.slice(1, -1), 'last\n'].join('');
    const b = [...lines.slice(0, 150_000), 'middle\n', ...lines.slice(150_000)].join('');
    const merged = mergeLines(lines.join(''), a, b, sides);
    expect(merged.conflicts).toBe(0);
    expect(merged.text).toBe(['first\n', ...lines.slice(1, 150_000), 'middle\n', ...lines.slice(150_000, -1), 'last\n'].join(''));
  });
});

describe('merging documents', () => {
  const base = doc('# Notes', 'One.', 'Two.', 'Three.', 'Four.');

  it('merges changes to different paragraphs, and to different words of one', () => {
    expect(merge(base, doc('# Notes', 'One!', 'Two.', 'Three.', 'Four.'), doc('# Notes', 'One.', 'Two.', 'Three.', 'Four!'))).toEqual({
      text: doc('# Notes', 'One!', 'Two.', 'Three.', 'Four!'), conflicts: 0,
    });
    const p = 'The samples were collected in spring. They were dried.';
    expect(merge(doc(p), doc(p.replace('spring', 'early spring')), doc(p.replace('dried', 'frozen'))).text)
      .toBe(doc('The samples were collected in early spring. They were frozen.'));
  });

  it('keeps both versions in a conflict block when the same words changed differently', () => {
    const r = merge(base, doc('# Notes', 'One.', 'Two, said Ada.', 'Three.', 'Four.'), doc('# Notes', 'One.', 'Two, said Bo.', 'Three.', 'Four!'));
    expect(r.conflicts).toBe(1);
    expect(r.text).toBe(doc(
      '# Notes', 'One.',
      ':::: {.conflict}\n::: {.version by="Ada" commit="3f2c1e0"}\nTwo, said Ada.\n:::\n\n::: {.version by="Bo" commit="9a41d7b"}\nTwo, said Bo.\n:::\n::::',
      'Three.', 'Four!',
    ));
    // The conflict block is a document Pandoc and the editor read: a div of two divs.
    const parsed = pandocMarkdown.parse(r.text);
    const block = parsed.doc.child(2);
    expect(block.type.name).toBe('fenced_div');
    expect(block.childCount).toBe(2);
    expect(block.child(1).textContent).toBe('Two, said Bo.');
    expect(countConflicts(r.text)).toBe(1);
  });

  it('keeps a block one side changed and the other deleted', () => {
    expect(merge(base, doc('# Notes', 'One.', 'Three.', 'Four.'), doc('# Notes', 'One.', 'Two, changed.', 'Three.', 'Four.')).text)
      .toBe(doc('# Notes', 'One.', 'Two, changed.', 'Three.', 'Four.'));
  });

  it('merges the header line by line, keeping a clash as a comment', () => {
    const h = (title: string, extra = '') => `---\ntitle: ${title}\nlang: en\n${extra}---\n\nText.\n`;
    expect(merge(h('A'), h('A', 'date: 2026\n'), h('B')).text).toBe(h('B', 'date: 2026\n'));
    const r = merge(h('A'), h('Ada’s'), h('Bo’s'));
    expect(r.text).toBe('---\ntitle: Ada’s\n# Bo wrote: title: Bo’s\nlang: en\n---\n\nText.\n');
    expect(r.conflicts).toBe(1);
  });

  it('gives the same result for the same arguments, and the sides’ order only orders a conflict', () => {
    const a = doc('X.');
    const b = doc('Y.');
    expect(merge(doc('W.'), a, b)).toEqual(merge(doc('W.'), a, b));
    expect(pandocMarkdown.merge!(doc('W.'), b, a, [sides[1], sides[0]]).text).toContain('by="Bo"');
  });
});
