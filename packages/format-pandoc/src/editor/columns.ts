// Columns (0130), as Pandoc and Quarto write them: a div of class `columns`
// holding a div of class `column` for each, its width a share of the line's:
//
//   :::: columns
//   ::: {.column width="40%"}
//   …
//   :::
//   ::: {.column width="60%"}
//   …
//   :::
//   ::::
//
// In the editor they stand side by side. Something dragged (an image, selected
// text or paragraphs) and dropped at the left or right edge of a paragraph puts
// the two in columns, or, at a column's edge, adds a column there. The gap
// between two columns is dragged to share their width differently. A column
// emptied by dragging out of it goes, and so does an empty one Backspace is
// pressed in; columns down to one are its content again.
import type { EditorContext } from '@kuraa/editor-kit';
import { Fragment, type Node as PMNode, type Schema, type Slice } from 'prosemirror-model';
import { NodeSelection, Plugin, PluginKey, Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import type { EditorView, NodeView, NodeViewConstructor } from 'prosemirror-view';
import { attrValue, evenWidths, formatAttrs, formatDivAttrs, hasClass, percentOf, withAttr } from '../attributes.js';
import { conflictViews } from './conflicts.js';
import { aloneImage } from './images.js';

const DIV = 'fenced_div';

export const isColumns = (n: PMNode | null | undefined): boolean => !!n && n.type.name === DIV && hasClass(String(n.attrs.attrs), 'columns');
export const isColumn = (n: PMNode | null | undefined): boolean => !!n && n.type.name === DIV && hasClass(String(n.attrs.attrs), 'column');
/** Columns as the editor keeps them: a `columns` div that holds nothing but columns. */
const isColumnSet = (n: PMNode | null | undefined): boolean => {
  if (!n || !isColumns(n)) return false;
  let all = true;
  n.forEach((c) => { if (!isColumn(c)) all = false; });
  return all;
};

/** A column's width as a share of the line's, if it says one. */
export const columnWidth = (n: PMNode): number | null => percentOf(attrValue(String(n.attrs.attrs), 'width'));

export function columnNode(schema: Schema, content: Fragment, width: number): PMNode | null {
  return schema.nodes[DIV]!.createAndFill({ attrs: formatAttrs({ id: '', classes: ['column'], kv: [['width', `${width}%`]] }), fence: 3 }, content);
}

export function columnsNode(schema: Schema, columns: PMNode[]): PMNode {
  return schema.nodes[DIV]!.create({ attrs: formatDivAttrs({ id: '', classes: ['columns'], kv: [] }), fence: 4 }, columns);
}

/** A column with another width (its other attributes as they were). */
const widened = (col: PMNode, width: number): PMNode =>
  col.type.create({ ...col.attrs, attrs: withAttr(String(col.attrs.attrs), 'width', `${width}%`) }, col.content, col.marks);

/** Widths scaled to add up to 100 (each it does not say, an even share), in whole percentages. */
export function scaledWidths(widths: (number | null)[]): number[] {
  const n = widths.length;
  if (!n) return [];
  const even = 100 / n;
  const known = widths.map((w) => (w && w > 0 ? w : even));
  const sum = known.reduce((a, b) => a + b, 0);
  const out = known.map((w) => Math.max(1, Math.round((w / sum) * 100)));
  out[n - 1]! += 100 - out.reduce((a, b) => a + b, 0);
  return out;
}

/** Columns made again from some, their widths scaled to fill the line; one alone is its content, none an empty paragraph. */
function rebuilt(schema: Schema, set: PMNode, keep: PMNode[], widths: number[] = scaledWidths(keep.map(columnWidth))): Fragment {
  if (!keep.length) return Fragment.from(schema.nodes.paragraph!.create());
  if (keep.length === 1) return keep[0]!.content;
  return Fragment.from(set.type.create(set.attrs, keep.map((c, i) => widened(c, widths[i]!)), set.marks));
}

const isEmptyColumn = (col: PMNode) => col.childCount === 1 && col.firstChild!.type.name === 'paragraph' && col.firstChild!.content.size === 0;

// ---------------------------------------------------------------------------
// Views

const el = (tag: string, className: string) => {
  const e = document.createElement(tag);
  e.className = className;
  return e;
};

class ColumnsView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  constructor() {
    this.dom = this.contentDOM = el('div', 'columns-block');
    this.dom.dataset.testid = 'columns';
  }
  update(node: PMNode): boolean {
    return isColumns(node);
  }

  /** Its own class (resizing) changed is not an edit. */
  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return m.type === 'attributes' && m.target === this.dom;
  }
}

