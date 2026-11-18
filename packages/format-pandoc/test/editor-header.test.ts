// The header in the editor: kept out of reach of the cursor and of typing; edits
// made on purpose, and other people's, go through.
import { describe, expect, it } from 'vitest';
import { AllSelection, EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { DELIBERATE_EDIT, type EditorContext } from '@kuraa/editor-kit';
import { pandocMarkdown as md } from '../src/index.js';
import { pandocEditor } from '../src/editor/index.js';

const REMOTE = 'test:remote';
function stateOf(src: string) {
  const ctx: EditorContext = {
    schema: md.schema,
    readOnly: false,
    history: { undo: () => false, redo: () => false },
    isRemote: (tr: Transaction) => tr.getMeta(REMOTE) === true,
    ui: { askText: async () => null, askConfirm: async () => false },
  };
  return EditorState.create({ doc: md.parse(src).doc, plugins: pandocEditor.plugins!(ctx) });
}
const SRC = '---\ntitle: A\n---\n\nFirst.\n\nSecond.\n';
const end = (s: EditorState) => s.doc.firstChild!.nodeSize;

describe('the header in the editor', () => {
  it('says which block holds it, and offers Pandoc’s fields', () => {
    expect(pandocEditor.header?.node).toBe('front_matter');
    expect(pandocEditor.header?.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['title', 'author', 'date', 'bibliography', 'lang']));
  });

  it('moves a cursor put in the header to the start of the text', () => {
    let s = stateOf(SRC);
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 2)));
    expect(s.selection.from).toBe(end(s) + 1);
    expect(s.selection.empty).toBe(true);
  });

  it('starts Select All after the header', () => {
    let s = stateOf(SRC);
    s = s.apply(s.tr.setSelection(new AllSelection(s.doc)));
    expect(s.selection.from).toBe(end(s) + 1);
    expect(s.selection.to).toBe(s.doc.content.size - 1);
  });

  it('keeps typing from changing or deleting it', () => {
    const s = stateOf(SRC);
    expect(s.applyTransaction(s.tr.insertText('x', 2)).state.doc.eq(s.doc)).toBe(true);
    expect(s.applyTransaction(s.tr.delete(0, end(s) + 3)).state.doc.eq(s.doc)).toBe(true);
    // Elsewhere, typing works.
    expect(s.apply(s.tr.insertText('x', end(s) + 1)).doc.child(1).textContent).toBe('xFirst.');
  });

  it('lets edits made on purpose, and other people’s, through', () => {
    const s = stateOf(SRC);
    const node = md.schema.nodes.front_matter!.create(null, md.schema.text('title: B'));
    const mine = s.apply(s.tr.replaceWith(0, end(s), node).setMeta(DELIBERATE_EDIT, true));
    expect(mine.doc.firstChild!.textContent).toBe('title: B');
    const theirs = s.apply(s.tr.insertText('x', 2).setMeta(REMOTE, true));
    expect(theirs.doc.firstChild!.textContent).toBe('txitle: A');
  });

  it('leaves documents without a header alone', () => {
    let s = stateOf('Only text.\n');
    s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, 1)));
    expect(s.selection.from).toBe(1);
    expect(s.apply(s.tr.insertText('x', 1)).doc.textContent).toBe('xOnly text.');
  });
});
