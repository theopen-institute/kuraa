// Footnotes as a word processor shows them. Pandoc numbers notes in the order
// their references appear, whatever their labels, so the editor shows those
// numbers and treats labels as fixed ids (cut and paste keeps a reference and
// its note together). After each of the user's own edits, the notes are kept
// together at the end of the document in that order.
//
// Generic over the type's hints: a note is a `note` node view; a reference is
// an atom that `refersTo` it; an atom marked `numbered` without `refersTo`
// (an inline note) takes a number of its own.
import type { NodeViewHint } from '@kuraa/kernel';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

interface NoteTypes {
  ref: string;
  refAttr: string;
  note: string;
  noteAttr: string;
  inline: Set<string>;
}

function noteTypes(hints: Record<string, NodeViewHint>): NoteTypes | null {
  let ref: [string, string] | null = null;
  let note: [string, string] | null = null;
  const inline = new Set<string>();
  for (const [name, h] of Object.entries(hints)) {
    if (h.kind === 'note') note = [name, h.attr];
    else if (h.kind === 'atom' && h.refersTo) ref = [name, h.attr];
    else if (h.kind === 'atom' && h.numbered) inline.add(name);
  }
  if (!ref || !note) return null;
  return { ref: ref[0], refAttr: ref[1], note: note[0], noteAttr: note[1], inline };
}

/** What the decoration carries to a node view. */
export interface NoteNumber {
  /** The number the reader sees; null for a note nothing refers to. */
  number: number | null;
}

const key = new PluginKey<DecorationSet>('note-numbers');

function decorate(doc: PMNode, t: NoteTypes): DecorationSet {
  const decos: Decoration[] = [];
  const first = new Map<string, number>();
  const notes: { pos: number; node: PMNode }[] = [];
  let n = 0;
  doc.descendants((node, pos) => {
    const name = node.type.name;
    if (name === t.ref || t.inline.has(name)) {
      n++;
      if (name === t.ref) {
        const label = String(node.attrs[t.refAttr]);
        if (!first.has(label)) first.set(label, n);
      }
      decos.push(Decoration.node(pos, pos + node.nodeSize, {}, { number: n } satisfies NoteNumber));
    } else if (name === t.note) {
      notes.push({ pos, node });
    }
    return true;
  });
  for (const { pos, node } of notes) {
    const number = first.get(String(node.attrs[t.noteAttr])) ?? null;
    decos.push(Decoration.node(pos, pos + node.nodeSize, {}, { number } satisfies NoteNumber));
  }
  return DecorationSet.create(doc, decos);
}

/** Shows each note and reference with its number. */
export function noteNumbersPlugin(hints: Record<string, NodeViewHint>): Plugin[] {
  const t = noteTypes(hints);
  if (!t) return [];
  return [new Plugin<DecorationSet>({
    key,
    state: {
      init: (_, state) => decorate(state.doc, t),
      apply: (tr, set, _old, state) => (tr.docChanged ? decorate(state.doc, t) : set),
    },
    props: { decorations: (state) => key.getState(state) },
  })];
}

/** The number a node view was given, if any. */
export function numberOf(decorations: readonly Decoration[]): number | null | undefined {
  for (const d of decorations) {
    const spec = d.spec as Partial<NoteNumber>;
    if ('number' in spec) return spec.number ?? null;
  }
  return undefined;
}

/**
 * Keep the top-level notes together at the end of the document, in the order of
 * their first reference; notes nothing refers to come last, in their current
 * order. A second note with the same label and the same content (two people
 * arranging at once) is dropped. Labels never change. The cursor stays where it
 * was, even inside a note that moves. Null if the notes are already in place.
 */
export function arrangeNotes(state: EditorState, hints: Record<string, NodeViewHint>): Transaction | null {
  const t = noteTypes(hints);
  if (!t) return null;
  const { doc } = state;
  const rank = new Map<string, number>();
  const top: { pos: number; node: PMNode; label: string }[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.name === t.ref) {
      const label = String(node.attrs[t.refAttr]);
      if (!rank.has(label)) rank.set(label, rank.size);
    } else if (node.type.name === t.note && parent === doc) {
      top.push({ pos, node, label: String(node.attrs[t.noteAttr]) });
    }
    return true;
  });
  if (!top.length) return null;

  const kept = top.filter((n, i) => !top.slice(0, i).some((m) => m.label === n.label && m.node.eq(n.node)));
  const unused = kept.length + rank.size;
  const order = (n: { label: string }) => rank.get(n.label) ?? unused;
  const desired = kept.map((n, i) => ({ n, i })).sort((a, b) => order(a.n) - order(b.n) || a.i - b.i).map((x) => x.n);

  // In place already: the last children are exactly the desired notes, in order.
  const tail = doc.childCount - desired.length;
  let inPlace = kept.length === top.length && tail >= 0;
  for (let i = 0; inPlace && i < desired.length; i++) if (doc.child(tail + i) !== desired[i]!.node) inPlace = false;
  if (inPlace) return null;

  const { anchor, head } = state.selection;
  const holder = top.find((n) => anchor > n.pos && anchor < n.pos + n.node.nodeSize && head > n.pos && head < n.pos + n.node.nodeSize);

  const tr = state.tr;
  for (const n of [...top].reverse()) tr.delete(n.pos, n.pos + n.node.nodeSize);
  const start = tr.doc.content.size;
  tr.insert(start, desired.map((n) => n.node));
  if (holder) {
    // The note the cursor was in: same label, now at its new place.
    let at = start;
    for (const n of desired) {
      if (n.label === holder.label) break;
      at += n.node.nodeSize;
    }
    tr.setSelection(TextSelection.create(tr.doc, at + (anchor - holder.pos), at + (head - holder.pos)));
  }
  return tr;
}

/** Arrange the notes after each of the user's own edits (not remote ones, not undo). */
export function arrangeNotesPlugin(hints: Record<string, NodeViewHint>, isRemote: (tr: Transaction) => boolean): Plugin[] {
  if (!noteTypes(hints)) return [];
  return [new Plugin({
    appendTransaction(trs, _old, state) {
      if (!trs.some((tr) => tr.docChanged && !isRemote(tr))) return null;
      return arrangeNotes(state, hints);
    },
  })];
}
