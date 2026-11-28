// References (0107): a document's own files' folder, paths resolved from a
// document and written from one, and references written again when files move.
import { describe, expect, it } from 'vitest';
import { documentOfFiles, filesFolderOf, movedBy, relativeTarget, rewriteReferences, workspacePath, type Reference } from '../src/references.js';

/** References found by a simple pattern, for these tests: `](target)`. */
const refs = (text: string): Reference[] => [...text.matchAll(/\]\((<[^>]*>|[^)\s]+)/g)].map((m) => {
  const from = m.index + 2;
  const raw = m[1]!;
  return { kind: 'image', from, to: from + raw.length, target: raw.startsWith('<') ? raw.slice(1, -1) : raw };
});

describe('references: a document\'s own files', () => {
  it('names the folder beside a document, and knows its document from any path in it', () => {
    expect(filesFolderOf('ch/report.md')).toBe('ch/report.md.files');
    expect(documentOfFiles('ch/report.md.files/bay.jpg')).toBe('ch/report.md');
    expect(documentOfFiles('ch/report.md.files/raw/data.csv')).toBe('ch/report.md');
    expect(documentOfFiles('report.Rmd.files/a.png')).toBe('report.Rmd');
    expect(documentOfFiles('ch/report.md.files')).toBeNull();
    expect(documentOfFiles('ch/my.files/a.png')).toBeNull();
    expect(documentOfFiles('ch/report.md')).toBeNull();
  });
});

describe('references: paths', () => {
  it('resolves what a document writes, and writes a path from a document', () => {
    expect(workspacePath('ch/one.md', 'one.md.files/a.png')).toBe('ch/one.md.files/a.png');
    expect(workspacePath('ch/one.md', '../refs.bib')).toBe('refs.bib');
    expect(workspacePath('ch/one.md', '#intro')).toBeNull();
    expect(workspacePath('ch/one.md', 'https://example.org')).toBeNull();
    expect(relativeTarget('ch/one.md', 'ch/one.md.files/a.png')).toBe('one.md.files/a.png');
    expect(relativeTarget('ch/one.md', 'data/x.csv')).toBe('../data/x.csv');
    expect(relativeTarget('one.md', 'ch/two.md')).toBe('ch/two.md');
    expect(relativeTarget('a/b/one.md', 'a/c/two.md')).toBe('../c/two.md');
  });
});

describe('references: rewritten when files move', () => {
  it('a document renamed: its own files\' folder renamed with it', () => {
    const text = 'See ![bay](report.md.files/bay.jpg) and [data](../data.csv#row-2).';
    const moved = movedBy([['ch/report.md', 'ch/trip.md'], ['ch/report.md.files', 'ch/trip.md.files']]);
    expect(rewriteReferences(text, refs(text), 'ch/report.md', 'ch/trip.md', moved)).toBe('See ![bay](trip.md.files/bay.jpg) and [data](../data.csv#row-2).');
  });

  it('a document moved to another folder: what it names outside written from its new place', () => {
    const text = '![bay](report.md.files/bay.jpg) [data](../data.csv#row-2) [web](https://example.org) [here](#top)';
    const moved = movedBy([['ch/report.md', 'ch/deep/report.md'], ['ch/report.md.files', 'ch/deep/report.md.files']]);
    expect(rewriteReferences(text, refs(text), 'ch/report.md', 'ch/deep/report.md', moved)).toBe('![bay](report.md.files/bay.jpg) [data](../../data.csv#row-2) [web](https://example.org) [here](#top)');
  });

  it('another document naming what moved; nothing to change is null', () => {
    const text = 'Read [the trip](ch/report.md) and ![](ch/report.md.files/bay.jpg).';
    const moved = movedBy([['ch', 'travel']]);
    expect(rewriteReferences(text, refs(text), 'index.md', 'index.md', moved)).toBe('Read [the trip](travel/report.md) and ![](travel/report.md.files/bay.jpg).');
    expect(rewriteReferences('Nothing [here](other.md).', refs('Nothing [here](other.md).'), 'index.md', 'index.md', moved)).toBeNull();
  });

  it('keeps how a target was written: angle brackets, percent-encoding; brackets for a new space', () => {
    const angled = '![a](<my report.md.files/a b.png>)';
    const moved = movedBy([['my report.md.files', 'our report.md.files']]);
    expect(rewriteReferences(angled, refs(angled), 'my report.md', 'my report.md', moved)).toBe('![a](<our report.md.files/a b.png>)');
    const encoded = '![a](my%20report.md.files/a.png)';
    expect(rewriteReferences(encoded, refs(encoded), 'my report.md', 'my report.md', moved)).toBe('![a](our%20report.md.files/a.png)');
    const plain = '![a](x.md.files/a.png)';
    expect(rewriteReferences(plain, refs(plain), 'x.md', 'x.md', movedBy([['x.md.files', 'y z.md.files']]))).toBe('![a](<y z.md.files/a.png>)');
  });
});
