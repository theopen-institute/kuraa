// Footnotes in the editor, as a word processor has them.
//
// Pandoc numbers notes in the order their references appear (inline notes
// included), whatever their labels. So references and notes show those numbers;
// labels are fixed ids, never rewritten, so cut and paste keeps a reference and
// its note together. A new note is put among the notes in number order; notes
// are never moved after that, since moving one (a delete and an insert, to
// Yjs) would lose what someone else is typing in it at the time. In a note,
// Enter goes back to the text and Shift+Enter starts a new paragraph.
import type { EditorContext } from '@kuraa/editor-kit';
import type { Node as PMNode, Schema } from 'prosemirror-model';
import { Plugin, PluginKey, Selection, TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView, type NodeView, type NodeViewConstructor } from 'prosemirror-view';
import { InputRule } from 'prosemirror-inputrules';

const REF = 'footnote_ref';
const NOTE = 'footnote_def';
const INLINE = 'inline_note';

const shorten = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text);

// ---------------------------------------------------------------------------
// Numbers

interface Numbered { number: number | null }
const numbersKey = new PluginKey<DecorationSet>('footnote-numbers');

function numberDecorations(doc: PMNode): DecorationSet {
  const decos: Decoration[] = [];
  const first = new Map<string, number>();
  const notes: { pos: number; node: PMNode }[] = [];
  let n = 0;
  doc.descendants((node, pos) => {
    const name = node.type.name;
    if (name === REF || name === INLINE) {
      n++;
      if (name === REF && !first.has(String(node.attrs.label))) first.set(String(node.attrs.label), n);
      decos.push(Decoration.node(pos, pos + node.nodeSize, {}, { number: n } satisfies Numbered));
    } else if (name === NOTE) {
      notes.push({ pos, node });
    }
    return true;
  });
  for (const { pos, node } of notes) {
    decos.push(Decoration.node(pos, pos + node.nodeSize, {}, { number: first.get(String(node.attrs.label)) ?? null } satisfies Numbered));
  }
  return DecorationSet.create(doc, decos);
}

/** Each reference, inline note and note carries the number the reader will see. */
function numbersPlugin(): Plugin {
  return new Plugin<DecorationSet>({
    key: numbersKey,
    state: {
      init: (_, state) => numberDecorations(state.doc),
      apply: (tr, set, _old, state) => (tr.docChanged ? numberDecorations(state.doc) : set),
    },
    props: { decorations: (state) => numbersKey.getState(state) },
  });
}

