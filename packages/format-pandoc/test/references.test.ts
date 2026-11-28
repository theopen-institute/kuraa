// A Pandoc document's references (0109): images, links and definitions, with
// where each target is written; nothing in code; and written again when files move.
import { describe, expect, it } from 'vitest';
import { movedBy, rewriteReferences } from '@kuraa/kernel';
import { pandocReferences } from '../src/references.js';

const targets = (text: string) => pandocReferences(text).map((r) => [r.kind, r.target, text.slice(r.from, r.to)]);

describe('pandoc references', () => {
  it('finds images, links and definitions, each where its target is written', () => {
    const text = [
      '---',
      'title: "A [trip](not-a-link.md)"',
      '---',
      '',
      'The ![bay [at dawn]](report.md.files/bay.jpg "The bay"){width=50%} and [notes](notes.md#day-2).',
      '',
      '![](<report.md.files/a b.png>) and [nested](a_(b).md) and <https://example.org>.',
      '',
      '[ref]: ../data/table.csv "A table"',
      '',
      'Use [the table][ref].',
    ].join('\n');
    expect(targets(text)).toEqual([
      ['image', 'report.md.files/bay.jpg', 'report.md.files/bay.jpg'],
      ['link', 'notes.md#day-2', 'notes.md#day-2'],
      ['image', 'report.md.files/a b.png', '<report.md.files/a b.png>'],
      ['link', 'a_(b).md', 'a_(b).md'],
      // The autolink names an address, written without `](…)`: not a target to write again.
      ['definition', '../data/table.csv', '../data/table.csv'],
    ]);
  });

  it('counts nothing in code', () => {
    expect(targets('```\n![x](a.png)\n```\n\nAnd `[y](b.md)` too.\n')).toEqual([]);
  });

  it('writes them again when a document and its files move', () => {
    const text = '# Trip\n\n![The bay](report.md.files/bay.jpg){width=50%}\n\nSee [data](../data.csv) and `![code](report.md.files/x.png)`.\n';
    const moved = movedBy([['ch/report.md', 'ch/deep/trip.md'], ['ch/report.md.files', 'ch/deep/trip.md.files']]);
    expect(rewriteReferences(text, pandocReferences(text), 'ch/report.md', 'ch/deep/trip.md', moved)).toBe(
      '# Trip\n\n![The bay](trip.md.files/bay.jpg){width=50%}\n\nSee [data](../../data.csv) and `![code](report.md.files/x.png)`.\n',
    );
  });
});
