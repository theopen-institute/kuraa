import { describe, expect, it } from 'vitest';
import { sourceMapOf } from '../src/index.js';
import { pandocMarkdown } from '../../format-pandoc/src/index.js';
import { textFile } from '../../format-text/src/index.js';

/** Where `phrase` is in the document's text, as document positions. */
function docRange(doc: import('prosemirror-model').Node, phrase: string): { from: number; to: number } {
  let found: { from: number; to: number } | null = null;
  doc.descendants((node, pos) => {
    if (found || !node.isTextblock) return !found;
    // Positions of each character of the block's text (atoms count as one, with no text).
    let text = '';
    const at: number[] = [];
    node.forEach((child, offset) => {
      if (child.isText) for (let i = 0; i < child.text!.length; i++) {
        text += child.text![i];
        at.push(pos + 1 + offset + i);
      }
    });
    const i = text.indexOf(phrase);
    if (i >= 0) found = { from: at[i]!, to: at[i + phrase.length - 1]! + 1 };
    return false;
  });
  if (!found) throw new Error(`not found: ${phrase}`);
  return found;
}

describe('sourceMapOf, aligned', () => {
  const md = '---\ntitle: Notes\n---\n\n# A *heading*\n\nSome **bold** text and a [link](https://example.org) here.\n\n- one\n- two \\* three\n';

  it('maps a passage in the document to the same characters in the file, markup and all', () => {
    const parsed = pandocMarkdown.parse(md);
    const map = sourceMapOf(pandocMarkdown, parsed.doc, parsed);
    const r = docRange(parsed.doc, 'bold text and a link');
    const from = map.toText(r.from);
    const to = map.toText(r.to, -1);
    expect(md.slice(from, to)).toBe('bold** text and a [link');
    const h = docRange(parsed.doc, 'heading');
    expect(md.slice(map.toText(h.from), map.toText(h.to, -1))).toBe('heading');
    const e = docRange(parsed.doc, 'two * three');
    expect(md.slice(map.toText(e.from), map.toText(e.to, -1))).toBe('two \\* three');
  });

  it('maps the file back to the document, places in markup to the nearest text', () => {
    const parsed = pandocMarkdown.parse(md);
    const map = sourceMapOf(pandocMarkdown, parsed.doc, parsed);
    const r = docRange(parsed.doc, 'bold');
    // The `b` of bold, and the `**` before it (to where the text starts).
    expect(map.toDoc(md.indexOf('bold'))).toBe(r.from);
    expect(map.toDoc(md.indexOf('**bold'))).toBe(r.from);
    // Round trips over every character of the text.
    for (const phrase of ['Some', 'text and', 'here.', 'one', 'three']) {
      const d = docRange(parsed.doc, phrase);
      expect(map.toDoc(map.toText(d.from))).toBe(d.from);
    }
  });

  it('is exact for text files, line by line', () => {
    const text = 'a <- 1\r\nb <- a + 2\n\nprint(b)';
    const parsed = textFile.parse(text);
    const map = sourceMapOf(textFile, parsed.doc, parsed);
    const r = docRange(parsed.doc, 'a + 2');
    expect(text.slice(map.toText(r.from), map.toText(r.to, -1))).toBe('a + 2');
    expect(map.toDoc(text.indexOf('print'))).toBe(docRange(parsed.doc, 'print').from);
    // Past the end: the end.
    expect(map.toText(parsed.doc.content.size)).toBe(text.length);
  });

  it('uses the type’s own map where it has one', () => {
    const own = { ...textFile, sourceMap: () => ({ toText: () => 7, toDoc: () => 3 }) };
    const parsed = own.parse('x');
    const map = sourceMapOf(own, parsed.doc, parsed);
    expect(map.toText(1)).toBe(7);
    expect(map.toDoc(0)).toBe(3);
  });
});

describe('sourceMapOf, ranges both ways', () => {
  it('gives back the same range from the text, whatever markup closes it', () => {
    const md = 'Some **bold** text.\n';
    const parsed = pandocMarkdown.parse(md);
    const map = sourceMapOf(pandocMarkdown, parsed.doc, parsed);
    const r = docRange(parsed.doc, 'bold');
    const from = map.toText(r.from);
    const to = map.toText(r.to, -1);
    expect(md.slice(from, to)).toBe('bold');
    expect(map.toDoc(from)).toBe(r.from);
    expect(map.toDoc(to, -1)).toBe(r.to);
    // From the end of the markup too.
    expect(map.toDoc(md.indexOf(' text'), -1)).toBe(r.to);
  });
});
