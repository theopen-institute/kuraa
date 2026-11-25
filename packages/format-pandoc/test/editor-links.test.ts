// ⌘K finds the link the cursor is in, to change its address or take it away.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { pandocMarkdown as md } from '../src/index.js';
import { linkAt } from '../src/editor/index.js';

const link = md.schema.marks.link!;

function at(src: string, text: string, offset: number, length = 0): EditorState {
  const doc = md.parse(src).doc;
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text!.includes(text)) pos = p + node.text!.indexOf(text) + offset;
  });
  return EditorState.create({ doc, selection: TextSelection.create(doc, pos, pos + length) });
}

describe('the link the cursor is in', () => {
  const src = 'See [the *field* notes](notes.md) and more.\n';

  it('is the whole link, whatever marks change along it', () => {
    const s = at(src, 'the ', 1);
    const found = linkAt(s, link)!;
    expect(found.href).toBe('notes.md');
    expect(s.doc.textBetween(found.from, found.to)).toBe('the field notes');
  });

  it('is found from a selection inside it, and just after its last letter', () => {
    expect(linkAt(at(src, 'field', 0, 5), link)?.href).toBe('notes.md');
    expect(linkAt(at(src, ' notes', 6), link)?.href).toBe('notes.md');
  });

  it('is none outside a link, or for a selection that goes beyond it', () => {
    expect(linkAt(at(src, 'and more', 4), link)).toBeNull();
    expect(linkAt(at(src, ' notes', 0, 8), link)).toBeNull();
  });
});
