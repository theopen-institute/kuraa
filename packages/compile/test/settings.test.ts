import { describe, expect, it } from 'vitest';
import { afterDelete, afterRename, compileFolder, excludedBy, readCompile, withIncluded, writeCompile, type FolderCompile } from '../src/settings.js';

describe('Compile’s file in a folder (0091)', () => {
  it('says the book’s title and format, and what in the folder is left out, by name', () => {
    const c = readCompile('novel', 'title: The Coast\nformat: pdf\nexclude:\n  - notes.md\n  - research\n  - a/b.md\n  - 3\n');
    expect(c).toEqual({ folder: 'novel', title: 'The Coast', format: 'pdf', exclude: ['notes.md', 'research'] });
    expect(readCompile('novel', writeCompile(c)!)).toEqual(c);
    expect(writeCompile({ folder: '', title: null, format: null, exclude: [] })).toBeNull();
    expect(readCompile('', 'format: odt\n').format).toBeNull();
    expect(compileFolder('novel/.kuraa-compile.yml')).toBe('novel');
    expect(compileFolder('.kuraa-compile.yml')).toBe('');
  });

  it('leaves a path out where it, or a folder it is in, is named', () => {
    const all: FolderCompile[] = [{ folder: 'novel', title: null, format: null, exclude: ['research'] }, { folder: '', title: null, format: null, exclude: ['loose.md'] }];
    expect(excludedBy(all, 'novel/research/sources.md')).toBe('novel/research');
    expect(excludedBy(all, 'loose.md')).toBe('loose.md');
    expect(excludedBy(all, 'novel/a.md')).toBeNull();
    expect(withIncluded(all[0]!, 'research', true).exclude).toEqual([]);
  });

  it('keeps what is left out left out under its new name, in its new folder, and forgets it when deleted', () => {
    const byFolder = new Map([['novel', { folder: 'novel', title: 'T', format: null, exclude: ['notes.md'] } as FolderCompile]]);
    expect(afterRename(byFolder, 'novel/notes.md', 'novel/old.md')).toEqual([{ folder: 'novel', title: 'T', format: null, exclude: ['old.md'] }]);
    expect(afterRename(byFolder, 'novel/notes.md', 'notes.md')).toEqual([
      { folder: 'novel', title: 'T', format: null, exclude: [] },
      { folder: '', title: null, format: null, exclude: ['notes.md'] },
    ]);
    expect(afterRename(byFolder, 'novel/a.md', 'novel/b.md')).toEqual([]);
    expect(afterDelete(byFolder, 'novel/notes.md')).toEqual([{ folder: 'novel', title: 'T', format: null, exclude: [] }]);
  });
});