/** The number a node view was given: a number, null for an unused note, undefined if none. */
function numberOf(decorations: readonly Decoration[]): number | null | undefined {
  for (const d of decorations) {
    const spec = d.spec as Partial<Numbered>;
    if ('number' in spec) return spec.number ?? null;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Putting the notes in order

/**
 * Put the top-level notes together at the end of the document, in the order of
 * their first reference; notes nothing refers to come last, in their current
 * order. A second note with the same label and the same content (two people
 * arranging at once) is dropped. Labels never change. The cursor stays where it
 * was, even inside a note that moves. Null if the notes are already in place.
 *
 * Not run as people edit: it moves notes, and a note moved while someone else
 * types in it loses their typing. New notes take their place as they are made
 * (ensureNote); this is for a command, to tidy a file whose notes are elsewhere.
 */
export function arrangeNotes(state: EditorState): Transaction | null {
  const { doc } = state;
  const rank = new Map<string, number>();
  const top: { pos: number; node: PMNode; label: string }[] = [];
  doc.descendants((node, pos, parent) => {
    if (node.type.name === REF) {
      const label = String(node.attrs.label);
      if (!rank.has(label)) rank.set(label, rank.size);
    } else if (node.type.name === NOTE && parent === doc) {
      top.push({ pos, node, label: String(node.attrs.label) });
    }
    return true;
  });
  if (!top.length) return null;

  // Earlier notes are looked up by label, not rescanned.
  const byLabel = new Map<string, PMNode[]>();
  const kept = top.filter((n) => {
    const same = byLabel.get(n.label);
    if (!same) byLabel.set(n.label, [n.node]);
    else if (same.some((m) => m.eq(n.node))) return false;
    else same.push(n.node);
    return true;
  });
  const unused = kept.length + rank.size;
  const order = (n: { label: string }) => rank.get(n.label) ?? unused;
  const desired = kept.map((n, i) => ({ n, i })).sort((a, b) => order(a.n) - order(b.n) || a.i - b.i).map((x) => x.n);

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
    let at = start;
    for (const n of desired) {
      if (n.label === holder.label) break;
      at += n.node.nodeSize;
    }
    tr.setSelection(TextSelection.create(tr.doc, at + (anchor - holder.pos), at + (head - holder.pos)));
  }
  return tr;
}

// ---------------------------------------------------------------------------
// Making notes, and moving between a note and its reference

/**
 * Where a new note for `label` goes: among the notes at the end of the document,
 * before the first whose reference comes later (notes nothing refers to come
 * last); at the end if there are none. Only an insertion: no note is moved.
 */
function newNoteAt(doc: PMNode, label: string): number {
  const rank = new Map<string, number>();
  doc.descendants((node) => {
    if (node.type.name === REF && !rank.has(String(node.attrs.label))) rank.set(String(node.attrs.label), rank.size);
    return true;
  });
  const mine = rank.get(label) ?? Infinity;
  // The notes together at the end of the document.
  let first = doc.childCount;
  while (first > 0 && doc.child(first - 1).type.name === NOTE) first--;
  let pos = doc.content.size;
  for (let i = doc.childCount - 1; i >= first; i--) pos -= doc.child(i).nodeSize;
  for (let i = first; i < doc.childCount; i++) {
    const note = doc.child(i);
    if ((rank.get(String(note.attrs.label)) ?? Infinity) > mine) return pos;
    pos += note.nodeSize;
  }
  return doc.content.size;
}

/** After inserting a reference, make sure its note exists; if not, add an empty one in its place and put the cursor in it. */
function ensureNote(tr: Transaction, schema: Schema, label: string): Transaction {
  const def = schema.nodes[NOTE]!;
  let exists = false;
  tr.doc.descendants((node) => {
    if (node.type === def && node.attrs.label === label) exists = true;
    return !exists;
  });
  if (exists) return tr;
  const at = newNoteAt(tr.doc, label);
  tr.insert(at, def.create({ label }, schema.nodes.paragraph!.create()));
  return tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView();
}

/** ⌥⌘F: a footnote labelled one past the highest number, and its note. */
const insertFootnote = (schema: Schema): Command => (state, dispatch) => {
  const ref = schema.nodes[REF]!;
  const { $from } = state.selection;
  if (!$from.parent.inlineContent || $from.parent.type.spec.code) return false;
  if (dispatch) {
    // One more than the highest numeric label: never reuses a number out of order.
    let k = 1;
    state.doc.descendants((node) => {
      const label = String(node.attrs.label ?? '');
      if ((node.type.name === REF || node.type.name === NOTE) && /^\d+$/.test(label)) k = Math.max(k, Number(label) + 1);
    });
    dispatch(ensureNote(state.tr.replaceSelectionWith(ref.create({ label: String(k) }), false), schema, String(k)));
  }
  return true;
};

/** The note the cursor is in, if any. */
export function noteAt(state: EditorState): PMNode | null {
  const { $from } = state.selection;
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === NOTE) return $from.node(d);
  return null;
}

/** Enter in a note: back to the text, just after the note's first reference. */
const backFromNote: Command = (state, dispatch) => {
  const note = noteAt(state);
  if (!note) return false;
  let after = -1;
  state.doc.descendants((node, pos) => {
    if (after < 0 && node.type.name === REF && node.attrs.label === note.attrs.label) after = pos + node.nodeSize;
    return after < 0;
  });
  if (after < 0) return false; // a note nothing refers to: Enter as usual
  if (dispatch) dispatch(state.tr.setSelection(TextSelection.create(state.doc, after)).scrollIntoView());
  return true;
};

