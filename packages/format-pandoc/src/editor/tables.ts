// Tables in the editor: a header row and then rows of cells, written as pipe
// tables, or as grid tables where a cell has lines (Shift+Enter breaks one) or
// the table was read from one (0102).
//
// `| a | b |` then Enter makes a table with those headings and an empty row to
// type in; Insert table (in the menu) makes an empty one. In a table, Tab and
// Shift+Tab move between cells (Tab in the last makes a row), Enter moves down
// (making a row at the bottom), and ⌘Enter leaves the table. Right-click a cell
// (or Shift+F10) for rows and columns: add above, below, left or right, or delete;
// right-clicking a misspelled word, its spelling suggestions first, where the
// page can ask the spell checker (the desktop app), as the menu it takes the
// place of would have had them. ⌥⌘T (or Insert table) makes an empty table.
//
// Every change rebuilds the table, so the first row is always the header and the
// alignment keeps one letter per column; each is an ordinary edit.
import type { EditorContext, Spelling } from '@kuraa/editor-kit';
import type { Fragment, Node as PMNode, NodeType, Schema } from 'prosemirror-model';
import { Plugin, Selection, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

interface CellAt {
  table: PMNode;
  /** Where the table starts. */
  pos: number;
  row: number;
  col: number;
}

/** The table cell the cursor is in, if any. */
export function cellAt(state: EditorState): CellAt | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 1; d--) {
    if ($from.node(d).type.name === 'table_cell' && $from.node(d - 2).type.name === 'table') {
      return { table: $from.node(d - 2), pos: $from.before(d - 2), row: $from.index(d - 2), col: $from.index(d - 1) };
    }
  }
  return null;
}

type Grid = Fragment[][];
/** Rows of cell contents; null for an empty cell. */
type Cells = (Fragment | PMNode | null)[][];

function gridOf(table: PMNode): Grid {
  const rows: Grid = [];
  table.forEach((row) => {
    const cells: Fragment[] = [];
    row.forEach((cell) => cells.push(cell.content));
    rows.push(cells);
  });
  return rows;
}

/** A table from rows of cell contents: the first row the header, every row as wide as the widest. */
export function buildTable(schema: Schema, grid: Cells, attrs: Record<string, unknown> = {}): PMNode {
  const n = schema.nodes;
  const cols = Math.max(1, ...grid.map((r) => r.length));
  const rows = grid.map((cells, r) =>
    n.table_row!.create(null, Array.from({ length: cols }, (_, c) => n.table_cell!.create({ header: r === 0 }, cells[c] ?? null))),
  );
  const align = String(attrs.align ?? '');
  return n.table!.create({ ...attrs, align: Array.from({ length: cols }, (_, c) => align[c] || '-').join('') }, rows);
}

/** Replace the table and put the cursor in a cell of the new one (its end, or its start). */
function replaceTable(state: EditorState, at: CellAt, table: PMNode, row: number, col: number, end = true) {
  const tr = state.tr.replaceWith(at.pos, at.pos + at.table.nodeSize, table);
  return tr.setSelection(cellSelection(tr.doc, at.pos, row, col, end)).scrollIntoView();
}

function cellSelection(doc: PMNode, tablePos: number, row: number, col: number, end = true): Selection {
  const table = doc.nodeAt(tablePos)!;
  let pos = tablePos + 1;
  for (let r = 0; r < row; r++) pos += table.child(r).nodeSize;
  const rowNode = table.child(row);
  pos += 1;
  for (let c = 0; c < col; c++) pos += rowNode.child(c).nodeSize;
  const cell = rowNode.child(col);
  return TextSelection.create(doc, pos + 1 + (end ? cell.content.size : 0));
}

const withTable = (fn: (state: EditorState, at: CellAt) => ReturnType<typeof replaceTable> | null): Command => (state, dispatch) => {
  const at = cellAt(state);
  if (!at) return false;
  const tr = fn(state, at);
  if (!tr) return false;
  dispatch?.(tr);
  return true;
};

const alignOf = (t: PMNode) => String(t.attrs.align ?? '');

/** A grid table's columns' widths (0102) with a column put in at `at` (its width to be found from its text), or taken out; '' kept. */
function widthsWith(t: PMNode, change: { add: number } | { remove: number }): string {
  const widths = String(t.attrs.widths ?? '').split(' ').filter(Boolean);
  if (!widths.length) return '';
  if ('add' in change) widths.splice(change.add, 0, '3');
  else widths.splice(change.remove, 1);
  return widths.join(' ');
}

