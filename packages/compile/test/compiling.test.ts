// A folder compiled in Compile's host half (0126), through the feature contract
// alone: here a contract of a few files in memory.
import { describe, expect, it } from 'vitest';
import type { FeatureContext } from '@kuraa/feature-kit/host';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { bookContents, compileFolder, optionsOf } from '../src/compiling.js';

function fakeContext(files: Record<string, string>, live: Record<string, string> = {}): FeatureContext {
  return {
    list: async () => Object.keys(files).sort(),
    read: async (p: string) => files[p] ?? null,
    live: async (p: string) => live[p] ?? null,
    typeOf: (p: string) => (/\.md$/.test(p) ? pandocMarkdown : undefined),
    belongsTo: (p: string) => (p.includes('.md.files/') ? p.slice(0, p.indexOf('.md.files/') + 3) : null),
  } as unknown as FeatureContext;
}

const files = {
  'novel/b.md': '---\ntitle: Boats\n---\n\nThe boats.\n',
  'novel/a.md': '---\ntitle: Arrival\n---\n\nWe came.\n',
  'novel/a.md.files/map.md': 'Not a chapter.\n',
  'novel/.kuraa-order': '# order\nb.md\na.md\n',
  'novel/coast/cliffs.md': '---\ntitle: Cliffs\n---\n\nHigh.\n',
  'novel/house.docx': 'not really Word',
  'novel/notes.txt': 'not a document',
};

describe('a folder compiled through the contract (0126)', () => {
  it('joins its documents in the order the tree shows them, as they are now, with the folders they are in', async () => {
    const ctx = fakeContext(files, { 'novel/b.md': '---\ntitle: Boats\n---\n\nThe boats, typed a moment ago.\n' });
    const book = await compileFolder(ctx, 'novel', { title: 'The Coast' }, 'html');
    if (typeof book === 'string') throw new Error(book);
    // As the order file says (b.md, a.md), then what it does not name (the folder coast). What is kept beside a document is not in it.
    const order = ['# Boats', '# Arrival', '# coast', '## Cliffs'].map((h) => book.text.indexOf(h));
    expect(order.every((at, i) => at >= 0 && (i === 0 || at > order[i - 1]!))).toBe(true);
    expect(book.text).toContain('typed a moment ago');
    expect(book.text).not.toContain('Not a chapter');
    expect(book.text).toMatch(/^---\ntitle: "The Coast"\n---/);
    expect(book.folders.sort()).toEqual(['novel', 'novel/coast']);
    expect(book.files).toEqual([]);
  });

  it('leaves out what is asked, puts a Word template beside a Word book, and says why there is nothing', async () => {
    const ctx = fakeContext(files);
    const book = await compileFolder(ctx, 'novel', { exclude: ['novel/coast', 'novel/b.md'], referenceDoc: 'novel/house.docx' }, 'docx');
    if (typeof book === 'string') throw new Error(book);
    expect(book.text).not.toContain('Cliffs');
    expect(book.text).not.toContain('Boats');
    expect(book.files).toEqual([{ name: 'reference.docx', path: 'novel/house.docx' }]);
    expect(await compileFolder(ctx, 'novel', { referenceDoc: 'novel/gone.docx' }, 'docx')).toMatch(/not there/);
    expect(await compileFolder(ctx, 'novel', { exclude: ['novel'] }, 'html')).toMatch(/no documents to compile that are not left out/);
  });

  it('takes the request as it comes: anything else is as if not asked, its title the folder’s name', () => {
    expect(optionsOf('novel', null)).toMatchObject({ title: 'novel', exclude: [], toc: false, numbering: null });
    expect(optionsOf('', { exclude: ['/a/', 3], numbering: 'pages', toc: 'yes' } as never)).toMatchObject({ title: 'Book', exclude: ['a'], numbering: null, toc: false });
  });

  it('gives what a folder’s book could have, each with its words', async () => {
    expect(await bookContents(fakeContext(files), 'novel')).toEqual([
      { kind: 'document', path: 'novel/b.md', title: 'Boats', depth: 1, words: 2 },
      { kind: 'document', path: 'novel/a.md', title: 'Arrival', depth: 1, words: 2 },
      { kind: 'folder', path: 'novel/coast', title: 'coast', depth: 1 },
      { kind: 'document', path: 'novel/coast/cliffs.md', title: 'Cliffs', depth: 2, words: 1 },
    ]);
  });
});
