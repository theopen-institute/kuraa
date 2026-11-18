import { describe, expect, it } from 'vitest';
import { pathForTitle, slugify } from '../src/filenames.js';

describe('filenames from titles', () => {
  it('lowercases, drops accents and punctuation, and joins words with hyphens', () => {
    expect(slugify('Tidal energy: a study')).toBe('tidal-energy-a-study');
    expect(slugify('  Café São Paulo — Ünïcödé  ')).toBe('cafe-sao-paulo-unicode');
    expect(slugify('Straße & Ærø')).toBe('strasse-and-aero');
    expect(slugify("Don't panic!")).toBe('dont-panic');
    expect(slugify('R_markdown/notes v2.1')).toBe('r-markdown-notes-v2-1');
    expect(slugify('.hidden -option')).toBe('hidden-option');
  });

  it('keeps names short, cutting at a word', () => {
    const long = slugify('A remarkably long title about measuring tidal flows in several small harbours over a year');
    expect(long.length).toBeLessThanOrEqual(60);
    expect(long).toBe('a-remarkably-long-title-about-measuring-tidal-flows-in');
    expect(slugify('x'.repeat(80))).toHaveLength(60);
  });

  it('never makes a name Windows reserves, or an empty one', () => {
    expect(slugify('CON')).toBe('con-doc');
    expect(slugify('Com1')).toBe('com1-doc');
    expect(slugify('東京の潮')).toBe('untitled');
    expect(slugify('!!!')).toBe('untitled');
  });

  it('numbers a name already used in the folder, whatever its extension or case', () => {
    const taken = ['notes/field-notes.md', 'notes/Field-Notes-2.Rmd', 'field-notes-3.md'];
    expect(pathForTitle('Field notes', '.md', 'notes/', taken)).toBe('notes/field-notes-3.md');
    expect(pathForTitle('Field notes', '.md', '', taken)).toBe('field-notes.md');
    // Renaming a file to its own name is no clash.
    expect(pathForTitle('Field notes', '.md', 'notes/', taken, 'notes/field-notes.md')).toBe('notes/field-notes.md');
  });
});
