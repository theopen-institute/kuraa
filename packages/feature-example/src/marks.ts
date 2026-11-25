// Marks: passages someone marked in a document, each person's kept beside it in
// a file of their own, `<document>.marks/@<identity ID>.json` (0082: theirs,
// changed only from their devices). What both halves of the example feature
// share: the file's format, merging it, and finding a mark's passage again.
//
// The file is JSON, one mark to a line, sorted by id, so every device writes the
// same bytes for the same marks and git shows a mark added as a line added:
//
//   {"marks": [
//     {"id": "m-…", "start": 12, "end": 20, "quote": "the text", "by": "Ana", "color": "#c2410c"}
//   ]}
//
// `start` and `end` are offsets in the document's text (JavaScript's); the quote
// is the truth, the offsets say where to look first. A mark whose passage cannot
// be found keeps its quote, with no offsets, and is never dropped.

/** The folder beside a document, and each person's file's extension. */
export const SUFFIX = '.marks';
export const EXTENSION = '.json';

export interface Mark {
  id: string;
  start: number | null;
  end: number | null;
  quote: string;
  by: string;
  color: string;
}

const KEYS: (keyof Mark)[] = ['id', 'start', 'end', 'quote', 'by', 'color'];

/** The marks in a file's text: what is not a mark is passed over; a file that is not JSON has none. */
export function readMarks(text: string | null): Mark[] {
  if (!text) return [];
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return [];
  }
  const list = (v as { marks?: unknown } | null)?.marks;
  if (!Array.isArray(list)) return [];
  const out: Mark[] = [];
  for (const m of list as Record<string, unknown>[]) {
    if (!m || typeof m.id !== 'string' || typeof m.quote !== 'string') continue;
    const num = (x: unknown) => (typeof x === 'number' && Number.isInteger(x) && x >= 0 ? x : null);
    out.push({ id: m.id, start: num(m.start), end: num(m.end), quote: m.quote, by: typeof m.by === 'string' ? m.by : '', color: typeof m.color === 'string' ? m.color : '' });
  }
  return out;
}

/** A file's text for these marks: sorted by id, one to a line, keys in one order. Null for none: no file. */
export function writeMarks(marks: Mark[]): string | null {
  if (!marks.length) return null;
  const lines = [...marks].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((m) => `  ${JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, m[k]])))}`);
  return `{"marks": [\n${lines.join(',\n')}\n]}\n`;
}

/**
 * Merge two versions of a marks file made from the same base, by id: added on
 * either side, kept; removed on one side and unchanged on the other, removed;
 * changed on both, the one whose line sorts later. Never conflicts, and depends
 * only on its arguments, so every device merges alike.
 */
export function mergeMarks(base: string, a: string, b: string): string {
  const key = (m: Mark) => JSON.stringify(Object.fromEntries(KEYS.map((k) => [k, m[k]])));
  const byId = (text: string) => new Map(readMarks(text).map((m) => [m.id, m]));
  const o = byId(base);
  const x = byId(a);
  const y = byId(b);
  const out: Mark[] = [];
  for (const id of new Set([...x.keys(), ...y.keys(), ...o.keys()])) {
    const was = o.get(id);
    const mx = x.get(id);
    const my = y.get(id);
    if (!mx && !my) continue;
    if (!mx || !my) {
      const kept = (mx ?? my)!;
      // Removed on one side: gone, unless the other side changed it.
      if (was && key(was) === key(kept)) continue;
      out.push(kept);
      continue;
    }
    if (key(mx) === key(my)) out.push(mx);
    else if (was && key(was) === key(mx)) out.push(my);
    else if (was && key(was) === key(my)) out.push(mx);
    else out.push(key(mx) > key(my) ? mx : my);
  }
  return writeMarks(out) ?? '';
}

/** Where a mark's quote is in a text: at its offsets if it is still there, else the place nearest them; null if nowhere. */
export function findQuote(text: string, quote: string, near: number | null): number | null {
  if (!quote) return null;
  if (near !== null && text.startsWith(quote, near)) return near;
  let best: number | null = null;
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) {
    if (best === null || Math.abs(i - (near ?? 0)) < Math.abs(best - (near ?? 0))) best = i;
  }
  return best;
}

/** What one change to a marks file did, in a few words: "2 marks added". */
export function describeMarks(before: string | null, after: string | null): string | null {
  const was = new Set(readMarks(before).map((m) => m.id));
  const now = new Set(readMarks(after).map((m) => m.id));
  const added = [...now].filter((id) => !was.has(id)).length;
  const removed = [...was].filter((id) => !now.has(id)).length;
  const n = (k: number, what: string) => `${k} mark${k === 1 ? '' : 's'} ${what}`;
  const parts = [added ? n(added, 'added') : '', removed ? n(removed, 'removed') : ''].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}
