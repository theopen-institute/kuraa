// Images sized and placed, and columns (0130): Pandoc's attributes read and
// written back with one part changed; columns made by a drop beside a block,
// beside a column, tidied when one empties; each as Pandoc writes it.
import { describe, expect, it } from 'vitest';
import { Slice, Fragment, type Node as PMNode } from 'prosemirror-model';
import { EditorState, NodeSelection, TextSelection, type Command } from 'prosemirror-state';
import { pandocMarkdown as md } from '../src/index.js';
import { attrValue, cssLength, evenWidths, formatAttrs, imageAlign, parseAttrs, withAttr, withImageAlign } from '../src/attributes.js';
import { aloneImage, besideBlock, columnBackspace, columnDelete, columnsOnEnter, dropBeside, scaledWidths, sideOf, tidyColumns } from '../src/editor/index.js';
import { imageRules } from '../src/editor/images.js';

const out = (doc: PMNode) => md.serialize(doc);
const parse = (src: string) => md.parse(src).doc;

function find(doc: PMNode, pred: (n: PMNode) => boolean): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (!found && pred(node)) found = { node, pos };
    return !found;
  });
  if (!found) throw new Error('not found');
  return found;
}
const paragraphWith = (doc: PMNode, text: string) => find(doc, (n) => n.type.name === 'paragraph' && n.textContent.includes(text));

describe('attributes', () => {
  it('reads ids, classes and keys, quoted or bare', () => {
    expect(parseAttrs('{#fig .wide width=60% alt-text="a \\"b\\" c" k=\'x y\'}')).toEqual({
      id: 'fig', classes: ['wide'], kv: [['width', '60%'], ['alt-text', 'a "b" c'], ['k', 'x y']],
    });
    expect(parseAttrs('columns')).toEqual({ id: '', classes: ['columns'], kv: [] });
    expect(parseAttrs('')).toEqual({ id: '', classes: [], kv: [] });
  });

  it('writes them back, quoting only where it must', () => {
    expect(formatAttrs(parseAttrs('{#fig .wide width=60% k="x y"}'))).toBe('{#fig .wide width=60% k="x y"}');
    expect(formatAttrs({ id: '', classes: [], kv: [] })).toBe('');
  });

  it('changes one key and keeps the rest', () => {
    expect(withAttr('{.wide width=60%}', 'width', '40%')).toBe('{.wide width=40%}');
    expect(withAttr('{.wide}', 'width', '40%')).toBe('{.wide width=40%}');
    expect(withAttr('{width=40%}', 'width', null)).toBe('');
    expect(withAttr('', 'height', null)).toBe('');
    expect(attrValue('{width=40% height=2cm}', 'height')).toBe('2cm');
  });

  it('places an image as Quarto does: fig-align, centred when none', () => {
    expect(imageAlign('')).toBe('center');
    expect(imageAlign('{fig-align=right}')).toBe('right');
    expect(withImageAlign('{width=50%}', 'left')).toBe('{width=50% fig-align=left}');
    expect(withImageAlign('{width=50% fig-align=left}', 'center')).toBe('{width=50%}');
  });

  it('reads Pandoc lengths as CSS: a bare number is pixels', () => {
    expect(cssLength('60%')).toBe('60%');
    expect(cssLength('300')).toBe('300px');
    expect(cssLength('2.5inch')).toBe('2.5in');
    expect(cssLength('3cm')).toBe('3cm');
    expect(cssLength('wide')).toBeNull();
  });

  it('shares 100 among columns in whole percentages', () => {
    expect(evenWidths(2)).toEqual([50, 50]);
    expect(evenWidths(3)).toEqual([34, 33, 33]);
    expect(scaledWidths([30, 30])).toEqual([50, 50]);
    // One that says no width counts as an even share (a third), then all are scaled.
    expect(scaledWidths([null, 25, 25])).toEqual([40, 30, 30]);
  });
});

describe('images sized and placed', () => {
  it('keeps an image’s width and place through a round trip', () => {
    const src = '![A harbour](h.jpg){width=60% fig-align=right}\n';
    const doc = parse(src);
    expect(out(doc)).toBe(src);
    const image = find(doc, (n) => n.type.name === 'image').node;
    expect(image.attrs.attrs).toBe('{width=60% fig-align=right}');
  });

  it('knows an image alone in its paragraph from one in a line of text', () => {
    const doc = parse('![a](a.png)\n\nText ![b](b.png) here.\n');
    expect(aloneImage(doc.child(0))?.attrs.src).toBe('a.png');
    expect(aloneImage(doc.child(1))).toBeNull();
  });

  it('writes its width into the HTML it is copied as', () => {
    const image = md.schema.nodes.image!.create({ src: 'a.png', alt: 'a', attrs: '{width=40% height=300}' });
    const spec = md.schema.nodes.image!.spec.toDOM!(image) as [string, Record<string, string>];
    expect(spec[1].style).toBe('width:40%;height:300px');
  });
});

