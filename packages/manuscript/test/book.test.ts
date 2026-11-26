import { describe, expect, it } from 'vitest';
import { deleted, hasChapters, isBook, mapPaths, newBook, newProfileBook, pathsOf, profileName, profilesOf, readBook, relative, renamed, resolve, withProfiles, writeBook } from '../src/book.js';

const BOOK = `# The book's settings: Quarto's, and the writer's.
project:
  type: book
  output-dir: _book   # rendered here

book:
  title: "Tidal notes"
  author: Ana
  chapters:
    - index.qmd
    - part: "The coast"
      chapters:
        - chapters/arrival.md
        - chapters/the-harbour.Rmd
    - part: parts/inland.qmd
      chapters:
        - chapters/fields.md
  appendices:
    - appendices/sources.md

format:
  pdf: default
`;

describe('a manuscript is a Quarto book (0088)', () => {
  it('reads the order, its paths the workspace’s', () => {
    expect(isBook(BOOK)).toBe(true);
    expect(isBook('project:\n  type: website\n')).toBe(false);
    expect(isBook(': not yaml :')).toBe(false);
    const m = readBook('novel/_quarto.yml', BOOK)!;
    expect(m.folder).toBe('novel/');
    expect(m.title).toBe('Tidal notes');
    expect(m.chapters).toEqual([
      { chapter: 'novel/index.qmd' },
      { part: 'The coast', chapters: ['novel/chapters/arrival.md', 'novel/chapters/the-harbour.Rmd'] },
      { part: 'novel/parts/inland.qmd', chapters: ['novel/chapters/fields.md'] },
    ]);
    expect(m.appendices).toEqual(['novel/appendices/sources.md']);
    expect(pathsOf(m)).toEqual(['novel/index.qmd', 'novel/chapters/arrival.md', 'novel/chapters/the-harbour.Rmd', 'novel/parts/inland.qmd', 'novel/chapters/fields.md', 'novel/appendices/sources.md']);
    expect(readBook('_quarto.yml', 'project:\n  type: website\n')).toBeNull();
  });

  it('writes only the two lists, keeping everything else as it was, comments included', () => {
    const m = readBook('novel/_quarto.yml', BOOK)!;
    const reordered = { ...m, chapters: [m.chapters[0]!, m.chapters[2]!, m.chapters[1]!], appendices: [] };
    const out = writeBook(BOOK, reordered);
    expect(out).toContain("# The book's settings: Quarto's, and the writer's.");
    expect(out).toContain('output-dir: _book # rendered here');
    expect(out).toContain('author: Ana');
    expect(out).toContain('format:\n  pdf: default');
    expect(out).not.toContain('appendices');
    expect(readBook('novel/_quarto.yml', out)!.chapters).toEqual(reordered.chapters);
    // Written again unchanged, it is the same.
    expect(writeBook(out, reordered)).toBe(out);
  });

  it('makes a new book of a folder’s documents', () => {
    const yaml = newBook('book/', 'A book', ['book/index.qmd', 'book/one.md']);
    expect(yaml).toBe('project:\n  type: book\n\nbook:\n  title: "A book"\n  chapters:\n    - index.qmd\n    - one.md\n');
    expect(readBook('book/_quarto.yml', yaml)!.chapters).toEqual([{ chapter: 'book/index.qmd' }, { chapter: 'book/one.md' }]);
  });

  it('follows renames and deletions', () => {
    const m = readBook('novel/_quarto.yml', BOOK)!;
    const moved = mapPaths(m, renamed('novel/chapters', 'novel/text', true));
    expect(pathsOf(moved)).toContain('novel/text/arrival.md');
    expect(pathsOf(moved)).not.toContain('novel/chapters/arrival.md');
    const gone = mapPaths(m, deleted('novel/parts/inland.qmd', false));
    expect(gone.chapters[2]).toEqual({ part: 'inland', chapters: ['novel/chapters/fields.md'] });
    const fewer = mapPaths(m, deleted('novel/chapters/arrival.md', false));
    expect(fewer.chapters[1]).toEqual({ part: 'The coast', chapters: ['novel/chapters/the-harbour.Rmd'] });
  });

  it('resolves paths relative to the file’s folder, and back', () => {
    expect(resolve('novel/', 'chapters/a.md')).toBe('novel/chapters/a.md');
    expect(resolve('novel/', './a.md')).toBe('novel/a.md');
    expect(resolve('novel/part/', '../a.md')).toBe('novel/a.md');
    expect(resolve('', 'a.md')).toBe('a.md');
    expect(relative('novel/', 'novel/chapters/a.md')).toBe('chapters/a.md');
    expect(relative('novel/', 'other/a.md')).toBe('../other/a.md');
    expect(relative('', 'a.md')).toBe('a.md');
  });

  it('keeps manuscripts apart from folders as profiles’ books beside one project (0090)', () => {
    const base = withProfiles(null, ['novel']);
    expect(base).toBe('project:\n  type: book\nprofile:\n  group:\n    - [ novel ]\n');
    expect(isBook(base)).toBe(true);
    expect(hasChapters(base)).toBe(false);
    const both = withProfiles(base, ['novel', 'thesis']);
    expect(profilesOf(both)).toEqual(['novel', 'thesis']);
    expect(profilesOf(withProfiles(both, ['thesis'], ['novel', 'thesis']))).toEqual(['thesis']);
    expect(withProfiles(both, [], ['novel', 'thesis'])).not.toContain('group');
    // A book of its own, kept: profiles beside it are not wanted.
    expect(hasChapters(BOOK)).toBe(true);

    const yaml = newProfileBook('', 'A thesis', ['field/notes.md', 'novel/a.md']);
    expect(yaml).toBe('book:\n  title: "A thesis"\n  chapters:\n    - field/notes.md\n    - novel/a.md\n');
    const m = readBook('_quarto-thesis.yml', yaml, both)!;
    expect(m).toMatchObject({ file: '_quarto-thesis.yml', folder: '', profile: 'thesis', title: 'A thesis' });
    expect(pathsOf(m)).toEqual(['field/notes.md', 'novel/a.md']);
    // The title the base gives, where the profile gives none; else the profile's name.
    expect(readBook('_quarto-x.yml', 'book:\n  chapters: []\n', 'project:\n  type: book\nbook:\n  title: Shared\n')!.title).toBe('Shared');
    expect(readBook('_quarto-x.yml', 'book:\n  chapters: []\n', base)!.title).toBe('x');
    expect(readBook('_quarto-x.yml', 'format: html\n', base)).toBeNull();

    expect(profileName('Tidal Notes: Café', [])).toBe('tidal-notes-cafe');
    expect(profileName('Novel', ['novel', 'novel-2'])).toBe('novel-3');
    expect(profileName('???', [])).toBe('manuscript');
  });
});
