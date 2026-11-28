// Images placed and columns, as each format can have them (0130). pandoc keeps
// an image's width in every format, but not where an image alone on its line
// is placed (`fig-align`, Quarto's attribute: left, right, centred when none),
// nor columns (`:::: columns` holding `::: {.column width=40%}`), which it
// writes one after the other except in slides. So its tree is changed before it
// writes the format:
//
//   HTML, EPUB  each placed and side by side with inline styles (flex);
//   PDF         Typst: a figure under `#show figure: set align(…)`, an image
//               without a caption under `#align(…)`, columns a `#grid`;
//   Word        a paragraph style for each placement (made by pandoc, given its
//               alignment here, after: `alignWordStyles`), columns a table of
//               one row without borders, each cell a column's width.
type Attr = [string, string[], [string, string][]];
type Block = { t: string; c?: unknown };
export type LayoutFormat = 'html' | 'epub' | 'pdf' | 'docx';
type Align = 'left' | 'center' | 'right';

const kv = (a: Attr, key: string) => a[2].find(([k]) => k === key)?.[1] ?? null;
const percent = (v: string | null) => {
  const m = v ? /^(\d+(?:\.\d+)?)%$/.exec(v.trim()) : null;
  return m ? Number(m[1]) : null;
};

const isDiv = (b: Block, cls: string) => b.t === 'Div' && (b.c as [Attr, Block[]])[0][1].includes(cls);

/** Columns as written: a `columns` div holding nothing but `column` divs (at least one). */
function columnsOf(b: Block): { attr: Attr; columns: { attr: Attr; blocks: Block[] }[] } | null {
  if (!isDiv(b, 'columns')) return null;
  const [attr, inner] = b.c as [Attr, Block[]];
  if (!inner.length || !inner.every((x) => isDiv(x, 'column'))) return null;
  return { attr, columns: inner.map((x) => { const [a, bs] = x.c as [Attr, Block[]]; return { attr: a, blocks: bs }; }) };
}

/** Widths for the columns, as shares adding up to 100 (one with none, an even share). */
function widthsOf(columns: { attr: Attr }[]): number[] {
  const even = 100 / columns.length;
  const known = columns.map((c) => percent(kv(c.attr, 'width')) ?? even);
  const sum = known.reduce((a, b) => a + b, 0) || 1;
  return known.map((w) => (w / sum) * 100);
}

/** The image alone in a paragraph or a figure, if that is what a block is. */
function aloneImage(b: Block): { attr: Attr } | null {
  const image = (inlines: Block[]) => {
    const real = inlines.filter((i) => i.t !== 'Space' && i.t !== 'SoftBreak');
    return real.length === 1 && real[0]!.t === 'Image' ? { attr: (real[0]!.c as [Attr])[0] } : null;
  };
  if (b.t === 'Para' || b.t === 'Plain') return image(b.c as Block[]);
  if (b.t === 'Figure') {
    const body = (b.c as [Attr, unknown, Block[]])[2];
    return body.length === 1 && (body[0]!.t === 'Plain' || body[0]!.t === 'Para') ? image(body[0]!.c as Block[]) : null;
  }
  return null;
}

const alignOf = (attr: Attr): Align => {
  const v = kv(attr, 'fig-align');
  return v === 'left' || v === 'right' ? v : 'center';
};

const raw = (format: string, text: string): Block => ({ t: 'RawBlock', c: [format, text] });
const div = (attr: Attr, blocks: Block[]): Block => ({ t: 'Div', c: [attr, blocks] });
const withKv = (a: Attr, key: string, value: string | null): Attr => [a[0], a[1], [...a[2].filter(([k]) => k !== key), ...(value === null ? [] : [[key, value] as [string, string]])]];
const typstLength = (n: number) => `${Math.round(n * 100) / 100}fr`;

/** Word's paragraph styles for each placement, by name (pandoc names their ids without the spaces). */
export const WORD_STYLES: Record<string, { align: Align; caption?: boolean }> = {
  'Image Left': { align: 'left' },
  'Image Centre': { align: 'center' },
  'Image Right': { align: 'right' },
  'Image Caption Left': { align: 'left', caption: true },
  'Image Caption Right': { align: 'right', caption: true },
};

/** A block placed and laid out for the format, as one or more blocks. */
function block(b: Block, format: LayoutFormat): Block[] {
  const cols = columnsOf(b);
  if (cols) return columns(cols, format);
  if (b.t === 'Div') {
    const [attr, inner] = b.c as [Attr, Block[]];
    return [div(attr, blocks(inner, format))];
  }
  if (b.t === 'BlockQuote') return [{ t: 'BlockQuote', c: blocks(b.c as Block[], format) }];
  const image = aloneImage(b);
  if (image && (b.t === 'Para' || b.t === 'Figure')) return placed(b, alignOf(image.attr), format);
  return [b];
}

function blocks(list: Block[], format: LayoutFormat): Block[] {
  return list.flatMap((b) => block(b, format));
}

