import { describe, expect, it } from 'vitest';
import { afterDelete, afterRename, compileFolder, excludedBy, noHeadingPaths, readCompile, withIncluded, writeCompile, type FolderCompile } from '../src/settings.js';

const folder = (f: string, more: Partial<FolderCompile> = {}): FolderCompile => ({ folder: f, title: null, format: null, heading: true, exclude: [], ...more });

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
