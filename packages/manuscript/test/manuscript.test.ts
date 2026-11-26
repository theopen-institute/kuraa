import { describe, expect, it } from 'vitest';
import { afterDelete, afterRename, excludedBy, manuscriptFolder, readManuscript, titleOf, withIncluded, writeManuscript } from '../src/manuscript.js';

describe('a manuscript’s file (0091)', () => {
  it('says its title and what it leaves out, named from its folder', () => {
    const m = readManuscript('novel/', 'title: The Coast\nexclude:\n  - notes.md\n  - research/\n  - 3\n');
    expect(m).toEqual({ folder: 'novel/', title: 'The Coast', exclude: ['novel/notes.md', 'novel/research'] });
    expect(readManuscript('novel/', writeManuscript(m))).toEqual(m);
    expect(writeManuscript({ folder: '', title: null, exclude: [] })).toMatch(/^# This folder is a manuscript/);
    expect(readManuscript('', 'not: [yaml')).toEqual({ folder: '', title: null, exclude: [] });
    expect(titleOf({ folder: 'drafts/novel/', title: null })).toBe('novel');
    expect(manuscriptFolder('novel/.kuraa-manuscript.yml')).toBe('novel/');
    expect(manuscriptFolder('.kuraa-manuscript.yml')).toBe('');
  });

  it('leaves out a document, or a folder with all in it, and puts it back', () => {
    const m = withIncluded(withIncluded({ folder: 'novel/', title: null, exclude: [] }, 'novel/notes.md', false), 'novel/research', false);
    expect(excludedBy(m, 'novel/notes.md')).toBe('novel/notes.md');
    expect(excludedBy(m, 'novel/research/sources.md')).toBe('novel/research');
    expect(excludedBy(m, 'novel/arrival.md')).toBeNull();
    expect(withIncluded(m, 'novel/notes.md', true).exclude).toEqual(['novel/research']);
  });

  it('follows what it leaves out when it is renamed, moved out, or deleted', () => {
    const m = { folder: 'novel/', title: null, exclude: ['novel/notes.md', 'novel/research'] };
    expect(afterRename(m, 'novel/notes.md', 'novel/old-notes.md')?.exclude).toEqual(['novel/old-notes.md', 'novel/research']);
    expect(afterRename(m, 'novel/research', 'novel/sources')?.exclude).toEqual(['novel/notes.md', 'novel/sources']);
    expect(afterRename(m, 'novel/notes.md', 'elsewhere/notes.md')?.exclude).toEqual(['novel/research']);
    expect(afterRename(m, 'novel/a.md', 'novel/b.md')).toBeNull();
    expect(afterDelete(m, 'novel/research')?.exclude).toEqual(['novel/notes.md']);
    expect(afterDelete(m, 'novel/a.md')).toBeNull();
  });
});