const COLUMNS = ':::: columns\n::: {.column width=40%}\nLeft.\n:::\n\n::: {.column width=60%}\nRight.\n:::\n::::\n';

describe('columns', () => {
  it('read and written as Pandoc and Quarto have them', () => {
    const doc = parse(COLUMNS);
    expect(out(doc)).toBe(COLUMNS);
    expect(doc.child(0).childCount).toBe(2);
  });

  it('a paragraph dropped beside another: the two in columns, half the line each', () => {
    const doc = parse('First.\n\nSecond.\n');
    const second = paragraphWith(doc, 'Second');
    const first = paragraphWith(doc, 'First');
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, second.pos + 1, second.pos + second.node.nodeSize - 1) });
    const slice = new Slice(Fragment.from(second.node), 0, 0);
    const tr = dropBeside(state, slice, true, { pos: first.pos, node: first.node, side: 'right' })!;
    expect(out(tr.doc)).toBe(':::: columns\n::: {.column width=50%}\nFirst.\n:::\n\n::: {.column width=50%}\nSecond.\n:::\n::::\n');
  });

  it('an image alone in its paragraph, dragged beside another paragraph, takes its paragraph with it', () => {
    const doc = parse('Words here.\n\n![a](a.png){width=80%}\n\nAfter.\n');
    const image = find(doc, (n) => n.type.name === 'image');
    const words = paragraphWith(doc, 'Words');
    const state = EditorState.create({ doc, selection: NodeSelection.create(doc, image.pos) });
    const tr = dropBeside(state, new Slice(Fragment.from(image.node), 0, 0), true, { pos: words.pos, node: words.node, side: 'left' })!;
    expect(out(tr.doc)).toBe(':::: columns\n::: {.column width=50%}\n![a](a.png){width=80%}\n:::\n\n::: {.column width=50%}\nWords here.\n:::\n::::\n\nAfter.\n');
  });

  it('dropped beside a block in a column: a column of its own there, the columns made even', () => {
    const doc = parse(`${COLUMNS}\nMore.\n`);
    const more = paragraphWith(doc, 'More');
    const left = paragraphWith(doc, 'Left');
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, more.pos + 1, more.pos + more.node.nodeSize - 1) });
    const tr = dropBeside(state, new Slice(Fragment.from(more.node), 0, 0), true, { pos: left.pos, node: left.node, side: 'right' })!;
    const text = out(tr.doc);
    expect(text).toContain('::: {.column width=34%}\nLeft.\n:::\n\n::: {.column width=33%}\nMore.\n:::\n\n::: {.column width=33%}\nRight.\n:::');
  });

  it('not beside itself', () => {
    const doc = parse('Only.\n');
    const only = paragraphWith(doc, 'Only');
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, only.pos, only.pos + only.node.nodeSize) });
    expect(dropBeside(state, new Slice(Fragment.from(only.node), 0, 0), true, { pos: only.pos, node: only.node, side: 'right' })).toBeNull();
  });

  it('a column emptied by a drop goes, and columns down to one are its content', () => {
    let state = EditorState.create({ doc: parse(COLUMNS) });
    const right = paragraphWith(state.doc, 'Right');
    // Its words dragged out (the drop's own deletion), leaving the column empty.
    const tr = state.tr.delete(right.pos + 1, right.pos + right.node.nodeSize - 1).setMeta('uiEvent', 'drop');
    state = state.apply(tr);
    const tidied = tidyColumns(state, true)!;
    expect(out(tidied.doc)).toBe('Left.\n');
  });

  it('three columns, one emptied: the other two widened to fill the line', () => {
    const src = ':::: columns\n::: {.column width=20%}\nA\n:::\n\n::: {.column width=20%}\nB\n:::\n\n::: {.column width=60%}\nC\n:::\n::::\n\nEnd.\n';
    let state = EditorState.create({ doc: parse(src) });
    const b = paragraphWith(state.doc, 'B');
    state = state.apply(state.tr.delete(b.pos + 1, b.pos + 2));
    expect(out(tidyColumns(state, true)!.doc)).toBe(':::: columns\n::: {.column width=25%}\nA\n:::\n\n::: {.column width=75%}\nC\n:::\n::::\n\nEnd.\n');
  });

  it('columns last in the document get a paragraph after them, to write below', () => {
    const state = EditorState.create({ doc: parse(COLUMNS) });
    const tr = tidyColumns(state, false)!;
    expect(tr.doc.lastChild!.type.name).toBe('paragraph');
  });

  function at(src: string, text: string, offset: number): EditorState {
    const doc = parse(src);
    const p = paragraphWith(doc, text);
    return EditorState.create({ doc, selection: TextSelection.create(doc, p.pos + 1 + offset) });
  }
  const run = (state: EditorState, cmd: Command) => {
    let next: EditorState | null = null;
    const handled = cmd(state, (tr) => (next = state.apply(tr)));
    return { handled, state: next as EditorState | null };
  };

  it('Backspace in an empty column takes it away', () => {
    const src = ':::: columns\n::: {.column width=50%}\nLeft.\n:::\n\n::: {.column width=50%}\n\n:::\n::::\n\nAfter.\n';
    const doc = parse(src);
    // The empty column's paragraph.
    const empty = find(doc, (n) => n.type.name === 'paragraph' && n.content.size === 0);
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, empty.pos + 1) });
    const r = run(state, columnBackspace);
    expect(r.handled).toBe(true);
    expect(out(r.state!.doc)).toBe('Left.\n\nAfter.\n');
  });

  it('Backspace at the start of a column with words in it, and Delete at its end, do not join across columns', () => {
    expect(run(at(COLUMNS, 'Right', 0), columnBackspace)).toEqual({ handled: true, state: null });
    expect(run(at(COLUMNS, 'Left', 5), columnDelete)).toEqual({ handled: true, state: null });
    expect(run(at(COLUMNS, 'Right', 2), columnBackspace).handled).toBe(false);
  });
});

