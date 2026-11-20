// The editable Source view: the document as markdown, in CodeMirror, kept in
// step with the live document in both directions.
//
//   Source → document: on every change, the markdown is parsed and the live
//   document gets only what differs, found down to the character
//   (findDiffStart/findDiffEnd), as one replace. y-prosemirror turns that into
//   character-level changes in the room, so a collaborator typing elsewhere,
//   even in the same paragraph, keeps their text.
//
//   Document → source: when the document changes otherwise (another person, the
//   host merging an outside edit, a format's behaviour such as arranging
//   footnotes), it is serialized against the source text as it is, so untouched
//   blocks keep their exact text, and CodeMirror gets only what differs; the
//   cursor stays put.
//
// Both directions run at once, so neither side works from a stale copy of the
// other: a source edit cannot undo a change it has not seen. One subtlety: a
// keystroke reaches the page before CodeMirror reads it (on the next frame), and
// CodeMirror drops unread input when it is updated from outside. So when a change
// arrives from elsewhere, the source first reads pending input, the two edits are
// merged as text against the source they both started from, and the user's edit
// reaches the document just after (not inside y-prosemirror's handling of the
// incoming change, which would ignore it).
import type { DocumentType, ParsedDocument } from '@kuraa/kernel';
import { DELIBERATE_EDIT } from '@kuraa/editor-kit';
import type { Node as PMNode } from 'prosemirror-model';
import type { Transaction as PMTransaction } from 'prosemirror-state';
import { StepMap } from 'prosemirror-transform';
import type { EditorView as PMView } from 'prosemirror-view';
import { Annotation, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { markdown } from '@codemirror/lang-markdown';
import { search, searchKeymap } from '@codemirror/search';
import { highlighter } from './languages.js';

/** Marks document transactions made from the source view, so they are not echoed back. */
export const FROM_SOURCE = 'kuraa-from-source';
/** Marks source changes made from the document, so they are not applied back. */
const fromDocument = Annotation.define<boolean>();

/** The smallest replace that turns `from` into `to`: positions in `from`, and the slice of `to`. */
function minimalReplace(from: PMNode, to: PMNode): { start: number; endA: number; endB: number } | null {
  const start = from.content.findDiffStart(to.content);
  if (start === null || start === undefined) return null;
  let { a: endA, b: endB } = from.content.findDiffEnd(to.content)!;
  // When the change repeats nearby text, the end can run before the start.
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  return { start, endA, endB };
}

/** Apply both changes to `base`, each found against it; where they overlap, theirs then ours. */
function merge3(base: string, ours: string, theirs: string): string {
  const a = textChange(base, ours);
  const b = textChange(base, theirs);
  if (!a) return theirs;
  if (!b) return ours;
  if (a.to <= b.from) return base.slice(0, a.from) + a.insert + base.slice(a.to, b.from) + b.insert + base.slice(b.to);
  if (b.to <= a.from) return base.slice(0, b.from) + b.insert + base.slice(b.to, a.from) + a.insert + base.slice(a.to);
  // Overlapping edits to the same characters: keep both, theirs first.
  const from = Math.min(a.from, b.from);
  const to = Math.max(a.to, b.to);
  return base.slice(0, from) + b.insert + a.insert + base.slice(to);
}

/** Prefix and suffix the two strings share: the one span that differs. */
function textChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  const min = Math.min(a.length, b.length);
  let start = 0;
  while (start < min && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

export class SourceEditor {
  private readonly cm: EditorView;
  /** The source text that matches the live document as last synced. */
  private base: string;
  /** Inside fromDocument: local input read there waits until it is done. */
  private incoming = false;
  private pendingLocal = false;
  /** The last text parsed, and its parse: each keystroke parses the source before and after, and the next one's before is this one's after. */
  private parsed: { text: string; result: ParsedDocument } | null = null;

  constructor(parent: HTMLElement, private readonly view: PMView, private readonly type: DocumentType, initial: string) {
    this.base = initial;
    this.cm = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          drawSelection(),
          history(),
          // ⌘F: find and replace in the source, with CodeMirror's own bar; replacing is ordinary editing.
          search({ top: true }),
          keymap.of([...searchKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab]),
          markdown(),
          syntaxHighlighting(highlighter),
          EditorView.lineWrapping,
          EditorView.contentAttributes.of({ 'data-testid': 'source-editor', spellcheck: 'true' }),
          EditorView.updateListener.of((u) => {
            if (!u.docChanged || u.transactions.every((t) => t.annotation(fromDocument))) return;
            if (this.incoming) this.pendingLocal = true;
            else this.toDocument();
          }),
        ],
      }),
    });
  }

  private parse(text: string): ParsedDocument {
    if (this.parsed?.text !== text) this.parsed = { text, result: this.type.parse(text) };
    return this.parsed.result;
  }

  get text(): string {
    return this.cm.state.doc.toString();
  }

  focus(): void {
    this.cm.focus();
  }

  /**
   * The source changed: give the live document what the user changed, and only
   * that. The change is found between the source before and after (parsed the
   * same way, so markdown's normalising, such as dropping a space at the end of
   * a paragraph, cancels out), then moved onto the live document, which may
   * differ from the parsed source in such details (a collaborator's trailing
   * space, say) and must keep them.
   */
  private toDocument(): void {
    if (this.view.isDestroyed) return;
    let before: PMNode;
    let parsed: PMNode;
    try {
      before = this.parse(this.base).doc;
      parsed = this.parse(this.text).doc;
    } catch {
      return; // formats do not throw, but a half-typed construct must never break editing
    }
    this.base = this.text;
    const local = minimalReplace(before, parsed);
    if (!local) return;
    const live = this.view.state.doc;
    let from = local.start;
    let to = local.endA;
    const drift = minimalReplace(before, live);
    if (drift) {
      const map = new StepMap([drift.start, drift.endA - drift.start, drift.endB - drift.start]);
      from = map.map(from, -1);
      to = map.map(to, 1);
    }
    let tr = this.view.state.tr;
    try {
      tr.replace(from, Math.max(from, to), parsed.slice(local.start, local.endB));
    } catch {
      // The positions did not fit after all: fall back to the whole difference.
      const whole = minimalReplace(live, parsed);
      if (!whole) return;
      tr = this.view.state.tr.replace(whole.start, whole.endA, parsed.slice(whole.start, whole.endB));
    }
    tr.setMeta(FROM_SOURCE, true);
    tr.setMeta(DELIBERATE_EDIT, true); // the header can be edited here
    this.view.dispatch(tr);
    // The format may have tidied the result (footnotes kept in order, say): show that.
    if (!this.view.state.doc.eq(parsed)) this.fromDocument();
  }

  /** Make CodeMirror read input that has reached the page but not yet its state. */
  private readPendingInput(): void {
    (this.cm as unknown as { observer?: { forceFlush?: () => void } }).observer?.forceFlush?.();
  }

  /** The document changed otherwise: give the source what differs, keeping untouched blocks' text. */
  fromDocument(): void {
    this.incoming = true;
    try {
      this.readPendingInput();
      const current = this.text;
      // The document's new text, against the source it last matched; then the
      // user's unsynced edit (if any) on top.
      const theirs = this.type.serialize(this.view.state.doc, this.parse(this.base));
      const merged = merge3(this.base, current, theirs);
      this.base = theirs;
      const change = textChange(current, merged);
      if (change) this.cm.dispatch({ changes: change, annotations: fromDocument.of(true) });
    } catch {
      // A format never throws on its own output; if it did, leave the source as it is.
    } finally {
      this.incoming = false;
    }
    if (this.pendingLocal || this.text !== this.base) {
      this.pendingLocal = false;
      queueMicrotask(() => this.toDocument());
    }
  }

  /** Call from the editor's dispatch: changes not made here are shown here. */
  documentChanged(tr: PMTransaction): void {
    if (tr.docChanged && !tr.getMeta(FROM_SOURCE)) this.fromDocument();
  }

  destroy(): void {
    this.cm.destroy();
  }
}
