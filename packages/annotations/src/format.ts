// Annotations as files (docs/decisions/0082-annotations.md): what both halves of
// the annotations feature share. Each person's annotations on a document are a
// W3C AnnotationPage of their own, in a folder beside it:
//
//   interviews/p01.md.annotations/@<identity ID>.jsonld
//
//   {
//     "@context": "http://www.w3.org/ns/anno.jsonld",
//     "id": "@<identity ID>.jsonld",
//     "type": "AnnotationPage",
//     "items": [
//       {"body": …, "created": …, "creator": …, "id": "urn:uuid:…", "modified": …, "motivation": "commenting", "target": …, "type": "Annotation"}
//     ]
//   }
//
// One annotation to a line, sorted by id, keys in one order: every device writes
// the same bytes for the same annotations, and git shows one added as a line
// added. A passage is named by two selectors of the same text: its quote (with
// up to 32 characters before and after it) and its position, counted as the
// model counts, in Unicode code points of the file's text. The quote is the
// truth; the position says where to look first. Annotations of kinds this
// version does not know are kept, and written back as they were.
import type { Json } from '@kuraa/feature-kit';

/** The folder beside a document, and each person's file's extension. */
export const SUFFIX = '.annotations';
export const EXTENSION = '.jsonld';
export const CONTEXT = 'http://www.w3.org/ns/anno.jsonld';
/** How much of the text before and after a passage its quote keeps. */
const CONTEXT_CHARS = 32;

/** One annotation, as JSON-LD: kept whole, whatever it holds. */
export type Item = { [key: string]: Json };

export interface TextQuote {
  type: 'TextQuoteSelector';
  exact: string;
  prefix?: string;
  suffix?: string;
}
export interface TextPosition {
  type: 'TextPositionSelector';
  start: number;
  end: number;
}

/** What an annotation is about: a passage (its quote, and its place in code points), the document, or another annotation. */
export type About =
  | { kind: 'passage'; exact: string; prefix: string; suffix: string; start: number | null; end: number | null }
  | { kind: 'document' }
  | { kind: 'annotation'; id: string };

const isObject = (v: unknown): v is { [key: string]: Json } => !!v && typeof v === 'object' && !Array.isArray(v);

/** The annotations in a file's text: what is not one is passed over; a file that is not JSON has none. */
export function readPage(text: string | null): Item[] {
  if (!text) return [];
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return [];
  }
  const items = isObject(v) ? v.items : null;
  if (!Array.isArray(items)) return [];
  return items.filter((i): i is Item => isObject(i) && typeof i.id === 'string' && i.id.length > 0);
}

/** JSON with keys in one order (the annotation's own first, the rest by name), nested objects by name. */
function canonical(v: Json, top = false): Json {
  if (Array.isArray(v)) return v.map((x) => canonical(x));
  if (!isObject(v)) return v;
  const first = top ? ['id', 'type', 'motivation', 'created', 'modified', 'creator', 'body', 'target'] : [];
  const keys = [...first.filter((k) => k in v), ...Object.keys(v).filter((k) => !first.includes(k)).sort()];
  return Object.fromEntries(keys.map((k) => [k, canonical(v[k]!)]));
}