export const addRow = (below: boolean): Command => withTable((state, at) => {
  const grid: Cells = gridOf(at.table);
  const r = below ? at.row + 1 : at.row;
  grid.splice(r, 0, []);
  return replaceTable(state, at, buildTable(state.schema, grid, at.table.attrs), r, at.col);
});

export const addColumn = (right: boolean): Command => withTable((state, at) => {
  const c = right ? at.col + 1 : at.col;
  const grid: Cells = gridOf(at.table).map((cells) => [...cells.slice(0, c), null, ...cells.slice(c)]);
  const align = alignOf(at.table).padEnd(at.table.firstChild!.childCount, '-');
  return replaceTable(state, at, buildTable(state.schema, grid, { ...at.table.attrs, align: align.slice(0, c) + '-' + align.slice(c), widths: widthsWith(at.table, { add: c }) }), at.row, c);
});

export const deleteTable: Command = withTable((state, at) => {
  const tr = state.tr.delete(at.pos, at.pos + at.table.nodeSize);
  return tr.setSelection(Selection.near(tr.doc.resolve(Math.min(at.pos, tr.doc.content.size)))).scrollIntoView();
});

export const deleteRow: Command = (state, dispatch, view) => {
  const at = cellAt(state);
  if (!at) return false;
  if (at.table.childCount === 1) return deleteTable(state, dispatch, view);
  const grid = gridOf(at.table);
  grid.splice(at.row, 1);
  dispatch?.(replaceTable(state, at, buildTable(state.schema, grid, at.table.attrs), Math.min(at.row, grid.length - 1), at.col));
  return true;
};

export const deleteColumn: Command = (state, dispatch, view) => {
  const at = cellAt(state);
  if (!at) return false;
  if (at.table.firstChild!.childCount === 1) return deleteTable(state, dispatch, view);
  const grid = gridOf(at.table).map((cells) => cells.filter((_, c) => c !== at.col));
  const align = alignOf(at.table);
  const table = buildTable(state.schema, grid, { ...at.table.attrs, align: align.slice(0, at.col) + align.slice(at.col + 1), widths: widthsWith(at.table, { remove: at.col }) });
  dispatch?.(replaceTable(state, at, table, at.row, Math.min(at.col, table.firstChild!.childCount - 1)));
  return true;
};

/** Tab: the next cell, or a new row after the last; Shift+Tab: the previous cell. */
export const goToCell = (dir: 1 | -1): Command => (state, dispatch) => {
  const at = cellAt(state);
  if (!at) return false;
  const cols = at.table.child(at.row).childCount;
  let row = at.row;
  let col = at.col + dir;
  if (col >= cols) {
    row++;
    col = 0;
  } else if (col < 0) {
    row--;
    col = at.table.child(Math.max(0, row)).childCount - 1;
  }
  if (row < 0) return true; // the first cell: stay
  if (row >= at.table.childCount) return addRow(true)(state, (tr) => dispatch?.(tr.setSelection(cellSelection(tr.doc, at.pos, row, 0)))) || true;
  dispatch?.(state.tr.setSelection(cellSelection(state.doc, at.pos, row, col)).scrollIntoView());
  return true;
};

/** Enter: the cell below, making a row at the bottom. */
const cellBelow: Command = (state, dispatch) => {
  const at = cellAt(state);
  if (!at) return false;
  if (at.row + 1 < at.table.childCount) {
    dispatch?.(state.tr.setSelection(cellSelection(state.doc, at.pos, at.row + 1, Math.min(at.col, at.table.child(at.row + 1).childCount - 1))).scrollIntoView());
    return true;
  }
  return addRow(true)(state, dispatch);
};

/** ⌘Enter: out of the table, into a paragraph after it. */
const leaveTable: Command = (state, dispatch) => {
  const at = cellAt(state);
  if (!at) return false;
  const after = at.pos + at.table.nodeSize;
  const next = state.doc.resolve(after).nodeAfter;
  if (dispatch) {
    if (next?.isTextblock) dispatch(state.tr.setSelection(TextSelection.create(state.doc, after + 1)).scrollIntoView());
    else {
      const tr = state.tr.insert(after, state.schema.nodes.paragraph!.create());
      dispatch(tr.setSelection(TextSelection.create(tr.doc, after + 1)).scrollIntoView());
    }
  }
  return true;
};

