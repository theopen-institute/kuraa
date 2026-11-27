// The editor's writing commands, without a page: tables made and changed and
// written as pipe tables, citations named from the bibliography, conflicts
// visited in turn, and paths resolved against the document.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection, type Command } from 'prosemirror-state';
import type { EditorContext } from '@kuraa/editor-kit';
import { pandocMarkdown as md } from '../src/index.js';
import {
  addColumn, addRow, Bibliography, cellAt, citationLabel, conflictPositions, deleteColumn, deleteRow, goToCell,
  headerCells, insertTable, nextConflict, versionDateLabel, wordAt, workspacePath,
} from '../src/editor/index.js';

function stateAt(src: string, text: string, offset = 0): EditorState {
  const doc = md.parse(src).doc;
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.isText && node.text!.includes(text)) at = pos + node.text!.indexOf(text) + offset;
  });
  if (at < 0) throw new Error(`no ${text}`);
  return EditorState.create({ doc, selection: TextSelection.create(doc, at) });
}

function run(state: EditorState, ...commands: Command[]): EditorState {
  for (const c of commands) {
    let next = state;
    expect(c(state, (tr) => (next = state.apply(tr)))).toBe(true);
    state = next;
  }
  return state;
}

const type = (state: EditorState, text: string) => state.apply(state.tr.insertText(text));
const out = (state: EditorState) => md.serialize(state.doc);

describe('tables', () => {
  it('inserts a table that is written as a pipe table and read back the same', () => {
    let s = run(stateAt('Before.\n', 'Before.', 7), insertTable);
    s = type(s, 'Site');
    s = run(s, goToCell(1));
    s = type(s, 'Bees');
    s = run(s, goToCell(1));
    s = type(s, 'Roof A');
    s = run(s, goToCell(1));
    s = type(s, '12 | 13');
    expect(out(s)).toBe('Before.\n\n| Site | Bees |\n|---|---|\n| Roof A | 12 \\| 13 |\n');
    expect(md.parse(out(s)).doc.eq(s.doc)).toBe(true);
  });

  it('makes a row when Tab leaves the last cell, and goes back with Shift+Tab', () => {
    let s = stateAt('| a | b |\n|---|---|\n| 1 | 2 |\n', '2', 1);
    s = run(s, goToCell(1));
    expect(cellAt(s)).toMatchObject({ row: 2, col: 0 });
    expect(s.doc.firstChild!.childCount).toBe(3);
    s = run(s, goToCell(-1));
    expect(cellAt(s)).toMatchObject({ row: 1, col: 1 });
  });

  it('adds and deletes rows and columns, keeping the header first and an alignment per column', () => {
    let s = stateAt('| a | b |\n|:--|--:|\n| 1 | 2 |\n', 'a', 1);
    s = run(s, addRow(false));
    expect(out(s)).toBe('|  |  |\n|:---|---:|\n| a | b |\n| 1 | 2 |\n');
    s = run(s, deleteRow);
    expect(out(s)).toBe('| a | b |\n|:---|---:|\n| 1 | 2 |\n');
    s = run(stateAt(out(s), 'a', 1), addColumn(true));
    expect(out(s)).toBe('| a |  | b |\n|:---|---|---:|\n| 1 |  | 2 |\n');
    s = run(stateAt(out(s), 'b'), deleteColumn);
    expect(out(s)).toBe('| a |  |\n|:---|---|\n| 1 |  |\n');
    expect(md.parse(out(s)).doc.eq(s.doc)).toBe(true);
  });

  it('reads a typed header line', () => {
    expect(headerCells('| Site | Bees |')).toEqual(['Site', 'Bees']);
    expect(headerCells('| a \\| b | c |')).toEqual(['a | b', 'c']);
    expect(headerCells('| |')).toBe(null);
    expect(headerCells('a | b')).toBe(null);
  });
});