/** A person's file's text for these annotations, or null for none (no file). */
export function writePage(items: Item[], person: string): string | null {
  if (!items.length) return null;
  const lines = [...items].sort((a, b) => (String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0)).map((i) => `    ${JSON.stringify(canonical(i, true))}`);
  return `{\n  "@context": "${CONTEXT}",\n  "id": "@${person}${EXTENSION}",\n  "type": "AnnotationPage",\n  "items": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

/** Whose page a file's text says it is (its id), if it says. */
function pageOwner(text: string): string | null {
  try {
    const id = (JSON.parse(text) as { id?: unknown }).id;
    return typeof id === 'string' ? (/^@([0-9a-f]{64})/.exec(id)?.[1] ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * Merge two versions of a person's file made from the same base (their two
 * devices), by id: added on either side, kept; removed on one side and unchanged
 * on the other, removed; changed on both, the later `modified` (equal: the one
 * whose line sorts later); changed on one and removed on the other, kept as
 * changed. Never conflicts, and depends only on its arguments.
 */
export function mergePages(base: string, a: string, b: string): string {
  const key = (i: Item) => JSON.stringify(canonical(i, true));
  const byId = (text: string) => new Map(readPage(text).map((i) => [String(i.id), i]));
  const o = byId(base);
  const x = byId(a);
  const y = byId(b);
  const out: Item[] = [];
  for (const id of new Set([...x.keys(), ...y.keys(), ...o.keys()])) {
    const was = o.get(id);
    const ix = x.get(id);
    const iy = y.get(id);
    if (!ix && !iy) continue;
    if (!ix || !iy) {
      const kept = (ix ?? iy)!;
      if (was && key(was) === key(kept)) continue;
      out.push(kept);
      continue;
    }
    if (key(ix) === key(iy)) out.push(ix);
    else if (was && key(was) === key(ix)) out.push(iy);
    else if (was && key(was) === key(iy)) out.push(ix);
    else {
      const mx = String(ix.modified ?? '');
      const my = String(iy.modified ?? '');
      out.push(mx !== my ? (mx > my ? ix : iy) : key(ix) > key(iy) ? ix : iy);
    }
  }
  const person = pageOwner(a) ?? pageOwner(b) ?? pageOwner(base) ?? '';
  return writePage(out, person) ?? '';
}

/** A JavaScript offset in a text as the model counts places: Unicode code points. */
export function toCodePoints(text: string, offset: number): number {
  let n = 0;
  for (let i = 0; i < offset && i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0xdc00 || c > 0xdfff || i === 0 || text.charCodeAt(i - 1) < 0xd800 || text.charCodeAt(i - 1) > 0xdbff) n++;
  }
  return n;
}

/** A place counted in code points, as a JavaScript offset in a text. */
export function fromCodePoints(text: string, points: number): number {
  let i = 0;
  for (let n = 0; n < points && i < text.length; n++) {
    const c = text.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < text.length ? 2 : 1;
  }
  return i;
}

/** The selectors naming a passage of a text (JavaScript offsets): its quote with what is around it, and its place in code points. */
export function selectorsFor(text: string, from: number, to: number): Json[] {
  return [
    { type: 'TextQuoteSelector', exact: text.slice(from, to), prefix: text.slice(Math.max(0, from - CONTEXT_CHARS), from), suffix: text.slice(to, to + CONTEXT_CHARS) },
    { type: 'TextPositionSelector', start: toCodePoints(text, from), end: toCodePoints(text, to) },
  ];
}

/** What an annotation is about, from its target (`doc`: the document's name as the file writes it, relative or not). */
export function aboutOf(item: Item): About | null {
  const t = item.target;
  if (typeof t === 'string') return t.startsWith('urn:') ? { kind: 'annotation', id: t } : { kind: 'document' };
  if (!isObject(t)) return null;
  const selectors = Array.isArray(t.selector) ? t.selector : isObject(t.selector) ? [t.selector] : [];
  const quote = selectors.find((s) => isObject(s) && s.type === 'TextQuoteSelector') as TextQuote | undefined;
  const place = selectors.find((s) => isObject(s) && s.type === 'TextPositionSelector') as TextPosition | undefined;
  if (!quote || typeof quote.exact !== 'string') return typeof t.source === 'string' && t.source.startsWith('urn:') ? { kind: 'annotation', id: t.source } : { kind: 'document' };
  const num = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);
  return { kind: 'passage', exact: quote.exact, prefix: typeof quote.prefix === 'string' ? quote.prefix : '', suffix: typeof quote.suffix === 'string' ? quote.suffix : '', start: num(place?.start), end: num(place?.end) };
}

/** How much of `a`'s end and `b`'s start agree, from where they meet. */
const agreeBackwards = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
};
const agreeForwards = (a: string, b: string) => {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n++;
  return n;
};

/**
 * Where a passage is in a text now (JavaScript offsets): at its place if its
 * quote is still there; else, of the places its quote is, the one whose text
 * around it agrees most with what was around it, then the nearest; null if its
 * quote is nowhere (it is no longer found).
 */
export function findPassage(text: string, p: Extract<About, { kind: 'passage' }>): { from: number; to: number } | null {
  if (!p.exact) return findPoint(text, p);
  const at = p.start === null ? null : fromCodePoints(text, p.start);
  if (at !== null && text.startsWith(p.exact, at)) return { from: at, to: at + p.exact.length };
  let best: { from: number; score: number; distance: number } | null = null;
  for (let i = text.indexOf(p.exact); i >= 0; i = text.indexOf(p.exact, i + 1)) {
    const score = agreeBackwards(text.slice(Math.max(0, i - p.prefix.length), i), p.prefix) + agreeForwards(text.slice(i + p.exact.length, i + p.exact.length + p.suffix.length), p.suffix);
    const distance = at === null ? 0 : Math.abs(i - at);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { from: i, score, distance };
  }
  return best ? { from: best.from, to: best.from + p.exact.length } : null;
}

/**
 * A point in a text, not a passage (`exact` empty: a TextPositionSelector with
 * its start at its end, which the W3C model allows, though it says nothing of
 * it): a code put between two characters (#, typed at the caret).
 */
export const isPoint = (about: About | null): boolean => about?.kind === 'passage' && about.exact === '';

/** How much of a point's text before and after it is still around a place. */
const pointScore = (text: string, at: number, p: { prefix: string; suffix: string }) =>
  agreeBackwards(text.slice(Math.max(0, at - p.prefix.length), at), p.prefix) + agreeForwards(text.slice(at, at + p.suffix.length), p.suffix);

/**
 * Where a point is in a text now: at its place if what was around it is still
 * there; else where most of what was before and after it is, then the nearest;
 * null where neither is found (it is no longer found). Looked for where the
 * last few characters before it, or the first few after it, are.
 */
function findPoint(text: string, p: Extract<About, { kind: 'passage' }>): { from: number; to: number } | null {
  const at = p.start === null ? null : fromCodePoints(text, p.start);
  const whole = p.prefix.length + p.suffix.length;
  if (!whole) return at !== null && at <= text.length ? { from: at, to: at } : null;
  if (at !== null && at <= text.length && pointScore(text, at, p) === whole) return { from: at, to: at };
  const candidates = new Set<number>();
  const before = p.prefix.slice(-12);
  const after = p.suffix.slice(0, 12);
  if (before) for (let i = text.indexOf(before); i >= 0; i = text.indexOf(before, i + 1)) candidates.add(i + before.length);
  if (after) for (let i = text.indexOf(after); i >= 0; i = text.indexOf(after, i + 1)) candidates.add(i);
  let best: { at: number; score: number; distance: number } | null = null;
  for (const c of candidates) {
    const score = pointScore(text, c, p);
    const distance = at === null ? 0 : Math.abs(c - at);
    if (!best || score > best.score || (score === best.score && distance < best.distance)) best = { at: c, score, distance };
  }
  // Found only where what is around it is mostly still there: a few letters that happen to agree are not it.
  return best && best.score >= Math.min(whole, Math.max(8, Math.ceil(whole / 2))) ? { from: best.at, to: best.at } : null;
}

/** An annotation's kind, from its motivation: a comment, a reply, a coding, or one this version does not show. */
export function kindOf(item: Item): 'comment' | 'reply' | 'coding' | 'other' {
  return item.motivation === 'commenting' ? 'comment' : item.motivation === 'replying' ? 'reply' : item.motivation === 'classifying' ? 'coding' : 'other';
}

/** The code a coding names (its body's source, purpose classifying); null if it names none. */
export function codeOf(item: Item): string | null {
  const bodies = Array.isArray(item.body) ? item.body : [item.body];
  for (const b of bodies) if (isObject(b) && typeof b.source === 'string' && (b.purpose === undefined || b.purpose === 'classifying')) return b.source;
  return null;
}

/** What an annotation says: its textual body's text. */
export function textOf(item: Item): string {
  const bodies = Array.isArray(item.body) ? item.body : [item.body];
  for (const b of bodies) if (isObject(b) && typeof b.value === 'string') return b.value;
  return '';
}

/** Who made an annotation, by name. */
export function creatorOf(item: Item): string {
  const c = item.creator;
  return isObject(c) && typeof c.name === 'string' ? c.name : '';
}

/** Its maker's colour as it was when they made it (their cursor's, 0129), as #rrggbb; null where none was kept. */
export function creatorColourOf(item: Item): string | null {
  const c = item.creator;
  return isObject(c) && typeof c.color === 'string' && /^#[0-9a-f]{6}$/i.test(c.color) ? c.color : null;
}

/** What one change to a person's file did, in a few words: "2 comments added, 1 reply removed". */
export function describePages(before: string | null, after: string | null): string | null {
  const was = new Map(readPage(before).map((i) => [String(i.id), i]));
  const now = new Map(readPage(after).map((i) => [String(i.id), i]));
  const count = { comment: [0, 0, 0], reply: [0, 0, 0], coding: [0, 0, 0], other: [0, 0, 0] } as Record<'comment' | 'reply' | 'coding' | 'other', number[]>;
  for (const [id, i] of now) {
    const w = was.get(id);
    if (!w) count[kindOf(i)]![0]!++;
    else if (JSON.stringify(canonical(w, true)) !== JSON.stringify(canonical(i, true))) count[kindOf(i)]![2]!++;
  }
  for (const [id, i] of was) if (!now.has(id)) count[kindOf(i)]![1]!++;
  const words = { comment: ['comment', 'comments'], reply: ['reply', 'replies'], coding: ['coding', 'codings'], other: ['annotation', 'annotations'] } as const;
  const parts: string[] = [];
  for (const k of ['coding', 'comment', 'reply', 'other'] as const) {
    const [added, removed, changed] = count[k];
    const say = (n: number, what: string) => n && parts.push(`${n} ${words[k][n === 1 ? 0 : 1]} ${what}`);
    say(added!, 'added');
    say(changed!, 'changed');
    say(removed!, 'removed');
  }
  return parts.length ? parts.join(', ') : null;
}
