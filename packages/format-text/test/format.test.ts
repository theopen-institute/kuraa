// The text format: exact round trips for any input, edits confined to the lines
// they touch, and file matching.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Transform } from 'prosemirror-transform';
import { TypeRegistry } from '@kuraa/kernel';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { rmarkdown } from '@kuraa/format-rmarkdown';
import { parseText, serializeText, textFile, textSchema, textTypes } from '../src/index.js';
import { rng } from '../../../tests/format-helpers.js';

const DIR = join(import.meta.dirname, '../../../fixtures/text');
const files = readdirSync(DIR).map((name) => ({ name, text: readFileSync(join(DIR, name), 'utf8') }));

const registry = new TypeRegistry();
for (const t of [pandocMarkdown, rmarkdown, ...textTypes]) registry.register(t);

describe('text: format tests', () => {
  it('has a corpus, and every corpus file has a text type', () => {
    expect(files.length).toBeGreaterThan(10);
    for (const f of files) expect(registry.resolve(f.name)?.id, f.name).toBe('text');
  });

  describe('identity', () => {
    for (const f of files) {
      it(f.name, () => {
        const parsed = parseText(f.text);
        expect(serializeText(parsed.doc)).toBe(f.text);
        // One block per line, covering the text exactly.
        expect(parsed.blocks.length).toBe(parsed.doc.childCount);
        expect(parsed.blocks.map((b) => f.text.slice(b.from, b.to)).join('')).toBe(f.text);
      });
    }
  });

  describe('locality', () => {
    for (const f of files) {
      it(f.name, () => {
        const parsed = parseText(f.text);
        const r = rng(f.text.length + 1);
        for (let i = 0; i < 8; i++) {
          const index = r.int(parsed.doc.childCount);
          let pos = 0;
          for (let j = 0; j < index; j++) pos += parsed.doc.child(j).nodeSize;
          const tr = new Transform(parsed.doc).insert(pos + 1, textSchema.text('EDITED '));
          const out = serializeText(tr.doc);
          const range = parsed.blocks[index]!;
          expect(out.slice(0, range.from)).toBe(f.text.slice(0, range.from));
          expect(out.slice(range.from + 'EDITED '.length)).toBe(f.text.slice(range.from));
        }
      });
    }
  });

  describe('line endings', () => {
    it('keeps each line its own terminator, and the last line has none', () => {
      const text = 'a\nb\r\nc\rd';
      const { doc } = parseText(text);
      expect(doc.childCount).toBe(4);
      expect([0, 1, 2, 3].map((i) => doc.child(i).attrs.eol)).toEqual(['\n', '\r\n', '\r', '']);
    });

    it('a file ending in a newline has an empty last line', () => {
      const { doc } = parseText('x\n');
      expect(doc.childCount).toBe(2);
      expect(doc.lastChild!.textContent).toBe('');
    });

    it('a line split by an editor (no terminator yet) gets the usual one', () => {
      const { doc } = parseText('one\r\ntwo\r\nthree');
      // Split "three" in the middle, as Enter does: the first half keeps attrs of the last line (no terminator).
      const at = doc.content.size - 1 - "ree".length;
      const tr = new Transform(doc).split(at, 1, [{ type: textSchema.nodes.line!, attrs: { eol: '' } }]);
      expect(serializeText(tr.doc)).toBe('one\r\ntwo\r\nth\r\nree');
    });

    it('joining the last two lines drops the final terminator', () => {
      const { doc } = parseText('a\nb');
      const tr = new Transform(doc).join(doc.child(0).nodeSize);
      expect(serializeText(tr.doc)).toBe('ab');
    });
  });

  describe('totality', () => {
    it('round-trips any string exactly', () => {
      const r = rng(77);
      const alphabet = ['a', ' ', '\t', '\n', '\r', '\r\n', '\u0000', '﻿', 'é', '🌊', '\\', '{', '}', '"', '#'];
      const samples = ['', '\n', '\r', '\r\n', '\n\n', '\r\r\n\n'];
      for (let i = 0; i < 500; i++) samples.push(Array.from({ length: r.int(40) }, () => r.pick(alphabet)).join(''));
      for (const f of files) samples.push(f.text.slice(r.int(f.text.length + 1)));
      for (const s of samples) expect(serializeText(parseText(s).doc)).toBe(s);
    });
  });
});

describe('text: matching', () => {
  const id = (path: string, head = '') => registry.resolve(path, head)?.id ?? null;
  const layout = textFile.editor!.layout!;
  const language = (path: string, head = '') => layout.languageOf!(path, head) ?? null;

  it('is one type for all text files, below the markdown types', () => {
    expect(textTypes.map((t) => t.id)).toEqual(['text']);
    for (const p of ['analysis/clean.R', 'clean.r', '.Rprofile', 'refs/library.bib', '_quarto.yml', 'CITATION.cff', 'Dockerfile', 'Makefile', 'notes.txt', 'data.csv'])
      expect(id(p), p).toBe('text');
    expect(id('notes.md')).toBe('pandoc-markdown');
    expect(id('analysis.Rmd')).toBe('rmarkdown');
    expect(id('photo.png')).toBe(null);
  });

  it('highlights each file by its name', () => {
    expect(language('analysis/clean.R')).toBe('r');
    expect(language('clean.r')).toBe('r');
    expect(language('.Rprofile')).toBe('r');
    expect(language('refs/library.bib')).toBe('bibtex');
    expect(language('_quarto.yml')).toBe('yaml');
    expect(language('CITATION.cff')).toBe('yaml');
    expect(language('Dockerfile')).toBe('dockerfile');
    expect(language('notes.txt')).toBe(null);
    expect(language('Makefile')).toBe(null);
  });

  it('reads the first line of extensionless files', () => {
    expect(id('bin/rebuild', '#!/usr/bin/env Rscript\nlibrary(x)\n')).toBe('text');
    expect(language('bin/rebuild', '#!/usr/bin/env Rscript')).toBe('r');
    expect(language('bin/check', '#!/bin/bash')).toBe('shell');
    expect(language('bin/qc', '#!/usr/bin/env python3')).toBe('python');
    expect(id('bin/blob', '#!\u0000\u0001binary')).toBe(null);
    expect(id('bin/unknown', 'no shebang')).toBe(null);
    // A shebang does not override an extension.
    expect(language('tool.txt', '#!/usr/bin/env python3')).toBe(null);
  });

  it('declares the lines layout, and .txt for new files', () => {
    expect(layout).toMatchObject({ kind: 'lines', line: 'line', eolAttr: 'eol' });
    expect(textFile.extensions).toEqual(['.txt']);
    expect(textFile.label).toBe('Text file');
  });
});