/** Typing [^label] makes a reference (and its note); ^[text] makes an inline note. */
function noteRules(schema: Schema): InputRule[] {
  return [
    new InputRule(/(?<![\\!])\[\^([^\]\s^[]+)\]$/, (state, x, start, end) =>
      ensureNote(state.tr.replaceWith(start, end, schema.nodes[REF]!.create({ label: x[1] })), schema, x[1]!)),
    new InputRule(/(?<!\\)\^\[([^[\]]+)\]$/, (state, x, start, end) =>
      state.tr.replaceWith(start, end, schema.nodes[INLINE]!.create({ text: x[1] }))),
  ];
}

// ---------------------------------------------------------------------------
// Views

function findNode(doc: PMNode, type: string, label: unknown): { node: PMNode; pos: number } | null {
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.type.name === type && node.attrs.label === label) found = { node, pos };
    return true;
  });
  return found;
}

function goTo(view: EditorView, pos: number): void {
  view.focus();
  view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(pos))).scrollIntoView());
}

/** A reference: its number; hover for the note, ⌘-click to go there, double-click to change the label. */
class RefView implements NodeView {
  dom: HTMLElement;
  constructor(private node: PMNode, view: EditorView, getPos: () => number | undefined, decorations: readonly Decoration[], ctx: EditorContext) {
    this.dom = document.createElement('span');
    this.dom.className = 'atom footnote-ref';
    this.render(decorations);
    this.dom.addEventListener('mouseenter', () => {
      const target = findNode(view.state.doc, NOTE, this.node.attrs.label);
      const text = target ? shorten(target.node.textContent.trim(), 300) || '(empty note)' : 'No note with this label yet.';
      this.dom.title = `${text}\n\n[^${String(this.node.attrs.label)}] · ⌘-click to go to the note · double-click to change the label`;
    });
    this.dom.addEventListener('mousedown', (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      e.preventDefault();
      const target = findNode(view.state.doc, NOTE, this.node.attrs.label);
      if (target) goTo(view, target.pos + 1);
    });
    this.dom.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (ctx.readOnly) return;
      void ctx.ui.askText('Footnote label', String(this.node.attrs.label), 'Save').then((label) => {
        const pos = getPos();
        if (!label?.trim() || pos === undefined || view.isDestroyed) return;
        view.dispatch(view.state.tr.setNodeAttribute(pos, 'label', label.trim()));
      });
    });
  }
  private render(decorations: readonly Decoration[]) {
    const n = numberOf(decorations);
    this.dom.textContent = n != null ? String(n) : String(this.node.attrs.label);
  }
  update(node: PMNode, decorations: readonly Decoration[]) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render(decorations);
    return true;
  }
  ignoreMutation() { return true; }
}

/** An inline note: its number and text; double-click to edit. */
class InlineNoteView implements NodeView {
  dom: HTMLElement;
  constructor(private node: PMNode, view: EditorView, getPos: () => number | undefined, decorations: readonly Decoration[], ctx: EditorContext) {
    this.dom = document.createElement('span');
    this.dom.className = 'atom inline-note';
    this.render(decorations);
    this.dom.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (ctx.readOnly) return;
      void ctx.ui.askText('Note', String(this.node.attrs.text), 'Save').then((text) => {
        const pos = getPos();
        if (text === null || pos === undefined || view.isDestroyed) return;
        view.dispatch(view.state.tr.setNodeAttribute(pos, 'text', text));
      });
    });
  }
  private render(decorations: readonly Decoration[]) {
    const n = numberOf(decorations);
    const text = String(this.node.attrs.text ?? '');
    this.dom.title = `${text}\n\nDouble-click to edit`;
    this.dom.replaceChildren(
      Object.assign(document.createElement('sup'), { className: 'note-number', textContent: n != null ? String(n) : '' }),
      document.createTextNode(shorten(text, 60)),
    );
  }
  update(node: PMNode, decorations: readonly Decoration[]) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render(decorations);
    return true;
  }
  ignoreMutation() { return true; }
}

/**
 * A note: its content edited in place, its number in the margin. Click the number
 * to go back to the reference (or, for a note nothing refers to, to delete it);
 * double-click to rename the note and every reference to it.
 */
