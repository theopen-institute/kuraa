// Renumbering notes: labels follow reading order, notes move to the end in that
// order, and a tidy document is left alone.
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { pandocMarkdown as md } from '@kuraa/format-pandoc';
import { renumberNotes } from '../src/notes.js';

const hints = md.editor!.nodeViews!;

function renumber(src: string): string | null {
  const parsed = md.parse(src);
  const tr = renumberNotes(EditorState.create({ doc: parsed.doc }), hints);
  return tr ? md.serialize(tr.doc, parsed) : null;
}

describe('renumbering notes', () => {
  it('relabels in order of first reference and moves the notes to the end in that order', () => {
    expect(renumber('A[^b] B[^a] again[^b]\n\n[^a]: Note A.\n\nMiddle.\n\n[^b]: Note B.\n'))
      .toBe('A[^1] B[^2] again[^1]\n\nMiddle.\n\n[^1]: Note B.\n\n[^2]: Note A.\n');
  });

  it('puts notes nothing refers to last, after the numbered ones', () => {
    expect(renumber('Text[^x]\n\n[^orphan]: Unused.\n\n[^x]: Used.\n'))
      .toBe('Text[^1]\n\n[^1]: Used.\n\n[^2]: Unused.\n');
  });

  it('relabels references inside notes too', () => {
    expect(renumber('A[^p]\n\n[^q]: Q.\n\n[^p]: P, see[^q].\n'))
      .toBe('A[^1]\n\n[^1]: P, see[^2].\n\n[^2]: Q.\n');
  });

  it('leaves inline notes as they are, and needs no change when already tidy', () => {
    expect(renumber('A^[inline] B[^1] C[^2]\n\n[^1]: One.\n\n[^2]: Two.\n')).toBe(null);
    expect(renumber('No notes here.\n')).toBe(null);
  });

  it('moves notes written after each paragraph to the end', () => {
    expect(renumber('A[^1]\n\n[^1]: One.\n\nB[^2]\n\n[^2]: Two.\n'))
      .toBe('A[^1]\n\nB[^2]\n\n[^1]: One.\n\n[^2]: Two.\n');
  });
});
