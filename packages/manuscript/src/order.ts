// Reordering a manuscript (0088): a chapter moved to a place in the chapters, a
// part's chapters or the appendices, or out of the manuscript; a part moved
// among the chapters. Pure: the view sends the order this makes to the host.
import type { Entry } from './book.js';

export interface Order {
  chapters: Entry[];
  appendices: string[];
}

/** Where something goes: the chapters (top level), a part's chapters (by the part's place among them), the appendices, or out. */
export type Place = { list: 'top' } | { list: 'part'; part: number } | { list: 'appendices' } | { list: 'out' };

/** What moves: a document, or a part (by its place among the chapters). */
export type Item = { chapter: string } | { partAt: number };

const HERE = Symbol('here');
type Slot<T> = T | typeof HERE;

/** The order with `item` put at `index` of `to` (at its end if past it), and taken from where it was. */
export function moveTo(order: Order, item: Item, to: Place, index: number): Order {
  if ('partAt' in item) {
    // A part moves among the chapters only.
    if (to.list !== 'top') return order;
    const part = order.chapters[item.partAt];
    if (!part || 'chapter' in part) return order;
    const top: Slot<Entry>[] = [...order.chapters];
    top.splice(Math.max(0, Math.min(index, top.length)), 0, HERE);
    const kept = top.filter((e) => e !== part);
    return { ...order, chapters: kept.map((e) => (e === HERE ? part : e)) };
  }
  const path = item.chapter;
  // A part's chapters, and the top level, with the place marked where it goes.
  const top: Slot<Entry>[] = order.chapters.map((e) => ('chapter' in e ? e : { part: e.part, chapters: [...e.chapters] }));
  let appendices: Slot<string>[] = [...order.appendices];
  const at = (n: number, length: number) => Math.max(0, Math.min(n, length));
  if (to.list === 'top') top.splice(at(index, top.length), 0, HERE);
  else if (to.list === 'appendices') appendices.splice(at(index, appendices.length), 0, HERE);
  else if (to.list === 'part') {
    const p = top[to.part];
    if (!p || p === HERE || 'chapter' in p) return order;
    (p.chapters as Slot<string>[]).splice(at(index, p.chapters.length), 0, HERE);
  }
  // Taken from where it was (wherever it was listed).
  const out: Entry[] = [];
  for (const e of top) {
    if (e === HERE) out.push({ chapter: path });
    else if ('chapter' in e) {
      if (e.chapter !== path) out.push(e);
    } else {
      out.push({ part: e.part, chapters: (e.chapters as Slot<string>[]).filter((c) => c !== path).map((c) => (c === HERE ? path : c)) });
    }
  }
  appendices = appendices.filter((c) => c !== path).map((c) => (c === HERE ? path : c));
  return { chapters: out, appendices: appendices as string[] };
}

/** Where a document is listed: its place and index, or null. */
export function placeOf(order: Order, path: string): { place: Place; index: number } | null {
  for (let i = 0; i < order.chapters.length; i++) {
    const e = order.chapters[i]!;
    if ('chapter' in e) {
      if (e.chapter === path) return { place: { list: 'top' }, index: i };
    } else {
      const j = e.chapters.indexOf(path);
      if (j >= 0) return { place: { list: 'part', part: i }, index: j };
    }
  }
  const k = order.appendices.indexOf(path);
  return k >= 0 ? { place: { list: 'appendices' }, index: k } : null;
}

/** A part added at the end of the chapters. */
export const addPart = (order: Order, title: string): Order => ({ ...order, chapters: [...order.chapters, { part: title, chapters: [] }] });