class ColumnView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private gutter: HTMLElement | null = null;

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: () => number | undefined) {
    this.dom = el('div', 'column-block');
    this.dom.dataset.testid = 'column';
    this.contentDOM = el('div', 'column-body');
    if (view.editable) {
      const gutter = el('div', 'column-gutter');
      gutter.contentEditable = 'false';
      gutter.dataset.testid = 'column-gutter';
      gutter.title = 'Drag to change the columns’ widths';
      gutter.addEventListener('pointerdown', (e) => this.resize(e, gutter));
      this.gutter = gutter;
      this.dom.append(gutter);
    }
    this.dom.append(this.contentDOM);
    this.flex(columnWidth(node));
  }

  private flex(width: number | null, dom = this.dom) {
    dom.style.flex = `${width ?? 50} 1 0%`;
  }

  /**
   * Its gutter (at its left, between it and the column before) dragged: the two
   * share their width differently, neither under a tenth of the line;
   * written, in whole percentages, when let go.
   */
  private resize(e: PointerEvent, gutter: HTMLElement) {
    if (!this.view.editable || e.button !== 0) return;
    const pos = this.getPos();
    const prevDom = this.dom.previousElementSibling as HTMLElement | null;
    if (pos === undefined || !prevDom) return;
    e.preventDefault();
    e.stopPropagation();
    const $pos = this.view.state.doc.resolve(pos);
    const set = $pos.parent;
    const index = $pos.index();
    if (!isColumnSet(set) || index < 1) return;
    const widths = scaledWidths(Array.from({ length: set.childCount }, (_, i) => columnWidth(set.child(i))));
    const sum = widths[index - 1]! + widths[index]!;
    const pxPerPct = (prevDom.getBoundingClientRect().width + this.dom.getBoundingClientRect().width) / sum;
    if (!(pxPerPct > 0)) return;
    const startX = e.clientX;
    let a = widths[index - 1]!;
    gutter.setPointerCapture(e.pointerId);
    this.dom.parentElement?.classList.add('columns-resizing');
    const move = (ev: PointerEvent) => {
      a = Math.round(Math.min(sum - 10, Math.max(10, widths[index - 1]! + (ev.clientX - startX) / pxPerPct)));
      this.flex(a, prevDom);
      this.flex(sum - a);
      gutter.dataset.widths = `${a}% · ${sum - a}%`;
    };
    const done = () => {
      gutter.removeEventListener('pointermove', move);
      gutter.removeEventListener('pointerup', done);
      gutter.removeEventListener('pointercancel', done);
      this.dom.parentElement?.classList.remove('columns-resizing');
      delete gutter.dataset.widths;
      const at = this.getPos();
      if (at === undefined || this.view.isDestroyed) return;
      const $at = this.view.state.doc.resolve(at);
      const now = $at.parent;
      if (!isColumnSet(now)) return;
      const setPos = $at.before();
      const next = widths.slice();
      next[index - 1] = a;
      next[index] = sum - a;
      const tr = this.view.state.tr;
      let p = setPos + 1;
      now.forEach((col, _o, i) => {
        if (next[i] !== columnWidth(col)) tr.setNodeMarkup(p, undefined, { ...col.attrs, attrs: withAttr(String(col.attrs.attrs), 'width', `${next[i]}%`) });
        p += col.nodeSize;
      });
      if (tr.docChanged) this.view.dispatch(tr);
      else {
        this.flex(columnWidth(now.child(index - 1)), prevDom);
        this.flex(columnWidth(now.child(index)));
      }
    };
    gutter.addEventListener('pointermove', move);
    gutter.addEventListener('pointerup', done);
    gutter.addEventListener('pointercancel', done);
  }

  update(node: PMNode): boolean {
    if (!isColumn(node)) return false;
    this.node = node;
    this.flex(columnWidth(node));
    return true;
  }

  stopEvent(e: Event): boolean {
    return !!this.gutter && this.gutter.contains(e.target as Node);
  }

  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return !this.contentDOM.contains(m.target);
  }
}