/** An image alone on its line (a figure, or a paragraph of it alone) placed as it says. */
function placed(b: Block, align: Align, format: LayoutFormat): Block[] {
  const figure = b.t === 'Figure';
  if (format === 'html' || format === 'epub') {
    if (figure) {
      const c = b.c as [Attr, unknown, Block[]];
      return [{ t: 'Figure', c: [withKv(c[0], 'style', `text-align:${align};margin-left:0;margin-right:0`), c[1], c[2]] }];
    }
    return [div(['', [], [['style', `text-align:${align}`]]], [b])];
  }
  if (format === 'pdf') {
    // Typst centres a figure itself, and puts an image without a caption in the line.
    if (figure) return align === 'center' ? [b] : [raw('typst', `#[#show figure: set align(${align})`), b, raw('typst', ']')];
    return align === 'left' ? [b] : [raw('typst', `#align(${align})[`), b, raw('typst', ']')];
  }
  // Word: pandoc centres a figure (in a table of its own) and puts an image without a caption at the left.
  if (figure) {
    if (align === 'center') return [b];
    const [, caption, body] = b.c as [Attr, [unknown, Block[]], Block[]];
    const image = { t: 'Para', c: body[0]!.c } as Block;
    const said = caption[1] ?? [];
    const name = align === 'left' ? 'Left' : 'Right';
    return [
      div(['', [], [['custom-style', `Image ${name}`]]], [image]),
      ...(said.length ? [div(['', [], [['custom-style', `Image Caption ${name}`]]], said.map((x) => (x.t === 'Plain' ? { t: 'Para', c: x.c } : x)))] : []),
    ];
  }
  return align === 'left' ? [b] : [div(['', [], [['custom-style', align === 'right' ? 'Image Right' : 'Image Centre']]], [b])];
}

/** Columns side by side, each its share of the line. */
function columns(set: NonNullable<ReturnType<typeof columnsOf>>, format: LayoutFormat): Block[] {
  const widths = widthsOf(set.columns);
  const inner = set.columns.map((c) => blocks(c.blocks, format));
  if (format === 'html' || format === 'epub') {
    return [div(withKv(set.attr, 'style', 'display:flex;gap:1.5em;align-items:flex-start'), set.columns.map((c, i) =>
      div(withKv(withKv(c.attr, 'width', null), 'style', `flex:${Math.round(widths[i]! * 100) / 100} 1 0;min-width:0`), inner[i]!)))];
  }
  if (format === 'pdf') {
    const out: Block[] = [raw('typst', `#grid(columns: (${widths.map(typstLength).join(', ')}), column-gutter: 1.5em,`)];
    inner.forEach((bs) => out.push(raw('typst', '['), ...bs, raw('typst', '],')));
    out.push(raw('typst', ')'));
    return out;
  }
  // Word: a table of one row, no header (so no rule under it), each cell a column. Word takes an
  // image's percentage of the page, not of its cell, so each image in a column is given its share of
  // the column (less the cell's margins); one that says no width, the column's (as the editor shows
  // it, no wider than its column).
  inner.forEach((bs, i) => scaleImages(bs, widths[i]!));
  const none: Attr = ['', [], []];
  const cell = (bs: Block[]) => [none, { t: 'AlignDefault' }, 1, 1, bs.length ? bs : [{ t: 'Plain', c: [] }]];
  return [{
    t: 'Table',
    c: [
      set.attr,
      [null, []],
      widths.map((w) => [{ t: 'AlignDefault' }, { t: 'ColWidth', c: w / 100 }]),
      [none, []],
      [[none, 0, [], [[none, inner.map(cell)]]]],
      [none, []],
    ],
  }];
}

/** A cell's margins in Word (108 twentieths of a point each side, of a page's text about 9360 wide), as a share of it. */
const CELL_MARGINS = 0.977;

/** Every image in some blocks given its width as a share of the page, for a column `share` percent of it. */
function scaleImages(list: unknown, share: number): void {
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') {
      const n = v as Block;
      if (n.t === 'Image') {
        const c = n.c as [Attr, ...unknown[]];
        const own = percent(kv(c[0], 'width'));
        if (kv(c[0], 'width') === null || own !== null) {
          const pct = Math.round((own ?? 100) * (share / 100) * CELL_MARGINS * 10) / 10;
          c[0] = withKv(c[0], 'width', `${pct}%`);
        }
        return;
      }
      Object.values(n).forEach(walk);
    }
  };
  walk(list);
}

/** pandoc's tree with images placed and columns laid out for the format. */
export function layOut(tree: { blocks?: Block[] }, format: LayoutFormat): void {
  if (Array.isArray(tree.blocks)) tree.blocks = blocks(tree.blocks, format);
}

/**
 * Word's styles.xml with the placement styles pandoc made (each a plain
 * paragraph style, as it makes one it does not know) given their alignment, a
 * caption's style based on pandoc's own; one a reference document already
 * aligns is left as it is.
 */
export function alignWordStyles(styles: string): string {
  let out = styles;
  for (const [name, { align, caption }] of Object.entries(WORD_STYLES)) {
    const id = name.replace(/\s+/g, '');
    const re = new RegExp(`<w:style\\b[^>]*w:styleId="${id}"[^>]*>[\\s\\S]*?</w:style>`);
    const found = re.exec(out);
    if (!found || /<w:jc\b/.test(found[0])) continue;
    const jc = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
    const style = `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${id}"><w:name w:val="${name}" />`
      + `<w:basedOn w:val="${caption ? 'ImageCaption' : 'Figure'}" />${caption ? '' : '<w:next w:val="BodyText" />'}`
      + `<w:qFormat /><w:pPr>${caption ? '' : '<w:keepNext />'}<w:jc w:val="${jc}" /></w:pPr></w:style>`;
    out = out.replace(found[0], style);
  }
  return out;
}