describe('the word right-clicked in a table (for its spelling suggestions)', () => {
  const at = (src: string, text: string, offset: number) => {
    const s = stateAt(src, text, offset);
    return wordAt(s.doc, s.selection.from);
  };
  const src = '| Site | Notes |\n|---|---|\n| Kew | the bee’s **nset**-like hive |\n';

  it('is the whole word, from inside it or at either edge', () => {
    expect(at(src, 'bee’s', 2)?.word).toBe('bee’s');
    expect(at(src, 'bee’s', 0)?.word).toBe('bee’s');
    expect(at(src, 'bee’s', 5)?.word).toBe('bee’s');
  });

  it('is the text of one node: a word in bold stops where the bold does', () => {
    const w = at(src, 'nset', 1)!;
    expect(w.word).toBe('nset');
    expect(stateAt(src, 'nset').doc.textBetween(w.from, w.to)).toBe('nset');
  });

  it('is none between words, or without letters', () => {
    expect(at('| a | b |\n|---|---|\n| 12 34 | x |\n', '12', 1)).toBeNull();
    expect(at(src, ' hive', 0)?.word).toBe('like');
  });
});

describe('citations in the editor', () => {
  const ctx = {} as EditorContext;
  const bib = new Bibliography(ctx);
  bib.entries.set('smith2020', { key: 'smith2020', authors: ['Smith'], year: '2020', title: 'Tides' });
  bib.entries.set('doe2019', { key: 'doe2019', authors: ['Doe', 'Roe'], year: '2019', title: 'Marsh' });

  it('names what a citation cites', () => {
    bib.loaded = true;
    expect(citationLabel('@smith2020', bib)).toEqual({ label: 'Smith 2020', unknown: [] });
    expect(citationLabel('@smith2020 [p. 3]', bib).label).toBe('Smith 2020, p. 3');
    expect(citationLabel('[see @smith2020, p. 3; -@doe2019]', bib).label).toBe('(see Smith 2020, p. 3; 2019)');
    expect(citationLabel('[@nobody]', bib)).toEqual({ label: '(@nobody)', unknown: ['nobody'] });
    bib.loaded = false;
    expect(citationLabel('[@nobody]', bib).unknown).toEqual([]);
  });

  it('finds entries by key, author or title', () => {
    expect(bib.search('smi').map((e) => e.key)).toEqual(['smith2020']);
    expect(bib.search('roe').map((e) => e.key)).toEqual(['doe2019']);
    expect(bib.search('marsh').map((e) => e.key)).toEqual(['doe2019']);
    expect(bib.search('').map((e) => e.key)).toEqual(['doe2019', 'smith2020']);
  });
});

describe('conflicts', () => {
  const src = 'Intro.\n\n:::: {.conflict}\n::: {.version by="Ada" commit="3f2c1e0"}\nOne.\n:::\n\n::: {.version by="Bo" commit="9a41d7b"}\nTwo.\n:::\n::::\n\nMiddle.\n\n:::: {.conflict}\n::: {.version by="Ada"}\nThree.\n:::\n\n::: {.version by="Bo"}\nFour.\n:::\n::::\n';

  it('goes to each conflict in turn, then back to the first', () => {
    let s = stateAt(src, 'Intro.');
    const [first, second] = conflictPositions(s.doc);
    s = run(s, nextConflict);
    expect(s.selection.$from.parent.textContent).toBe('One.');
    s = run(s, nextConflict);
    expect(s.selection.from).toBeGreaterThan(second!);
    expect(s.selection.$from.parent.textContent).toBe('Three.');
    s = run(s, nextConflict);
    expect(s.selection.from).toBeGreaterThan(first!);
    expect(s.selection.$from.parent.textContent).toBe('One.');
  });

  it('labels a version with who and when', () => {
    const now = new Date('2026-11-20T12:00:00');
    expect(versionDateLabel('Ada', '2026-11-03T14:05:00')).toMatch(/^Ada, .*3.* at /);
    expect(versionDateLabel('Ada', '2024-11-03T14:05:00', now)).toContain('2024');
    expect(versionDateLabel('Ada', 'not a date')).toBe('Ada');
  });
});

describe('paths', () => {
  it('resolves what a document writes against its folder, never outside the workspace', () => {
    expect(workspacePath('chapters/one.md', 'images/a.png')).toBe('chapters/images/a.png');
    expect(workspacePath('chapters/one.md', '../refs.bib')).toBe('refs.bib');
    expect(workspacePath('one.md', '../refs.bib')).toBe(null);
    expect(workspacePath('one.md', '/etc/passwd')).toBe(null);
    expect(workspacePath('one.md', 'https://example.org/a.png')).toBe(null);
    expect(workspacePath('one.md', 'my%20plot.png')).toBe('my plot.png');
  });
});