/** Fenced divs: columns side by side, conflict blocks as such (./conflicts.ts), any other as before. */
export function divViews(readOnly: boolean, ctx?: EditorContext): Record<string, NodeViewConstructor> {
  const others = conflictViews(readOnly, ctx)[DIV]!;
  return {
    [DIV]: (node, view, getPos, decorations, inner) => {
      if (isColumns(node)) return new ColumnsView();
      if (isColumn(node)) {
        const pos = getPos();
        const parent = pos === undefined ? null : view.state.doc.resolve(pos).parent;
        if (isColumns(parent)) return new ColumnView(node, view, getPos);
      }
      return others(node, view, getPos, decorations, inner);
    },
  };
}

// ---------------------------------------------------------------------------
// Dropping beside

export type Side = 'left' | 'right';

/** Where a drop would put columns: beside a block at the top level, a block in a column, or a set of columns. */
export interface DropTarget {
  /** The block dropped beside. */
  pos: number;
  node: PMNode;
  side: Side;
}

/** Blocks that are not dropped beside: the header, footnotes (kept at the end). */
const NOT_BESIDE = new Set(['front_matter', 'footnote_def']);

/**
 * The block a drop at a position would go beside: the innermost block at the
 * top level or straight inside a column (a set of columns is one too: beside it
 * is a column at its start or end).
 */
export function besideBlock(doc: PMNode, pos: number, inside: number): { pos: number; node: PMNode } | null {
  const candidates: { pos: number; node: PMNode }[] = [];
  const consider = (at: number) => {
    const $x = doc.resolve(at);
    for (let d = $x.depth; d >= 1; d--) {
      const parent = $x.node(d - 1);
      if (d === 1 || (isColumn(parent) && d >= 2 && isColumnSet($x.node(d - 2)))) {
        candidates.push({ pos: $x.before(d), node: $x.node(d) });
        return;
      }
    }
  };
  if (inside >= 0) {
    const node = doc.nodeAt(inside);
    const $i = doc.resolve(inside);
    if (node && node.isBlock && ($i.depth === 0 || (isColumn($i.parent) && $i.depth >= 1 && isColumnSet($i.node($i.depth - 1))))) candidates.push({ pos: inside, node });
    else if (node && !node.isLeaf) consider(inside + 1);
    else consider(inside);
  }
  if (!candidates.length) consider(pos);
  const found = candidates[0];
  return found && !NOT_BESIDE.has(found.node.type.name) ? found : null;
}

/** The blocks a dragged slice makes in a column: inline content (an image, a few words) in a paragraph of its own. */
function blocksOf(schema: Schema, slice: Slice): Fragment | null {
  const content = slice.content;
  if (!content.childCount) return null;
  if (content.firstChild!.isInline) return Fragment.from(schema.nodes.paragraph!.create(null, content));
  let fine = true;
  content.forEach((c) => { if (!c.isBlock || c.type.name === 'list_item' || c.type.spec.tableRole) fine = false; });
  return fine ? content : null;
}

/** Whether a slice holds columns (columns are not put in a column). */
function holdsColumns(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((n) => {
    if (isColumns(n)) found = true;
    return !found;
  });
  return found;
}

