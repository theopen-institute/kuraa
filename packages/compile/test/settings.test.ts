import { describe, expect, it } from 'vitest';
import { emptyCompile, afterDelete, afterRename, compileFolder, excludedBy, noHeadingPaths, noTitlesPaths, readCompile, withIncluded, writeCompile, type FolderCompile } from '../src/settings.js';

const folder = (f: string, more: Partial<FolderCompile> = {}): FolderCompile => ({ ...emptyCompile(f), ...more });

describe('Compile’s file in a folder (0093)', () => {
  it('says the book’s title and format, whether its name is a heading, and what in it is left out, by name', () => {
    const c = readCompile('novel', 'title: The Coast\nformat: pdf\nheading: false\nexclude:\n  - notes.md\n  - research\n  - a/b.md\n  - 3\n');
    expect(c).toEqual(folder('novel', { title: 'The Coast', format: 'pdf', heading: false, exclude: ['notes.md', 'research'] }));
    expect(readCompile('novel', writeCompile(c)!)).toEqual(c);
    expect(writeCompile(folder(''))).toBeNull();
    expect(writeCompile(folder('drafts', { heading: false }))).toMatch(/\nheading: false\n$/);
    expect(readCompile('', 'format: odt\n').format).toBeNull();
    expect(readCompile('', 'heading: no\n').heading).toBe(true);
    expect(compileFolder('novel/.kuraa-compile.yml')).toBe('novel');
    expect(compileFolder('.kuraa-compile.yml')).toBe('');
  });

  it('leaves a path out where it, or a folder it is in, is named; and says the folders with no heading', () => {
    const all = [folder('novel', { exclude: ['research'] }), folder('', { exclude: ['loose.md'] }), folder('novel/drafts', { heading: false })];
    expect(excludedBy(all, 'novel/research/sources.md')).toBe('novel/research');
    expect(excludedBy(all, 'loose.md')).toBe('loose.md');
    expect(excludedBy(all, 'novel/a.md')).toBeNull();
    expect(withIncluded(all[0]!, 'research', true).exclude).toEqual([]);
    expect(noHeadingPaths(all)).toEqual(['novel/drafts']);
  });

  it('keeps what is left out left out under its new name, in its new folder, and forgets it when deleted', () => {
    const byFolder = new Map([['novel', folder('novel', { title: 'T', exclude: ['notes.md'] })]]);
    expect(afterRename(byFolder, 'novel/notes.md', 'novel/old.md')).toEqual([folder('novel', { title: 'T', exclude: ['old.md'] })]);
    expect(afterRename(byFolder, 'novel/notes.md', 'notes.md')).toEqual([folder('novel', { title: 'T' }), folder('', { exclude: ['notes.md'] })]);
    expect(afterRename(byFolder, 'novel/a.md', 'novel/b.md')).toEqual([]);
    expect(afterDelete(byFolder, 'novel/notes.md')).toEqual([folder('novel', { title: 'T' })]);
  });
});

describe('a book’s own settings (0106)', () => {
  it('says its title page, table of contents, numbering, separator, Word template and cover; and whether a folder’s documents have titles', () => {
    const c = readCompile('novel', [
      'subtitle: A novel', 'author: Ada Byron', 'toc: true', 'numbering: chapters', 'separator: "#"',
      'reference-doc: templates/manuscript.docx', 'cover-image: art/cover.JPG', 'titles: false', 'format: epub',
    ].join('\n'));
    expect(c).toEqual(folder('novel', {
      subtitle: 'A novel', author: 'Ada Byron', toc: true, numbering: 'chapters', separator: '#',
      referenceDoc: 'templates/manuscript.docx', cover: 'art/cover.JPG', titles: false, format: 'epub',
    }));
    expect(readCompile('novel', writeCompile(c)!)).toEqual(c);
    // What it does not say well is passed over.
    const bad = readCompile('', 'numbering: roman\nreference-doc: notes.md\ncover-image: ../cover.png\ntoc: yes\nsubtitle: 1984\n');
    expect([bad.numbering, bad.referenceDoc, bad.cover, bad.toc, bad.subtitle]).toEqual([null, null, null, false, '1984']);
    expect(noTitlesPaths([c, folder('', { titles: false }), folder('other')])).toEqual(['novel', '']);
  });

  it('follows a template or cover renamed or moved, or the folder it is in; forgets it when deleted', () => {
    const byFolder = new Map([
      ['novel', folder('novel', { referenceDoc: 'templates/manuscript.docx', cover: 'novel/art/cover.png', exclude: ['notes.md'] })],
      ['poems', folder('poems', { referenceDoc: 'templates/manuscript.docx' })],
    ]);
    expect(afterRename(byFolder, 'templates/manuscript.docx', 'templates/book.docx')).toEqual([
      folder('novel', { referenceDoc: 'templates/book.docx', cover: 'novel/art/cover.png', exclude: ['notes.md'] }),
      folder('poems', { referenceDoc: 'templates/book.docx' }),
    ]);
    expect(afterRename(byFolder, 'novel/art', 'novel/pictures')).toEqual([folder('novel', { referenceDoc: 'templates/manuscript.docx', cover: 'novel/pictures/cover.png', exclude: ['notes.md'] })]);
    // Left out, and renamed in the same folder: one change to it.
    expect(afterRename(new Map([['novel', folder('novel', { cover: 'novel/notes.md.png', exclude: ['notes.md'] })]]), 'novel/notes.md', 'novel/old.md')).toEqual([folder('novel', { cover: 'novel/notes.md.png', exclude: ['old.md'] })]);
    expect(afterDelete(byFolder, 'templates')).toEqual([
      folder('novel', { cover: 'novel/art/cover.png', exclude: ['notes.md'] }),
      folder('poems'),
    ]);
    expect(afterDelete(byFolder, 'elsewhere.md')).toEqual([]);
  });
});