/** The cells of a typed header line, `| a | b |`; null if it is not one. */
export function headerCells(line: string): string[] | null {
  const m = /^\s*\|(.*)\|\s*$/.exec(line);
  if (!m) return null;
  const cells: string[] = [];
  let cur = '';
  const inner = m[1]!;
  for (let i = 0; i < inner.length; i++) {
    if (inner[i] === '\\' && inner[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (inner[i] === '|') {
      cells.push(cur.trim());
      cur = '';
    } else cur += inner[i];
  }
  cells.push(cur.trim());
  return cells.length >= 1 && cells.some((c) => c !== '') ? cells : null;
}

/**
 * A table with `headings` (empty ones if not given) and one empty row, in place
 * of the block the cursor is in if `replace`, else after it (in place of an
 * empty paragraph). The cursor goes to the first cell to type in.
 */
function placeTable(headings: string[] | undefined, replace: boolean): Command {
  return (state, dispatch) => {
    const n = state.schema.nodes;
    if (!n.table || !n.table_row || !n.table_cell || cellAt(state)) return false;
    const { $from } = state.selection;
    // The innermost block whose parent may hold a table: the page, a list item, a quote.
    let d = $from.depth;
    while (d > 0 && !$from.node(d - 1).type.contentMatch.matchType(n.table) && !canHold($from.node(d - 1).type, n.table)) d--;
    if (d === 0) return false;
    const cols = headings?.length ?? 2;
    const head = Array.from({ length: cols }, (_, i) => (headings?.[i] ? state.schema.text(headings[i]!) : null));
    const table = buildTable(state.schema, [head, []]);
    if (!dispatch) return true;
    const block = $from.node(d);
    const inPlace = replace || (block.isTextblock && block.content.size === 0);
    const from = inPlace ? $from.before(d) : $from.after(d);
    const tr = state.tr.replaceWith(from, inPlace ? $from.after(d) : from, table);
    dispatch(tr.setSelection(cellSelection(tr.doc, from, headings ? 1 : 0, 0, false)).scrollIntoView());
    return true;
  };
}

/** Whether a block of this type may hold a table among its blocks. */
function canHold(parent: NodeType, table: NodeType): boolean {
  return parent.spec.content?.includes('block') === true && table.isInGroup('block');
}

/** Insert table: an empty one, after the block the cursor is in. */
export const insertTable: Command = placeTable(undefined, false);

/** `| a | b |` then Enter: a table with those headings. */
const tableOnEnter: Command = (state, dispatch, view) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type.name !== 'paragraph' || $from.parentOffset !== $from.parent.content.size) return false;
  let plain = true;
  $from.parent.forEach((c) => {
    if (!c.isText) plain = false;
  });
  const cells = plain ? headerCells($from.parent.textContent) : null;
  return cells ? placeTable(cells, true)(state, dispatch, view) : false;
};

export function tableKeys(): Record<string, Command> {
  return {
    Tab: goToCell(1),
    'Shift-Tab': goToCell(-1),
    'Mod-Enter': leaveTable,
    'Shift-F10': (state, _dispatch, view) => {
      if (!view || !cellAt(state)) return false;
      const at = view.coordsAtPos(state.selection.from);
      openTableMenu(view, at.left, at.bottom);
      return true;
    },
  };
}

/** Commands for Enter: a typed header line makes a table; in a table, the cell below. */
export const tableEnter: Command[] = [tableOnEnter, cellBelow];

// ---------------------------------------------------------------------------
// The right-click menu

const MENU: { label: string; testid: string; run: Command; danger?: boolean }[] = [
  { label: 'Add a row above', testid: 'table:row-above', run: addRow(false) },
  { label: 'Add a row below', testid: 'table:row-below', run: addRow(true) },
  { label: 'Add a column to the left', testid: 'table:column-left', run: addColumn(false) },
  { label: 'Add a column to the right', testid: 'table:column-right', run: addColumn(true) },
  { label: 'Delete the row', testid: 'table:delete-row', run: deleteRow, danger: true },
  { label: 'Delete the column', testid: 'table:delete-column', run: deleteColumn, danger: true },
  { label: 'Delete the table', testid: 'table:delete', run: deleteTable, danger: true },
];

interface MenuItem { label: string; testid: string; run?: () => void; danger?: boolean; divided?: boolean }

