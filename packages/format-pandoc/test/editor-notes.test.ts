// Arranging notes: they stay together at the end in reading order; labels never
// change; a tidy document is left alone. As people edit, notes are never moved
// (a move would lose what someone else types in the note): a new note is put in
// its place among them.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorContext } from '@kuraa/editor-kit';
import { pandocMarkdown as md } from '../src/index.js';
import { arrangeNotes, createPandocEditor, pandocKeys } from '../src/editor/index.js';
import { combineStates, decodeDoc, encodeDoc, patchState } from '../../session/src/server.js';

const ctx: EditorContext = {
  schema: md.schema,
  readOnly: false,
  history: { undo: () => false, redo: () => false },
  isRemote: () => false,
  ui: { askText: async () => null, askConfirm: async () => false },
};

/** An editor's state for a file, with the Pandoc editor's behaviour (its plugins), the cursor at `text`. */
function editing(src: string, text?: string, offset = 0): EditorState {
  const doc = md.parse(src).doc;
  let at = -1;
  if (text) doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text) + offset;
  });
  return EditorState.create({ doc, plugins: createPandocEditor().plugins!(ctx), selection: at >= 0 ? TextSelection.create(doc, at) : undefined });
}

/** Where a text is in a document (just after it, with `after`). */
function posOf(doc: PMNode, text: string, after = false): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text) + (after ? text.length : 0);
  });
  if (at < 0) throw new Error(`no ${text}`);
  return at;
}

/** The top-level notes, as nodes. */
const notesOf = (doc: PMNode) => {
  const out: PMNode[] = [];
  doc.forEach((n) => {
    if (n.type.name === 'footnote_def') out.push(n);
  });
  return out;
};

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

describe('notes as people edit', () => {
  it('does not move notes when references change order', () => {
    const s = editing('A[^a] B[^b]\n\n[^a]: Note A.\n\n[^b]: Note B.\n');
    const before = notesOf(s.doc);
    // A reference to b put before a's (pasted, say): b is now the first note in reading order.
    const { state, transactions } = s.applyTransaction(s.tr.insert(posOf(s.doc, 'A'), md.schema.nodes.footnote_ref!.create({ label: 'b' })));
    expect(transactions).toHaveLength(1);
    // The very same note nodes, where they were.
    const after = notesOf(state.doc);
    expect(after).toHaveLength(2);
    for (const [i, n] of before.entries()) expect(after[i]).toBe(n);
    expect(md.serialize(state.doc)).toBe('[^b]A[^a] B[^b]\n\n[^a]: Note A.\n\n[^b]: Note B.\n');
  });

  it('leaves notes written after each paragraph where they are', () => {
    const s = editing('A[^1]\n\n[^1]: One.\n\nB[^2]\n\n[^2]: Two.\n', 'A', 1);
    const next = s.apply(s.tr.insertText('!'));
    expect(md.serialize(next.doc)).toBe('A![^1]\n\n[^1]: One.\n\nB[^2]\n\n[^2]: Two.\n');
  });

  it('puts a new note in its place among the notes, by inserting it', () => {
    const s = editing('A[^a] B[^b]\n\n[^a]: Note A.\n\n[^b]: Note B.\n', 'B', 1);
    let next: EditorState = s;
    const trs: Transaction[] = [];
    expect(pandocKeys(md.schema, ctx)['Mod-Alt-f']!(s, (tr) => {
      trs.push(tr);
      next = s.apply(tr);
    })).toBe(true);
    // Only inserted: the notes there were are the same nodes, a then b, with the new one between.
    const notes = notesOf(next.doc);
    expect(notes.map((n) => n.attrs.label)).toEqual(['a', '1', 'b']);
    expect(notes[0]).toBe(notesOf(s.doc)[0]);
    expect(notes[2]).toBe(notesOf(s.doc)[1]);
    expect(trs[0]!.steps.every((step) => {
      const j = step.toJSON() as { from: number; to: number };
      return j.from === j.to;
    })).toBe(true);
    // The cursor is in the new note.
    expect(next.selection.$from.node(1).attrs.label).toBe('1');
    const typed = next.apply(next.tr.insertText('New.'));
    expect(md.serialize(typed.doc)).toBe('A[^a] B[^1][^b]\n\n[^a]: Note A.\n\n[^1]: New.\n\n[^b]: Note B.\n');
  });

  it('puts a note nothing else comes before at the end, and one before the rest first', () => {
    const first = editing('A[^a]\n\n[^a]: Note A.\n', 'A', 0);
    let next: EditorState = first;
    pandocKeys(md.schema, ctx)['Mod-Alt-f']!(first, (tr) => (next = first.apply(tr)));
    expect(notesOf(next.doc).map((n) => n.attrs.label)).toEqual(['1', 'a']);
    const last = editing('A[^a] B.\n\n[^a]: Note A.\n', 'B', 1);
    pandocKeys(md.schema, ctx)['Mod-Alt-f']!(last, (tr) => (next = last.apply(tr)));
    expect(notesOf(next.doc).map((n) => n.attrs.label)).toEqual(['a', '1']);
  });

  it('keeps what someone types in a note while another person’s edit changes the notes’ order', () => {
    // Both start from the same room (Yjs), as two people with the file open do.
    const src = 'A[^a] B[^b]\n\n[^a]: Note A.\n\n[^b]: Note B.\n';
    const seed = encodeDoc(md.parse(src).doc);
    // Ada puts a reference to b first: in reading order, b's note now comes first.
    const ada = EditorState.create({ doc: decodeDoc(seed, md.schema), plugins: createPandocEditor().plugins!(ctx) });
    const adaNext = ada.apply(ada.tr.insert(posOf(ada.doc, 'A'), md.schema.nodes.footnote_ref!.create({ label: 'b' })));
    const adaState = patchState(seed, adaNext.doc);
    // Meanwhile Bo types in both notes.
    const bo = EditorState.create({ doc: decodeDoc(seed, md.schema) });
    let boTr = bo.tr.insertText(' Bo was here.', posOf(bo.doc, 'Note A.', true));
    boTr = boTr.insertText(' And here.', posOf(boTr.doc, 'Note B.', true));
    const boState = patchState(seed, boTr.doc);
    const both = md.serialize(decodeDoc(combineStates(seed, adaState, boState), md.schema));
    expect(both).toBe('[^b]A[^a] B[^b]\n\n[^a]: Note A. Bo was here.\n\n[^b]: Note B. And here.\n');
  });
});