class NoteView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private label: HTMLButtonElement;
  private number: number | null | undefined;

  constructor(private node: PMNode, private view: EditorView, private getPos: () => number | undefined, decorations: readonly Decoration[], private ctx: EditorContext) {
    this.number = numberOf(decorations);
    this.dom = document.createElement('aside');
    this.dom.className = 'note note-footnote_def';
    this.label = Object.assign(document.createElement('button'), { type: 'button', className: 'note-label' });
    this.label.contentEditable = 'false';
    this.label.addEventListener('mousedown', (e) => e.preventDefault());
    this.label.addEventListener('click', (e) => {
      if (e.detail === 1) this.goToReference();
    });
    this.label.addEventListener('dblclick', () => void this.rename());
    this.contentDOM = Object.assign(document.createElement('div'), { className: 'note-body' });
    this.dom.append(this.label, this.contentDOM);
    this.render();
  }

  private get value(): string {
    return String(this.node.attrs.label ?? '');
  }

  private render() {
    this.label.textContent = this.number === undefined ? this.value : this.number === null ? '–' : String(this.number);
    this.label.classList.toggle('unused', this.number === null);
    this.label.title = this.number === null
      ? `[^${this.value}] · nothing refers to this note · click to delete it`
      : `[^${this.value}] · click to go to the reference · double-click to rename`;
  }

  private goToReference() {
    const target = findNode(this.view.state.doc, REF, this.value);
    if (target) goTo(this.view, target.pos + target.node.nodeSize);
    else void this.removeUnused();
  }

  private async removeUnused() {
    if (this.ctx.readOnly || !(await this.ctx.ui.askConfirm('Nothing refers to this note any more. Delete it?', 'Delete note', true))) return;
    const pos = this.getPos();
    if (pos === undefined || this.view.isDestroyed) return;
    this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
  }

  private async rename() {
    if (this.ctx.readOnly) return;
    const next = (await this.ctx.ui.askText('Rename note', this.value, 'Rename'))?.trim();
    const pos = this.getPos();
    if (!next || next === this.value || pos === undefined || this.view.isDestroyed) return;
    const tr = this.view.state.tr.setNodeAttribute(pos, 'label', next);
    tr.doc.descendants((node, p) => {
      if (node.type.name === REF && node.attrs.label === this.value) tr.setNodeAttribute(p, 'label', next);
    });
    this.view.dispatch(tr);
  }

  update(node: PMNode, decorations: readonly Decoration[]) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.number = numberOf(decorations);
    this.render();
    return true;
  }
  stopEvent(e: Event) { return this.label.contains(e.target as Node); }
  ignoreMutation(m: { type: string; target: Node }) { return m.type !== 'selection' && this.label.contains(m.target); }
}

// ---------------------------------------------------------------------------

/** What footnotes contribute to the Pandoc editor. */
export function footnotes(schema: Schema, ctx: EditorContext) {
  const has = !!(schema.nodes[REF] && schema.nodes[NOTE]);
  return {
    plugins: has ? [numbersPlugin()] : [],
    rules: has && schema.nodes[INLINE] ? noteRules(schema) : [],
    keys: (has ? { 'Mod-Alt-f': insertFootnote(schema) } : {}) as Record<string, Command>,
    /** Enter in a note goes back to the text. */
    enter: has ? backFromNote : null,
    /** Shift+Enter in a note is a new paragraph (elsewhere, a line break). */
    inNote: (state: EditorState) => has && noteAt(state) !== null,
    nodeViews: has
      ? ({
          [REF]: (node, view, getPos, decorations) => new RefView(node, view, getPos, decorations, ctx),
          [NOTE]: (node, view, getPos, decorations) => new NoteView(node, view, getPos, decorations, ctx),
          ...(schema.nodes[INLINE] ? { [INLINE]: (node, view, getPos, decorations) => new InlineNoteView(node, view, getPos, decorations, ctx) } : {}),
        } satisfies Record<string, NodeViewConstructor>)
      : {},
  };
}