/** The word at a place in the text (letters, with apostrophes and hyphens inside it), and where it is; null if none. */
export function wordAt(doc: PMNode, pos: number): { word: string; from: number; to: number } | null {
  const $pos = doc.resolve(pos);
  const parent = $pos.parent;
  if (!parent.isTextblock) return null;
  // The text node the place is in or at the edge of.
  let found: { text: string; start: number } | null = null;
  parent.forEach((child, offset) => {
    if (found || !child.isText) return;
    const start = $pos.start() + offset;
    if (start <= pos && pos <= start + child.nodeSize) found = { text: child.text!, start };
  });
  if (!found) return null;
  const { text, start } = found as { text: string; start: number };
  const letter = /[\p{L}\p{M}'’-]/u;
  let a = pos - start;
  let b = a;
  while (a > 0 && letter.test(text[a - 1]!)) a--;
  while (b < text.length && letter.test(text[b]!)) b++;
  // Not ending or starting with an apostrophe or hyphen ('quoted', -dash).
  while (a < b && /['’-]/.test(text[a]!)) a++;
  while (b > a && /['’-]/.test(text[b - 1]!)) b--;
  if (a === b || !/\p{L}/u.test(text.slice(a, b))) return null;
  return { word: text.slice(a, b), from: start + a, to: start + b };
}

/** A misspelled word's lines for the menu: its suggestions (each replacing it), then Add to Dictionary. None if it is spelled right, or the spell checker cannot be asked. */
async function spellingItems(view: EditorView, spelling: Spelling | undefined, at: number): Promise<MenuItem[]> {
  const found = spelling ? wordAt(view.state.doc, at) : null;
  const suggestions = found ? await Promise.resolve(spelling!.suggest(found.word)).catch(() => null) : null;
  if (!found || !suggestions) return [];
  const { word, from, to } = found;
  const replace = (by: string) => () => {
    // Only if the word is still there (someone else may have changed the cell meanwhile).
    if (view.state.doc.textBetween(from, to) !== word) return;
    view.dispatch(view.state.tr.insertText(by, from, to).scrollIntoView());
  };
  return [
    ...suggestions.map((s, i) => ({ label: s, testid: `spelling:${i}`, run: replace(s) })),
    ...(suggestions.length ? [] : [{ label: 'No suggestions', testid: 'spelling:none' }]),
    { label: 'Add to Dictionary', testid: 'spelling:learn', run: () => spelling!.learn(word) },
  ];
}

function openTableMenu(view: EditorView, x: number, y: number, before: MenuItem[] = []): void {
  document.querySelector('.table-menu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'context-menu table-menu';
  menu.setAttribute('role', 'menu');
  menu.dataset.testid = 'table-menu';
  const close = () => {
    menu.remove();
    window.removeEventListener('mousedown', outside, true);
    window.removeEventListener('scroll', close, true);
    window.removeEventListener('blur', close);
  };
  const outside = (e: Event) => {
    if (!menu.contains(e.target as Node)) close();
  };
  const items: MenuItem[] = [
    ...before,
    ...MENU.map((item, i) => ({ ...item, divided: i === 0 && before.length > 0, run: () => item.run(view.state, view.dispatch, view) })),
  ];
  for (const item of items) {
    if (item.divided) {
      const line = document.createElement('div');
      line.className = 'context-divider';
      line.setAttribute('role', 'separator');
      menu.append(line);
    }
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'menuitem');
    b.textContent = item.label;
    b.dataset.testid = item.testid;
    if (item.danger) b.className = 'danger';
    if (!item.run) b.disabled = true;
    b.addEventListener('click', () => {
      close();
      view.focus();
      item.run?.();
    });
    menu.append(b);
  }
  menu.addEventListener('keydown', (e) => {
    const buttons = [...menu.querySelectorAll('button')].filter((b) => !b.disabled);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      view.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i + (e.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    }
  });
  document.body.append(menu);
  const box = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - box.width - 4))}px`;
  menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - box.height - 4))}px`;
  menu.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
  window.addEventListener('mousedown', outside, true);
  window.addEventListener('scroll', close, true);
  window.addEventListener('blur', close);
}

/** Right-click in a table: put the cursor there and offer its rows and columns (a misspelled word's suggestions first). */
export function tablePlugins(ctx?: EditorContext): Plugin[] {
  return [
    new Plugin({
      props: {
        handleDOMEvents: {
          contextmenu(view, e) {
            if (!view.editable || !(e.target as HTMLElement).closest?.('td, th')) return false;
            const hit = view.posAtCoords({ left: e.clientX, top: e.clientY });
            if (!hit) return false;
            const sel = TextSelection.near(view.state.doc.resolve(hit.pos));
            const state = view.state.apply(view.state.tr.setSelection(sel));
            if (!cellAt(state)) return false;
            e.preventDefault();
            view.dispatch(view.state.tr.setSelection(sel));
            // Once the spell checker has answered: at once in the Electron app, a moment later in the Tauri app.
            const { clientX, clientY } = e;
            void spellingItems(view, ctx?.ui.spelling, hit.pos).then((before) => openTableMenu(view, clientX, clientY, before));
            return true;
          },
        },
      },
    }),
  ];
}