/** What is dragged, as a range to take away when it is moved: an image alone in its paragraph takes the paragraph with it. */
function draggedRange(state: EditorState): { from: number; to: number } {
  const sel = state.selection;
  if (sel instanceof NodeSelection && sel.node.type.name === 'image') {
    const $from = sel.$from;
    if (aloneImage($from.parent) === sel.node) return { from: $from.before(), to: $from.after() };
  }
  return { from: sel.from, to: sel.to };
}

/**
 * Put a slice beside a block: the two in columns (half the line each), or a
 * new column beside a column (the set's columns made even). Moved, it is taken
 * from where it was first. Null where it cannot go there.
 */
export function dropBeside(state: EditorState, slice: Slice, moved: boolean, target: DropTarget): Transaction | null {
  const schema = state.schema;
  const blocks = blocksOf(schema, slice);
  if (!blocks) return null;
  const inColumn = !isColumnSet(target.node) && isColumn(state.doc.resolve(target.pos).parent);
  if ((inColumn || isColumnSet(target.node)) && holdsColumns(slice)) return null;
  const tr = state.tr;
  if (moved) {
    const range = draggedRange(state);
    // Not beside itself (beside what holds it is fine: an image taken out of its paragraph, beside it).
    if (range.from <= target.pos && target.pos + target.node.nodeSize <= range.to) return null;
    tr.delete(range.from, range.to);
  }
  const at = tr.mapping.mapResult(target.pos, 1);
  if (at.deleted) return null;
  const node = tr.doc.nodeAt(at.pos);
  if (!node || node.type !== target.node.type) return null;
  const fresh = columnNode(schema, blocks, 50);
  if (!fresh) return null;
  let insertedAt: number;
  if (isColumnSet(node)) {
    // At the set's start or end.
    const cols: PMNode[] = [];
    node.forEach((c) => cols.push(c));
    if (target.side === 'left') cols.unshift(fresh);
    else cols.push(fresh);
    const widths = evenWidths(cols.length);
    tr.replaceWith(at.pos, at.pos + node.nodeSize, node.type.create(node.attrs, cols.map((c, i) => widened(c, widths[i]!)), node.marks));
    insertedAt = at.pos + 1 + (target.side === 'left' ? 0 : node.content.size);
  } else {
    const $at = tr.doc.resolve(at.pos);
    const column = $at.parent;
    if (isColumn(column) && isColumnSet($at.node($at.depth - 1))) {
      // A column of its own beside the column this block is in.
      const set = $at.node($at.depth - 1);
      const setPos = $at.before($at.depth);
      const index = $at.index($at.depth - 1);
      const cols: PMNode[] = [];
      set.forEach((c) => cols.push(c));
      const i = target.side === 'left' ? index : index + 1;
      cols.splice(i, 0, fresh);
      const widths = evenWidths(cols.length);
      tr.replaceWith(setPos, setPos + set.nodeSize, set.type.create(set.attrs, cols.map((c, j) => widened(c, widths[j]!)), set.marks));
      let p = setPos + 1;
      for (let j = 0; j < i; j++) p += widened(cols[j]!, widths[j]!).nodeSize;
      insertedAt = p;
    } else {
      const own = columnNode(schema, Fragment.from(node), 50);
      if (!own) return null;
      const pair = target.side === 'left' ? [fresh, own] : [own, fresh];
      tr.replaceWith(at.pos, at.pos + node.nodeSize, columnsNode(schema, pair));
      insertedAt = at.pos + 1 + (target.side === 'left' ? 0 : own.nodeSize);
    }
  }
  const $in = tr.doc.resolve(Math.min(insertedAt + 1, tr.doc.content.size));
  tr.setSelection(Selection.near($in));
  return tr.setMeta(columnsKey, 'drop').setMeta('uiEvent', 'drop').scrollIntoView();
}

/** Where on a block a pointer is: near enough its left or right edge to drop beside it (a fifth of it, at most 64 pixels). */
export function sideOf(x: number, rect: { left: number; right: number; width: number }): Side | null {
  const edge = Math.min(64, rect.width * 0.2);
  if (x < rect.left + edge) return 'left';
  if (x > rect.right - edge) return 'right';
  return null;
}

