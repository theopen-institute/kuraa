// Find and replace in the rich view. The matches are found in the document's
// text (not in code blocks, which have their own editors, nor across a chip) and
// highlighted with decorations, which only this view sees. Replacing is an
// ordinary edit, so it reaches everyone like typing; the matches are found again
// after every change, whoever made it.
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';

export interface Match { from: number; to: number }

export interface FindState {
  query: string;
  caseSensitive: boolean;
  matches: Match[];
  /** The match the cursor is on (-1: none). */
  current: number;
  decorations: DecorationSet;
}

export const findKey = new PluginKey<FindState>('find');

/** Where `query` occurs in the document's text. */
export function findMatches(doc: PMNode, query: string, caseSensitive: boolean): Match[] {
  if (!query) return [];
  const q = caseSensitive ? query : query.toLowerCase();
  const out: Match[] = [];
  doc.descendants((node, pos) => {
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    // The block's text, with each chip as one character no query matches.
    let text = '';
    node.forEach((child) => {
      text += child.isText ? child.text! : '￼'.repeat(child.nodeSize);
    });
    const hay = caseSensitive ? text : text.toLowerCase();
    for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + Math.max(1, q.length))) out.push({ from: pos + 1 + i, to: pos + 1 + i + q.length });
    return false;
  });
  return out;
}

function decorate(doc: PMNode, matches: Match[], current: number): DecorationSet {
  return DecorationSet.create(doc, matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? 'find-match find-current' : 'find-match' })));
}

/** The first match at or after a position, else the first. */
const nearest = (matches: Match[], pos: number) => (matches.length ? Math.max(0, matches.findIndex((m) => m.from >= pos)) : -1);

interface FindMeta { query?: string; caseSensitive?: boolean; current?: number }

export function findPlugin(): Plugin<FindState> {
  return new Plugin<FindState>({
    key: findKey,
    state: {
      init: () => ({ query: '', caseSensitive: false, matches: [], current: -1, decorations: DecorationSet.empty }),
      apply(tr: Transaction, prev: FindState, _old, state: EditorState): FindState {
        const meta = tr.getMeta(findKey) as FindMeta | undefined;
        if (!meta && !tr.docChanged) return prev;
        const query = meta?.query ?? prev.query;
        const caseSensitive = meta?.caseSensitive ?? prev.caseSensitive;
        if (!query) return { query, caseSensitive, matches: [], current: -1, decorations: DecorationSet.empty };
        const matches = findMatches(state.doc, query, caseSensitive);
        let current = meta?.current ?? -1;
        if (current < 0 || current >= matches.length) {
          // Keep to the match the cursor was on, or the next one after the cursor.
          const was = prev.matches[prev.current];
          current = nearest(matches, was && !meta ? tr.mapping.map(was.from) : state.selection.from);
        }
        return { query, caseSensitive, matches, current, decorations: decorate(state.doc, matches, current) };
      },
    },
    props: { decorations: (state) => findKey.getState(state)?.decorations },
  });
}

export function findState(view: EditorView): FindState | undefined {
  return findKey.getState(view.state);
}

/** Look for `query` (from the cursor). */
export function setQuery(view: EditorView, query: string, caseSensitive: boolean): void {
  view.dispatch(view.state.tr.setMeta(findKey, { query, caseSensitive, current: -1 } satisfies FindMeta));
}

/** Go to the next (or previous) match, selecting it. */
export function step(view: EditorView, dir: 1 | -1): void {
  const s = findState(view);
  if (!s?.matches.length) return;
  const current = s.current < 0 ? nearest(s.matches, view.state.selection.from) : (s.current + dir + s.matches.length) % s.matches.length;
  select(view, current);
}

function select(view: EditorView, current: number): void {
  const m = findState(view)!.matches[current]!;
  const tr = view.state.tr.setMeta(findKey, { current } satisfies FindMeta);
  tr.setSelection(TextSelection.create(tr.doc, m.from, m.to)).scrollIntoView();
  view.dispatch(tr);
}

/** Replace the current match (going to it first if the cursor is not on it), then go to the next. */
export function replaceOne(view: EditorView, replacement: string): void {
  const s = findState(view);
  if (!s?.matches.length) return;
  const m = s.matches[s.current];
  const sel = view.state.selection;
  if (!m || sel.from !== m.from || sel.to !== m.to) return select(view, s.current < 0 ? nearest(s.matches, sel.from) : s.current);
  const tr = view.state.tr;
  if (replacement) tr.insertText(replacement, m.from, m.to);
  else tr.delete(m.from, m.to);
  view.dispatch(tr);
  const next = findState(view)!;
  if (next.matches.length) select(view, nearest(next.matches, tr.mapping.map(m.to)));
}

/** Replace every match, in one edit. Returns how many. */
export function replaceAll(view: EditorView, replacement: string): number {
  const s = findState(view);
  if (!s?.matches.length) return 0;
  const tr = view.state.tr;
  for (const m of [...s.matches].reverse()) {
    if (replacement) tr.insertText(replacement, m.from, m.to);
    else tr.delete(m.from, m.to);
  }
  view.dispatch(tr.scrollIntoView());
  return s.matches.length;
}