describe('where a drop goes beside', () => {
  it('near the left or right edge of a block, not its middle', () => {
    const rect = { left: 100, right: 700, width: 600 };
    expect(sideOf(120, rect)).toBe('left');
    expect(sideOf(690, rect)).toBe('right');
    expect(sideOf(400, rect)).toBeNull();
  });

  it('the block at the top level, or the block in a column', () => {
    const doc = parse(`Top.\n\n${COLUMNS}`);
    const top = paragraphWith(doc, 'Top');
    expect(besideBlock(doc, top.pos + 2, -1)?.pos).toBe(top.pos);
    const left = paragraphWith(doc, 'Left');
    expect(besideBlock(doc, left.pos + 2, -1)?.pos).toBe(left.pos);
  });
});

describe('typed', () => {
  /** Type text as the editor does: all but its last character, then the rules see the last. */
  function typeWithRules(state: EditorState, text: string): EditorState {
    state = state.apply(state.tr.insertText(text.slice(0, -1)));
    const at = state.selection.from;
    const before = state.selection.$from.parent.textBetween(0, state.selection.$from.parentOffset, undefined, '\ufffc') + text.slice(-1);
    const rules = imageRules(md.schema) as unknown as { match: RegExp; handler: (s: EditorState, m: RegExpMatchArray, start: number, end: number) => import('prosemirror-state').Transaction | null }[];
    for (const rule of rules) {
      const m = rule.match.exec(before);
      if (!m) continue;
      const tr = rule.handler(state, m, at - (m[0].length - 1), at);
      if (tr) return state.apply(tr);
    }
    return state.apply(state.tr.insertText(text.slice(-1)));
  }

  it('`{width=50%}` straight after an image: its attributes, kept with those it had', () => {
    const doc = parse('![a](a.png){fig-align=left}\n');
    const image = find(doc, (n) => n.type.name === 'image');
    let state = EditorState.create({ doc, selection: TextSelection.create(doc, image.pos + 1) });
    state = typeWithRules(state, '{width=50%}');
    expect(out(state.doc)).toBe('![a](a.png){fig-align=left width=50%}\n');
    // Elsewhere, braces are text.
    state = typeWithRules(state, ' and {this}');
    expect(out(state.doc)).toContain('and {this}');
  });

  it('`::: columns` then Enter: two empty columns, the cursor in the first', () => {
    const doc = parse('Before.\n\n::: columns\n');
    const p = paragraphWith(doc, '::: columns');
    const state = EditorState.create({ doc, selection: TextSelection.create(doc, p.pos + p.node.nodeSize - 1) });
    let next: EditorState | null = null;
    expect(columnsOnEnter(state, (tr) => (next = state.apply(tr)))).toBe(true);
    const s = next as unknown as EditorState;
    expect(out(s.doc)).toBe('Before.\n\n:::: columns\n::: {.column width=50%}\n\n:::\n\n::: {.column width=50%}\n\n:::\n::::\n');
    expect(parse(out(s.doc)).eq(s.doc)).toBe(true);
    expect(s.selection.$from.node(2).attrs.attrs).toBe('{.column width=50%}');
    // Not in a column.
    const cols = parse(COLUMNS);
    const left = paragraphWith(cols, 'Left.');
    const inside = EditorState.create({ doc: cols }).tr.insertText('::: columns', left.pos + 1, left.pos + left.node.nodeSize - 1).doc;
    const q = paragraphWith(inside, '::: columns');
    expect(columnsOnEnter(EditorState.create({ doc: inside, selection: TextSelection.create(inside, q.pos + q.node.nodeSize - 1) }))).toBe(false);
  });
});