function targetAt(view: EditorView, e: DragEvent): (DropTarget & { rect: DOMRect }) | null {
  if (!view.dragging || !view.editable) return null;
  const at = view.posAtCoords({ left: e.clientX, top: e.clientY });
  if (!at) return null;
  const block = besideBlock(view.state.doc, at.pos, at.inside);
  if (!block) return null;
  const dom = view.nodeDOM(block.pos) as HTMLElement | null;
  if (!dom?.getBoundingClientRect) return null;
  const rect = dom.getBoundingClientRect();
  const side = sideOf(e.clientX, rect);
  if (!side) return null;
  if (view.dragging.move) {
    const range = draggedRange(view.state);
    if (range.from <= block.pos && block.pos + block.node.nodeSize <= range.to) return null;
  }
  return { ...block, side, rect };
}

// ---------------------------------------------------------------------------
// Keeping them tidy

const columnsKey = new PluginKey('columns');

/**
 * After each change: columns down to one are its content; after a drop, a
 * column it emptied goes (the rest widened to fill the line); and columns
 * last in the document have a paragraph after them, to write on below.
 */
export function tidyColumns(state: EditorState, dropped: boolean): Transaction | null {
  const found: { pos: number; node: PMNode }[] = [];
  state.doc.descendants((node, pos) => {
    if (isColumnSet(node)) {
      found.push({ pos, node });
      return false;
    }
    return node.isBlock && !node.isTextblock;
  });
  const tr = state.tr;
  for (const { pos, node } of found.reverse()) {
    const cols: PMNode[] = [];
    node.forEach((c) => cols.push(c));
    const keep = dropped ? cols.filter((c) => !isEmptyColumn(c)) : cols;
    if (keep.length === cols.length && keep.length > 1) continue;
    tr.replaceWith(pos, pos + node.nodeSize, rebuilt(state.schema, node, keep));
  }
  const last = tr.doc.lastChild;
  if (isColumns(last)) tr.insert(tr.doc.content.size, state.schema.nodes.paragraph!.create());
  return tr.docChanged ? tr : null;
}

/** The column the cursor is in, and the set it is in. */
function columnAt(state: EditorState): { col: PMNode; colPos: number; set: PMNode; setPos: number; index: number; depth: number } | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 2; d--) {
    const col = $from.node(d);
    const set = $from.node(d - 1);
    if (isColumn(col) && isColumnSet(set)) return { col, colPos: $from.before(d), set, setPos: $from.before(d - 1), index: $from.index(d - 1), depth: d };
  }
  return null;
}

/**
 * Backspace at the start of a column: an empty column goes (the cursor to the
 * end of the one before); an empty paragraph first in it goes; else nothing,
 * not joining across columns.
 */
