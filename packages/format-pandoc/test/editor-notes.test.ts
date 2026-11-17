// Arranging notes: they stay together at the end in reading order; labels never
// change; a tidy document is left alone.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import { pandocMarkdown as md } from '../src/index.js';
import { arrangeNotes } from '../src/editor/index.js';

function arrange(src: string): string | null {
  const parsed = md.parse(src);
  const tr = arrangeNotes(EditorState.create({ doc: parsed.doc }));
  return tr ? md.serialize(tr.doc, parsed) : null;
}

describe('arranging notes', () => {
  it('puts the notes at the end in order of first reference, keeping their labels', () => {
    expect(arrange('A[^b] B[^a] again[^b]\n\n[^a]: Note A.\n\nMiddle.\n\n[^b]: Note B.\n'))
      .toBe('A[^b] B[^a] again[^b]\n\nMiddle.\n\n[^b]: Note B.\n\n[^a]: Note A.\n');
  });

  it('puts notes nothing refers to last', () => {
    expect(arrange('Text[^x]\n\n[^orphan]: Unused.\n\n[^x]: Used.\n'))
      .toBe('Text[^x]\n\n[^x]: Used.\n\n[^orphan]: Unused.\n');
  });

  it('moves notes written after each paragraph to the end', () => {
    expect(arrange('A[^1]\n\n[^1]: One.\n\nB[^2]\n\n[^2]: Two.\n'))
      .toBe('A[^1]\n\nB[^2]\n\n[^1]: One.\n\n[^2]: Two.\n');
  });

  it('drops an identical duplicate of a note', () => {
    expect(arrange('A[^1]\n\n[^1]: One.\n\n[^1]: One.\n')).toBe('A[^1]\n\n[^1]: One.\n');
  });

  it('leaves a document whose notes are in place alone', () => {
    expect(arrange('A^[inline] B[^7] C[^2]\n\n[^7]: First.\n\n[^2]: Second.\n')).toBe(null);
    expect(arrange('No notes here.\n')).toBe(null);
  });

  it('keeps the cursor in a note that moves', () => {
    const parsed = md.parse('A[^b] B[^a]\n\n[^a]: Note A.\n\n[^b]: Note B.\n');
    let at = -1;
    parsed.doc.descendants((node, pos) => {
      if (node.isText && node.text === 'Note A.') at = pos + 4;
    });
    const state = EditorState.create({ doc: parsed.doc, selection: TextSelection.create(parsed.doc, at) });
    const tr = arrangeNotes(state)!;
    const { $from } = tr.selection;
    expect($from.parent.textContent).toBe('Note A.');
    expect($from.parentOffset).toBe(4);
  });
});
