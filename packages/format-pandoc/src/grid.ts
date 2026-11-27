// Pandoc's grid tables (decision 0102), as far as a table of the editor goes:
// one header row, then rows of cells, each cell a paragraph whose lines may
// break. Read: the cells' text, each column's width (its dashes) and alignment;
// anything more (cells spanning rows or columns, no header, a footer) is not
// read, and the table stays as it is written. Written: each cell's lines in its
// column, every column as wide as its widest line, or as it was written if
// wider, so the widths a writer chose (which Pandoc makes the columns' relative
// widths) are kept.
//
// Columns are counted as Pandoc counts them: a character of East Asian scripts
// (or an emoji) is two wide, a combining mark none.

/** A grid table read from its text. */
export interface Grid {
  /** Each column's width between its `+`s (padding included). */
  widths: number[];
  /** A letter per column: l, c, r, or - (none). */
  align: string;
  /** The header row, then the body's rows: each cell's text, its lines joined by newlines, the padding taken off. */
  rows: string[][];
}

const WIDE = /[\u1100-\u115F\u231A\u231B\u2329\u232A\u23E9-\u23EC\u23F0\u23F3\u25FD\u25FE\u2614\u2615\u2648-\u2653\u267F\u2693\u26A1\u26AA\u26AB\u26BD\u26BE\u26C4\u26C5\u26CE\u26D4\u26EA\u26F2\u26F3\u26F5\u26FA\u26FD\u2705\u270A\u270B\u2728\u274C\u274E\u2753-\u2755\u2757\u2795-\u2797\u27B0\u27BF\u2B1B\u2B1C\u2B50\u2B55\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE10-\uFE19\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6\u{1F004}\u{1F0CF}\u{1F18E}\u{1F191}-\u{1F19A}\u{1F200}-\u{1F251}\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;
// Variation selectors are marks (\p{M}) too.
const ZERO = /\p{M}|[\u200B-\u200F\u2060\uFEFF]/u;

/** How many columns a character takes. */
function charWidth(ch: string): number {
  if (ZERO.test(ch)) return 0;
  return WIDE.test(ch) ? 2 : 1;
}

/** How many columns text takes, as Pandoc counts them. */
export function displayWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch);
  return w;
}

/** Text padded with spaces to a width. */
const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - displayWidth(text)));

const BORDER = /^\+(?:[-=:]+\+)+$/;

/** The columns of a line at which each `+` or `|` of the first line's falls: the text between them, or null if one is not there. */
function cellsOf(line: string, bounds: number[], edge: string): string[] | null {
  const cells: string[] = [];
  let col = 0;
  let b = 0;
  let from = -1;
  let i = 0;
  for (const ch of line) {
    if (col === bounds[b]) {
      if (ch !== edge && !(edge === '+' && ch === '+')) return null;
      if (from >= 0) cells.push(line.slice(from, i));
      from = i + ch.length;
      b++;
    } else if (b < bounds.length && col > bounds[b]!) return null;
    col += charWidth(ch);
    i += ch.length;
  }
  return b === bounds.length && from === line.length ? cells : null;
}

/** A cell's lines as text: the padding and the space after taken off, the indent they share taken away. */
function cellText(lines: string[]): string {
  const trimmed = lines.map((l) => l.replace(/\s+$/, ''));
  const indents = trimmed.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length);
  const cut = indents.length ? Math.min(...indents) : 0;
  const text = trimmed.map((l) => l.slice(cut)).join('\n');
  return text.replace(/^\n+|\n+$/g, '');
}

/** A grid table's columns and cells; null if it is not one the editor can hold (see above). */
export function readGrid(src: string): Grid | null {
  const lines = src.replace(/\n+$/, '').split('\n').map((l) => l.replace(/[ \t]+$/, ''));
  const first = lines[0];
  if (!first || !BORDER.test(first) || /[=:]/.test(first) || lines.length < 3) return null;
  // Where the `+`s are: the columns' edges.
  const bounds: number[] = [];
  for (let i = 0; i < first.length; i++) if (first[i] === '+') bounds.push(i);
  const widths = bounds.slice(1).map((b, i) => b - bounds[i]! - 1);
  const rows: string[][] = [];
  let lineBuf: string[][] = [];
  let headerEnd = -1;
  let align = '';
  for (let k = 1; k < lines.length; k++) {
    const line = lines[k]!;
    if (line.startsWith('+')) {
      // A border: whole, under every column (not a cell spanning rows), all `-` or all `=`.
      const segs = line.length === first.length ? cellsOf(line, bounds, '+') : null;
      if (!segs || !(segs.every((x) => /^:?-+:?$/.test(x)) || segs.every((x) => /^:?=+:?$/.test(x)))) return null;
      const header = /=/.test(line);
      // A border with `=` only once, just after the first row: the header's.
      if (header && (headerEnd >= 0 || rows.length !== 0)) return null;
      if (!header && /:/.test(line)) return null;
      if (!lineBuf.length) return null; // no row between two borders
      rows.push(widths.map((_, c) => cellText(lineBuf.map((cells) => cells[c]!.replace(/^ /, '')))));
      lineBuf = [];
      if (header) {
        headerEnd = rows.length;
        align = segs.map((seg) => (seg.startsWith(':') && seg.endsWith(':') ? 'c' : seg.startsWith(':') ? 'l' : seg.endsWith(':') ? 'r' : '-')).join('');
      }
      continue;
    }
    if (!line.startsWith('|')) return null;
    const cells = cellsOf(line, bounds, '|');
    if (!cells) return null;
    lineBuf.push(cells);
  }
  // It ends with a border, and has exactly one header row.
  if (lineBuf.length || headerEnd !== 1 || rows.length < 2) return null;
  return { widths, align, rows };
}

/**
 * A grid table: rows of cells, each its lines as markdown, the first row the
 * header; each column at least as wide as `widths` says (padding included).
 */
export function writeGrid(rows: string[][], align: string, widths: number[] = []): string {
  const cols = Math.max(1, ...rows.map((r) => r.length));
  const cellLines = rows.map((r) => Array.from({ length: cols }, (_, c) => (r[c] ?? '').split('\n')));
  const inner = Array.from({ length: cols }, (_, c) => Math.max(
    3,
    widths[c] ?? 0,
    ...cellLines.map((r) => Math.max(...r[c]!.map(displayWidth)) + 2),
  ));
  const border = (ch: string) => `+${inner.map((w) => ch.repeat(w)).join('+')}+`;
  const headerBorder = `+${inner.map((w, c) => {
    const a = align[c];
    if (a === 'l') return `:${'='.repeat(w - 1)}`;
    if (a === 'r') return `${'='.repeat(w - 1)}:`;
    if (a === 'c') return `:${'='.repeat(w - 2)}:`;
    return '='.repeat(w);
  }).join('+')}+`;
  const row = (cells: string[][]) => {
    const height = Math.max(1, ...cells.map((l) => l.length));
    return Array.from({ length: height }, (_, k) => `|${cells.map((l, c) => ` ${pad(l[k] ?? '', inner[c]! - 2)} `).join('|')}|`).join('\n');
  };
  const [head = [], ...body] = cellLines;
  return [border('-'), row(head), headerBorder, ...body.flatMap((r) => [row(r), border('-')])].join('\n');
}