export const columnBackspace: Command = (state, dispatch) => {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty || sel.$from.parentOffset > 0) return false;
  const at = columnAt(state);
  if (!at) return false;
  const { $from } = sel;
  // Only at the start of the column's first block (and of its first textblock).
  for (let d = $from.depth; d > at.depth; d--) if ($from.index(d - 1) !== 0) return false;
  if (dispatch) {
    const tr = state.tr;
    if (isEmptyColumn(at.col)) {
      const keep: PMNode[] = [];
      at.set.forEach((c, _o, i) => { if (i !== at.index) keep.push(c); });
      tr.replaceWith(at.setPos, at.setPos + at.set.nodeSize, rebuilt(state.schema, at.set, keep));
      const back = Math.max(0, at.index - 1);
      // The end of the column before (or the start of the next), wherever it now is.
      let target = at.setPos;
      const now = tr.doc.nodeAt(at.setPos);
      if (now && isColumnSet(now)) {
        let p = at.setPos + 1;
        for (let i = 0; i < back; i++) p += now.child(i).nodeSize;
        target = at.index > 0 ? p + now.child(back).nodeSize - 1 : p + 1;
        tr.setSelection(Selection.near(tr.doc.resolve(target), at.index > 0 ? -1 : 1));
      } else tr.setSelection(Selection.near(tr.doc.resolve(Math.min(target + 1, tr.doc.content.size))));
    } else {
      const first = at.col.firstChild!;
      if (first.type.name === 'paragraph' && first.content.size === 0 && at.col.childCount > 1) {
        tr.delete(at.colPos + 1, at.colPos + 1 + first.nodeSize);
        tr.setSelection(Selection.near(tr.doc.resolve(at.colPos + 1)));
      } else return true;
    }
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Enter on a line that is just a columns fence (`::: columns`, `:::: {.columns}`):
 * two empty columns, half the line each, the cursor in the first. Not in a column.
 */
export const columnsOnEnter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size) return false;
  if (!/^:{3,}[ \t]*(?:columns|\{\s*\.columns\s*\})[ \t]*:*$/.test($from.parent.textContent)) return false;
  // At the top level, or in a div (where Pandoc reads a div), never in a column.
  if ($from.depth > 1 && $from.node($from.depth - 1).type.name !== DIV) return false;
  for (let d = $from.depth - 1; d >= 1; d--) if (isColumn($from.node(d)) || isColumns($from.node(d))) return false;
  const schema = state.schema;
  const empty1 = columnNode(schema, Fragment.from(schema.nodes.paragraph!.create()), 50);
  const empty2 = columnNode(schema, Fragment.from(schema.nodes.paragraph!.create()), 50);
  if (!empty1 || !empty2) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith($from.before(), $from.after(), columnsNode(schema, [empty1, empty2]));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, $from.before() + 3)).scrollIntoView());
  }
  return true;
};

/** Delete at the end of a column's last block: nothing, not joining across columns. */
export const columnDelete: Command = (state) => {
  const sel = state.selection;
  if (!(sel instanceof TextSelection) || !sel.empty || sel.$from.parentOffset < sel.$from.parent.content.size) return false;
  const at = columnAt(state);
  if (!at) return false;
  const { $from } = sel;
  for (let d = $from.depth; d > at.depth; d--) if ($from.index(d - 1) !== $from.node(d - 1).childCount - 1) return false;
  return true;
};

/** Columns in the editor: drops beside a block, the line where one would go, and tidying after each change of one's own (others tidy theirs). */
export function columnsPlugin(ctx: Pick<EditorContext, 'isRemote'>): Plugin {
  let line: HTMLElement | null = null;
  const hide = () => line?.remove();
  return new Plugin({
    key: columnsKey,
    appendTransaction(trs, _old, state) {
      if (!trs.some((t) => t.docChanged && !ctx.isRemote(t))) return null;
      return tidyColumns(state, trs.some((t) => t.getMeta(columnsKey) === 'drop' || t.getMeta('uiEvent') === 'drop'));
    },
    view: () => ({ destroy: hide }),
    props: {
      handleDOMEvents: {
        dragover(view, e) {
          const target = targetAt(view, e);
          if (!target) {
            hide();
            return false;
          }
          line ??= Object.assign(document.createElement('div'), { className: 'column-drop' });
          line.dataset.testid = 'column-drop';
          const r = target.rect;
          Object.assign(line.style, { top: `${r.top}px`, height: `${r.height}px`, left: `${(target.side === 'left' ? r.left : r.right) - 2}px` });
          if (!line.isConnected) document.body.append(line);
          return false;
        },
        dragleave(view, e) {
          if (!view.dom.contains(e.relatedTarget as Node | null)) hide();
          return false;
        },
        dragend() {
          hide();
          return false;
        },
      },
      handleDrop(view, event, slice, moved) {
        hide();
        const target = targetAt(view, event as DragEvent);
        if (!target) return false;
        const tr = dropBeside(view.state, slice, moved, target);
        if (!tr) return false;
        event.preventDefault();
        view.dispatch(tr);
        view.focus();
        return true;
      },
    },
  });
}
