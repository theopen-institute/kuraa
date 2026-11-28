// Pandoc's attributes as the file has them: `{#id .class key=value key="a b"}`
// after an image, a heading or a div's fence (a div's may be a bare word,
// `::: columns`, its one class). Read into their parts and written back, so one
// part can be changed (an image's width, a column's) and the rest kept as it was.

export interface PandocAttrs {
  id: string;
  classes: string[];
  /** Keys and values, in order. */
  kv: [string, string][];
}

const EMPTY = (): PandocAttrs => ({ id: '', classes: [], kv: [] });

/** The parts of attribute text: `{…}`, a div's bare word, or nothing. Anything it cannot read is left out. */
export function parseAttrs(raw: string): PandocAttrs {
  const out = EMPTY();
  const text = raw.trim();
  if (!text) return out;
  if (!text.startsWith('{')) {
    out.classes.push(text);
    return out;
  }
  const body = text.replace(/^\{/, '').replace(/\}$/, '');
  const re = /\s*(?:#([^\s{}.#=]+)|\.([^\s{}.#=]+)|([^\s{}"'=]+)=(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s{}"']*)))/y;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[1] !== undefined) out.id = m[1];
    else if (m[2] !== undefined) out.classes.push(m[2]);
    else if (m[3] !== undefined) {
      const quoted = m[4] ?? m[5];
      out.kv.push([m[3], quoted !== undefined ? quoted.replace(/\\(.)/g, '$1') : (m[6] ?? '')]);
    }
  }
  return out;
}

/** A value as written: bare when it can be, else quoted. */
function value(v: string): string {
  return /^[^\s{}"'\\]+$/.test(v) ? v : `"${v.replace(/(["\\])/g, '\\$1')}"`;
}

/** Attribute text for the parts: `{#id .class key=value}`, or '' for none. */
export function formatAttrs(a: PandocAttrs): string {
  const parts = [
    ...(a.id ? [`#${a.id}`] : []),
    ...a.classes.map((c) => `.${c}`),
    ...a.kv.map(([k, v]) => `${k}=${value(v)}`),
  ];
  return parts.length ? `{${parts.join(' ')}}` : '';
}

/** A div's attribute text: its one class as a bare word (`columns`), as Pandoc allows, else `{…}`. */
export function formatDivAttrs(a: PandocAttrs): string {
  return !a.id && !a.kv.length && a.classes.length === 1 ? a.classes[0]! : formatAttrs(a);
}

/** The value of a key, or null. */
export function attrValue(raw: string, key: string): string | null {
  return parseAttrs(raw).kv.find(([k]) => k === key)?.[1] ?? null;
}

/** Whether the attributes have a class. */
export function hasClass(raw: string, cls: string): boolean {
  return parseAttrs(raw).classes.includes(cls);
}

/** The attribute text with a key set (in its place, or last), or taken out (null). */
export function withAttr(raw: string, key: string, v: string | null, format = formatAttrs): string {
  const a = parseAttrs(raw);
  const i = a.kv.findIndex(([k]) => k === key);
  if (v === null) {
    if (i < 0) return raw;
    a.kv = a.kv.filter(([k]) => k !== key);
  } else if (i >= 0) a.kv[i] = [key, v];
  else a.kv.push([key, v]);
  return format(a);
}

/** A CSS length for a Pandoc width or height: a bare number is pixels, as Pandoc reads it; null for none it reads. */
export function cssLength(v: string | null): string | null {
  if (!v) return null;
  const m = /^(\d+(?:\.\d+)?|\.\d+)(%|px|cm|mm|in|inch|em|pt)?$/.exec(v.trim());
  if (!m) return null;
  const unit = m[2] === 'inch' ? 'in' : (m[2] ?? 'px');
  return `${m[1]}${unit}`;
}

/** A width as a share of the whole, 0–100, if it is a percentage. */
export function percentOf(v: string | null): number | null {
  const m = v ? /^(\d+(?:\.\d+)?)%$/.exec(v.trim()) : null;
  return m ? Number(m[1]) : null;
}

/** How an image alone in its paragraph is placed (Quarto's `fig-align`): left, right, or centred (none said). */
export type ImageAlign = 'left' | 'center' | 'right';

export function imageAlign(raw: string): ImageAlign {
  const v = attrValue(raw, 'fig-align');
  return v === 'left' || v === 'right' ? v : 'center';
}

/** The attribute text with the image placed so: centred, the default, is no attribute at all. */
export function withImageAlign(raw: string, align: ImageAlign): string {
  return withAttr(raw, 'fig-align', align === 'center' ? null : align);
}

/** Whole percentages for `n` columns that add up to 100, the first ones a point wider where they must be. */
export function evenWidths(n: number): number[] {
  const base = Math.floor(100 / n);
  return Array.from({ length: n }, (_, i) => base + (i < 100 - base * n ? 1 : 0));
}
