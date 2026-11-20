// Comparing a past version with the document now, and what restoring and finding
// a search match do to the live document.
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import { pandocMarkdown as md } from '@kuraa/format-pandoc';
import { blocksFrom, compareTexts, compareWords } from '../src/compare.js';
import { locateMatch, replaceWithText } from '../src/docActions.js';

const blocks = blocksFrom((t) => md.parse(t));

describe('compareTexts', () => {
  it('marks the words that changed inside a changed block, and blocks added and removed', () => {
    const before = '# Methods\n\nWe counted crabs at dawn.\n\nAn old paragraph that goes.\n\n## Results\n';
    const after = '# Methods\n\nWe counted many crabs at noon.\n\n## Results\n\nA new finding.\n';
    const { blocks: out, changes } = compareTexts(before, after, blocks);
    expect(changes).toBe(3);
    expect(out).toEqual([
      { kind: 'same', text: '# Methods' },
      { kind: 'changed', words: [
        { kind: 'same', text: 'We counted ' },
        { kind: 'added', text: 'many ' },
        { kind: 'same', text: 'crabs at ' },
        { kind: 'removed', text: 'dawn' },
        { kind: 'added', text: 'noon' },
        { kind: 'same', text: '.' },
      ] },
      { kind: 'removed', text: 'An old paragraph that goes.' },
      { kind: 'same', text: '## Results' },
      { kind: 'added', text: 'A new finding.' },
    ]);
  });

  it('folds long unchanged stretches, keeping a block of context by each change', () => {
    const paras = Array.from({ length: 8 }, (_, i) => `Paragraph ${i + 1}.`);
    const after = [...paras];
    after[5] = 'Paragraph six, rewritten.';
    const { blocks: out } = compareTexts(paras.join('\n\n'), after.join('\n\n'), blocks);
    expect(out.map((b) => b.kind)).toEqual(['folded', 'same', 'changed', 'same', 'folded']);
    expect(out[0]).toEqual({ kind: 'folded', count: 4 });
    expect(out[4]).toEqual({ kind: 'folded', count: 1 });
  });

  it('shows a block rewritten beyond recognition as removed and added, and the same text as no change', () => {
    expect(compareTexts('Alpha beta gamma.', 'Entirely different words here.', blocks).blocks.map((b) => b.kind)).toEqual(['removed', 'added']);
    expect(compareTexts('Same.\n\nText.', 'Same.\n\nText.', blocks)).toEqual({ blocks: [{ kind: 'folded', count: 2 }], changes: 0 });
    expect(compareWords('a b', 'a b')).toEqual([{ kind: 'same', text: 'a b' }]);
  });
});

describe('the live document', () => {
  const NOW = '---\ntitle: Notes\n---\n\n# Tides\n\nThe tide was out. The *tide* came back.\n\n## Later\n\nNo tide today.\n';

  it('restoring a past version changes only the blocks that differ', () => {
    const state = EditorState.create({ doc: md.parse(NOW).doc });
    const past = NOW.replace('No tide today.', 'Rain all day.');
    const tr = replaceWithText(state, md, past)!;
    expect(md.serialize(tr.doc)).toBe(md.serialize(md.parse(past).doc));
    // The first blocks are untouched: the change starts in the last paragraph.
    expect(tr.mapping.map(5)).toBe(5);
    expect(replaceWithText(EditorState.create({ doc: tr.doc }), md, past)).toBeNull();
  });

  it('finds a search match in the document as the editor shows it', () => {
    const doc = md.parse(NOW).doc;
    const text = (r: { from: number; to: number } | null) => (r ? doc.textBetween(r.from, r.to) : null);
    // The second "tide" on line 7 is inside emphasis in the file; the editor has it as plain text with a mark.
    const second = locateMatch(md, doc, { line: 7, at: 23, query: 'tide', caseSensitive: true });
    expect(text(second)).toBe('tide');
    const first = locateMatch(md, doc, { line: 7, at: 4, query: 'tide', caseSensitive: true })!;
    expect(first.from).toBeLessThan(second!.from);
    expect(text(locateMatch(md, doc, { line: 11, at: 3, query: 'TIDE', caseSensitive: false }))).toBe('tide');
    // The file moved on since the search: the nearest line that has it.
    expect(text(locateMatch(md, doc, { line: 9, at: 0, query: 'today', caseSensitive: true }))).toBe('today');
    expect(locateMatch(md, doc, { line: 1, at: 0, query: 'absent', caseSensitive: true })).toBeNull();
  });
});
