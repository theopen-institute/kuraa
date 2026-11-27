// Grid tables (0102): a cell with several lines. A table with a line break in a
// cell is written as a grid table; a grid table the editor can hold is read as
// a table, its columns' widths kept; any other stays as it is written.
import { describe, expect, it } from 'vitest';
import { EditorState, TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { pandocMarkdown as md } from '../src/index.js';
import { displayWidth, readGrid, writeGrid } from '../src/grid.js';
import { addColumn, deleteColumn } from '../src/editor/index.js';
import { hasPandoc, pandocAst } from '../../../tests/format-helpers.js';

const n = md.schema.nodes;

const GRID = [
  '+---------------+--------------------+',
  '| Step          | Action             |',
  '+:==============+===================:+',
  '| Site prep     | Clear the litter\\  |',
  '|               | from the plot.     |',
  '+---------------+--------------------+',
  '| Coring        | Five cores, to     |',
  '|               | 10 cm.             |',
  '+---------------+--------------------+',
  '',
].join('\n');

/** The first text of `text` in the document: a cursor there, offset in. */
function at(doc: PMNode, text: string, offset = 0): number {
  let pos = -1;
  doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text!.includes(text)) pos = p + node.text!.indexOf(text) + offset;
  });
  if (pos < 0) throw new Error(`no ${text}`);
  return pos;
}

describe('a grid table read', () => {
  it('is a table: its header, its alignment, its widths, a cell’s line break and its lines', () => {
    const doc = md.parse(GRID).doc;
    const table = doc.firstChild!;
    expect(table.type).toBe(n.table);
    expect(table.attrs.align).toBe('lr');
    expect(table.attrs.widths).toBe('15 20');
    expect(table.childCount).toBe(3);
    expect(table.child(0).child(0).attrs.header).toBe(true);
    const cell = table.child(1).child(1);
    expect(cell.child(1).type).toBe(n.hard_break);
    expect(table.child(2).child(1).textContent).toBe('Five cores, to\n10 cm.');
  });

  it('is written back as it was, untouched or written anew', () => {
    const parsed = md.parse(GRID);
    expect(md.serialize(parsed.doc, parsed)).toBe(GRID);
    expect(md.serialize(parsed.doc)).toBe(GRID);
  });

  it('keeps its columns’ widths when a cell changes, widening only a column its text no longer fits', () => {
    const parsed = md.parse(GRID);
    let s = EditorState.create({ doc: parsed.doc });
    s = s.apply(s.tr.insertText('!', at(s.doc, 'Coring', 6)));
    const out = md.serialize(s.doc, parsed);
    expect(out.split('\n')[0]).toBe('+---------------+--------------------+');
    expect(out).toContain('| Coring!       | Five cores, to     |');
    s = s.apply(s.tr.insertText(' and a much longer step name', at(s.doc, 'Coring!', 7)));
    const wider = md.serialize(s.doc, parsed).split('\n');
    expect(wider[0]).toBe(`+${'-'.repeat('Coring! and a much longer step name'.length + 2)}+--------------------+`);
  });

  it('keeps the other columns’ widths as a column is added or deleted', () => {
    const parsed = md.parse(GRID);
    const s = EditorState.create({ doc: parsed.doc, selection: TextSelection.create(parsed.doc, at(parsed.doc, 'Coring', 1)) });
    let added = s;
    addColumn(true)(s, (tr) => (added = s.apply(tr)));
    expect(added.doc.firstChild!.attrs.widths).toBe('15 3 20');
    expect(md.serialize(added.doc).split('\n')[0]).toBe('+---------------+---+--------------------+');
    let gone = s;
    deleteColumn(s, (tr) => (gone = s.apply(tr)));
    expect(gone.doc.firstChild!.attrs.widths).toBe('20');
  });

  it('keeps its caption, after or before it', () => {
    const after = `${GRID}\n: Field steps {#tbl-steps}\n`;
    const parsed = md.parse(after);
    expect(parsed.doc.firstChild!.attrs.caption).toBe(': Field steps {#tbl-steps}');
    expect(md.serialize(parsed.doc)).toBe(after);
    const before = `: Field steps\n\n${GRID}`;
    expect(md.serialize(md.parse(before).doc)).toBe(before);
  });

  it('stays as it is written where the editor cannot hold it: spans, no header, two paragraphs in a cell, a footnote', () => {
    const raw = (src: string) => expect(md.parse(src).doc.firstChild!.type).toBe(n.raw_block);
    // A cell spanning two columns.
    raw('+-----+-----+\n| a   | b   |\n+=====+=====+\n| wide      |\n+-----+-----+\n');
    // No header.
    raw('+-----+-----+\n| a   | b   |\n+-----+-----+\n');
    // Two paragraphs in a cell.
    raw('+-----+-----+\n| a   | b   |\n+=====+=====+\n| one | x   |\n|     |     |\n| two |     |\n+-----+-----+\n');
    // A list in a cell.
    raw('+-------+-----+\n| a     | b   |\n+=======+=====+\n| - one | x   |\n| - two |     |\n+-------+-----+\n');
    // A footnote's reference, which the cell alone could not read.
    raw('+---------+-----+\n| a       | b   |\n+=========+=====+\n| see[^1] | x   |\n+---------+-----+\n\n[^1]: A note.\n');
  });
});

