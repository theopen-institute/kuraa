// Footnote numbers, as the reader will see them. Pandoc numbers notes in the
// order their references appear, whatever their labels; the editor shows those
// numbers and leaves the labels in the file alone. "Renumber notes" is the
// one deliberate edit that makes the labels match.
//
// Generic over the type's hints: a note is a `note` node view; a reference is
// an atom that `refersTo` it; an atom marked `numbered` without `refersTo`
// (an inline note) takes a number of its own.
import type { NodeViewHint } from '@kuraa/kernel';
import type { Node as PMNode } from 'prosemirror-model';
import { Plugin, PluginKey, type EditorState, type Transaction } from 'prosemirror-state';
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
 * Relabel notes 1, 2, 3 in the order they are first referenced, and put the
 * notes at the end of the document in that order (notes nothing refers to come
 * last). Null if the document is already in that state.
 */
export function renumberNotes(state: EditorState, hints: Record<string, NodeViewHint>): Transaction | null {
  const t = noteTypes(hints);
  if (!t) return null;
  const { doc } = state;
  const order: string[] = [];
  const refs: { pos: number; label: string }[] = [];
  const notes: { pos: number; node: PMNode; label: string; top: boolean }[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.name === t.ref) {
      const label = String(node.attrs[t.refAttr]);
      refs.push({ pos, label });
      if (!order.includes(label)) order.push(label);
    } else if (node.type.name === t.note) {
      notes.push({ pos, node, label: String(node.attrs[t.noteAttr]), top: parent === doc });
    }
    return true;
  });
  if (!notes.length && !refs.length) return null;

  // New labels: referenced notes in order, then the rest after them.
  const relabel = new Map<string, string>();
  order.forEach((label, i) => relabel.set(label, String(i + 1)));
  let next = order.length;
  for (const note of notes) if (!relabel.has(note.label)) relabel.set(note.label, String(++next));

  const rank = (label: string) => Number(relabel.get(label));
  const top = notes.filter((n) => n.top);
  const sorted = [...top].sort((a, b) => rank(a.label) - rank(b.label));

  // Already tidy: labels unchanged, and the top-level notes are at the end, in order.
  const labelsTidy = [...relabel].every(([from, to]) => from === to);
  let tail = doc.childCount - top.length;
  let atEnd = true;
  doc.forEach((node, _, i) => {
    if (i >= tail && node.type.name !== t.note) atEnd = false;
  });
  const inOrder = top.every((n, i) => n === sorted[i]);
  if (labelsTidy && atEnd && inOrder) return null;

  const tr = state.tr;
  for (const r of refs) tr.setNodeAttribute(r.pos, t.refAttr, relabel.get(r.label)!);
  for (const n of notes) if (!n.top) tr.setNodeAttribute(n.pos, t.noteAttr, relabel.get(n.label)!);
  // Move the top-level notes to the end, in order. Attribute steps do not move
  // positions, so the relabelled notes (with relabelled references inside) are
  // read at their old positions before they are removed (last first).
  const moved = sorted.map((n) => tr.doc.nodeAt(n.pos)!);
  for (const n of [...top].reverse()) tr.delete(n.pos, n.pos + n.node.nodeSize);
  tail = tr.doc.content.size;
  tr.insert(tail, moved.map((node, i) => node.type.create({ ...node.attrs, [t.noteAttr]: relabel.get(sorted[i]!.label) }, node.content, node.marks)));
  return tr;
}
