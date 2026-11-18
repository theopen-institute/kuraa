// File icons come from the type: each kind of text file has its own.
import { describe, expect, it } from 'vitest';
import { textFile, textIcons } from '../src/index.js';
import { pandocMarkdown } from '@kuraa/format-pandoc';

describe('file icons', () => {
  it('match what a text file holds', () => {
    const icon = (path: string) => textFile.icon!(path);
    expect(icon('analysis/clean.R')).toBe(textIcons.code);
    expect(icon('run.sh')).toBe(textIcons.shell);
    expect(icon('data/flows.csv')).toBe(textIcons.data);
    expect(icon('_quarto.yml')).toBe(textIcons.settings);
    expect(icon('.gitignore')).toBe(textIcons.settings);
    expect(icon('refs.bib')).toBe(textIcons.references);
    expect(icon('apa.csl')).toBe(textIcons.references);
    expect(icon('preamble.tex')).toBe(textIcons.latex);
    expect(icon('notes.txt')).toBe(textIcons.text);
    // A file the type opens by its first line alone gets the type's own.
    expect(icon('rebuild')).toBe(textIcons.text);
  });

  it('are strokes in a 16×16 box', () => {
    for (const i of [...Object.values(textIcons), pandocMarkdown.icon!('a.md')!]) {
      expect(i.paths.length).toBeGreaterThan(0);
      for (const d of i.paths) expect(d).toMatch(/^M[\d\s.,MmLlHhVvCcSsQqTtAaZz-]+$/);
    }
  });
});