describe('a line break in a table’s cell', () => {
  it('makes it a grid table, the break ending its line with a backslash', () => {
    const parsed = md.parse('| Site | Notes |\n|---|---|\n| Kew | wet |\n');
    let s = EditorState.create({ doc: parsed.doc, selection: TextSelection.create(parsed.doc, at(parsed.doc, 'wet', 3)) });
    s = s.apply(s.tr.replaceSelectionWith(n.hard_break!.create()).insertText('cold'));
    const out = md.serialize(s.doc, parsed);
    expect(out).toBe([
      '+------+-------+',
      '| Site | Notes |',
      '+======+=======+',
      '| Kew  | wet\\  |',
      '|      | cold  |',
      '+------+-------+',
      '',
    ].join('\n'));
    // Read back, the same table.
    expect(md.parse(out).doc.firstChild!.child(1).eq(s.doc.firstChild!.child(1))).toBe(true);
  });

  it('at the end of a cell is not written (it has no markdown form there)', () => {
    const parsed = md.parse('| a | b |\n|---|---|\n| x | y |\n');
    let s = EditorState.create({ doc: parsed.doc, selection: TextSelection.create(parsed.doc, at(parsed.doc, 'y', 1)) });
    s = s.apply(s.tr.replaceSelectionWith(n.hard_break!.create()));
    const out = md.serialize(s.doc);
    expect(out).toContain('| x | y |');
    expect(out).not.toContain('\\');
  });

  it.skipIf(!hasPandoc)('is a line break to Pandoc too', () => {
    const ast = pandocAst(GRID) as { blocks: { t: string; c: unknown[] }[] };
    expect(ast.blocks[0]!.t).toBe('Table');
    expect(JSON.stringify(ast.blocks[0])).toContain('"LineBreak"');
  });
});

describe('grid tables’ columns', () => {
  it('count East Asian characters as two wide and combining marks as none', () => {
    expect(displayWidth('abc')).toBe(3);
    expect(displayWidth('漢字')).toBe(4);
    expect(displayWidth('é')).toBe(1);
  });

  it('line up around wide characters, and read back so', () => {
    const text = writeGrid([['名前', 'Note'], ['漢字\\\nかな', 'ok']], '--');
    expect(text.split('\n').map(displayWidth).every((w, _, all) => w === all[0])).toBe(true);
    expect(readGrid(text)?.rows).toEqual([['名前', 'Note'], ['漢字\\\nかな', 'ok']]);
  });
});
