// Pandoc citations, read from their markdown: `[see @smith2020, p. 3; -@jones2019]`,
// `@smith2020` and `@smith2020 [p. 3]`. A citation node keeps its markdown as it
// was written (the serializer writes it back unchanged); this reads it for
// display: which keys it cites, with what prefix and locator.

/**
 * A citation key as Pandoc reads it: a letter, digit or underscore, then
 * letters, digits, underscores and punctuation inside the key (`:.#$%&-+?<>~/`),
 * never at its end. `@{…}` holds any other key.
 */
export const CITATION_KEY = String.raw`(?:\{[^{}\n]+\}|[\p{L}\p{N}_](?:[\p{L}\p{N}_]|[:.#$%&\-+?<>~/](?=[\p{L}\p{N}_]))*)`;

export interface CitationItem {
  key: string;
  /** `-@key`: the author's name left out, as after "Smith says…". */
  suppressAuthor: boolean;
  /** Text before the key, inside the brackets: "see". */
  prefix: string;
  /** Text after it: ", p. 3". */
  suffix: string;
}

export interface Citation {
  /** In brackets, `[@a; @b]` (in parentheses when printed), or in the text, `@a`. */
  bracketed: boolean;
  items: CitationItem[];
}

const keyAt = new RegExp(String.raw`(-?)@(${CITATION_KEY})`, 'u');
const strip = (key: string) => (key.startsWith('{') ? key.slice(1, -1) : key);

/** Read a citation's markdown; null if it is not one. */
export function readCitation(text: string): Citation | null {
  const t = text.trim();
  // In the text, perhaps with a locator in brackets after it: @smith2020 [p. 3].
  const inText = new RegExp(String.raw`^@(${CITATION_KEY})(?:\s+\[([^\[\]]*)\])?$`, 'u').exec(t);
  if (inText) return { bracketed: false, items: [{ key: strip(inText[1]!), suppressAuthor: false, prefix: '', suffix: inText[2]?.trim() ?? '' }] };
  const suppressed = new RegExp(String.raw`^-@(${CITATION_KEY})$`, 'u').exec(t);
  if (suppressed) return { bracketed: false, items: [{ key: strip(suppressed[1]!), suppressAuthor: true, prefix: '', suffix: '' }] };
  if (!t.startsWith('[') || !t.endsWith(']')) return null;
  const items: CitationItem[] = [];
  for (const part of splitItems(t.slice(1, -1))) {
    const m = keyAt.exec(part);
    if (!m) {
      // Text with no key (only allowed before the first): it prefixes the next one.
      if (items.length) items[items.length - 1]!.suffix += `; ${part.trim()}`;
      continue;
    }
    items.push({
      key: strip(m[2]!),
      suppressAuthor: m[1] === '-',
      prefix: part.slice(0, m.index).trim(),
      suffix: part.slice(m.index + m[0].length).trim(),
    });
  }
  return items.length ? { bracketed: true, items } : null;
}

/** The parts between semicolons, but not those inside brackets or braces. */
function splitItems(inner: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === '\\') i++;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth = Math.max(0, depth - 1);
    else if (c === ';' && depth === 0) {
      out.push(inner.slice(start, i));
      start = i + 1;
    }
  }
  out.push(inner.slice(start));
  return out.filter((p) => p.trim());
}

/** The markdown of an in-text citation of a key: `@smith2020`, or `@{odd key}` for a key Pandoc would not read bare. */
export function citeKey(key: string): string {
  return new RegExp(`^${CITATION_KEY}$`, 'u').test(key) && !key.startsWith('{') ? `@${key}` : `@{${key}}`;
}
