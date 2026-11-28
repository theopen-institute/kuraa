// Conflict blocks in the editor: where a merge kept two versions of a passage
// (see ../merge.ts), the page shows both, who wrote each, and a way to choose:
// keep one, or keep both one after the other. Choosing is an ordinary edit, so
// it reaches everyone, and nothing has to be chosen straight away: the rest of
// the document is edited as usual, and so are the versions themselves.
import type { EditorContext } from '@kuraa/editor-kit';
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { TextSelection, type Command } from 'prosemirror-state';
import type { EditorView, NodeView, NodeViewConstructor } from 'prosemirror-view';
import { isConflictAttrs, isVersionAttrs } from '../merge.js';
import { hasClass } from '../attributes.js';

const DIV = 'fenced_div';

/** A version's author and commit, from its attributes: `{.version by="Ada" commit="3f2c1e0"}`. */
export function versionOf(attrs: string): { by: string; commit: string | null } {
  return { by: /\bby="([^"]*)"/.exec(attrs)?.[1] || 'Someone', commit: /\bcommit="([^"]*)"/.exec(attrs)?.[1] ?? null };
}

/** How a version is labelled before (or without) knowing when its commit was made: who, and the commit. */
export function versionLabel(attrs: string): string {
  const { by, commit } = versionOf(attrs);
  return commit ? `${by} · ${commit}` : by;
}

/** "Ada, 3 November at 14:05": who wrote a version, and when they committed it (the year if not this one). */
export function versionDateLabel(by: string, date: string, now = new Date()): string {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return by;
  const sameYear = d.getFullYear() === now.getFullYear();
  const day = d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', ...(sameYear ? {} : { year: 'numeric' }) });
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
  return `${by}, ${day} at ${time}`;
}

/** Where each conflict block starts. */
export function conflictPositions(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === DIV && isConflictAttrs(String(node.attrs.attrs))) {
      out.push(pos);
      return false;
    }
    return true;
  });
  return out;
}

/** The next conflict after the cursor (round to the first): the cursor goes into its first version. */
export const nextConflict: Command = (state, dispatch, view) => {
  const all = conflictPositions(state.doc);
  if (!all.length) return false;
  const after = all.find((p) => p > state.selection.from) ?? all[0]!;
  if (dispatch) {
    const sel = TextSelection.findFrom(state.doc.resolve(after + 1), 1, true);
    const tr = state.tr;
    if (sel) tr.setSelection(sel);
    dispatch(tr.scrollIntoView());
    // Bring the whole block into view, not only the line.
    (view?.nodeDOM(after) as HTMLElement | null)?.scrollIntoView?.({ block: 'center' });
  }
  return true;
};

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
};

function button(label: string, title: string, testid: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', 'conflict-button', label);
  b.type = 'button';
  b.title = title;
  b.dataset.testid = testid;
  // Keep the editor's selection: act on click, not on the mousedown that would move it.
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', (e) => {
    e.preventDefault();
    onClick();
  });
  return b;
}

/** Replace the conflict block at `pos` with some of its versions' content, in order. */
function resolve(view: EditorView, pos: number, keep: number[]): void {
  const node = view.state.doc.nodeAt(pos);
  if (!node || node.type.name !== DIV || !isConflictAttrs(String(node.attrs.attrs))) return;
  const parts: Fragment[] = [];
  node.forEach((child, _offset, i) => {
    if (keep.includes(i)) parts.push(child.type.name === DIV && isVersionAttrs(String(child.attrs.attrs)) ? child.content : Fragment.from(child));
  });
  let content = parts[0]!;
  for (const p of parts.slice(1)) content = content.append(p);
  view.dispatch(view.state.tr.replaceWith(pos, pos + node.nodeSize, content).scrollIntoView());
  view.focus();
}

class ConflictView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, readOnly: boolean) {
    this.dom = el('div', 'conflict-block');
    this.dom.dataset.testid = 'conflict';
    const bar = el('div', 'conflict-bar');
    bar.contentEditable = 'false';
    bar.append(el('span', 'conflict-title', 'Two versions of this passage'));
    if (!readOnly) {
      bar.append(button('Keep both', 'Keep both versions, one after the other', 'conflict-keep-both', () => {
        const pos = getPos();
        if (pos !== undefined) resolve(view, pos, [...Array(view.state.doc.nodeAt(pos)?.childCount ?? 0).keys()]);
      }));
    }
    this.contentDOM = el('div', 'conflict-versions');
    this.dom.append(bar, this.contentDOM);
    void node;
  }

  update(node: PMNode): boolean {
    return node.type.name === DIV && isConflictAttrs(String(node.attrs.attrs));
  }

  stopEvent(e: Event): boolean {
    return (e.target as HTMLElement).closest?.('.conflict-bar') !== null;
  }

  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return !this.contentDOM.contains(m.target);
  }
}

class VersionView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private readonly label: HTMLElement;

  private shown = '';

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, readOnly: boolean, private readonly ctx?: EditorContext) {
    this.dom = el('div', 'conflict-version');
    this.dom.dataset.testid = 'conflict-version';
    const bar = el('div', 'conflict-version-bar');
    bar.contentEditable = 'false';
    this.label = el('span', 'conflict-by');
    this.label.dataset.testid = 'conflict-by';
    this.labelFor(String(node.attrs.attrs));
    bar.append(this.label);
    if (!readOnly) {
      bar.append(button('Keep this', 'Keep this version, and drop the other', 'conflict-keep', () => {
        const pos = getPos();
        if (pos === undefined) return;
        const $pos = view.state.doc.resolve(pos);
        resolve(view, $pos.before(), [$pos.index()]);
      }));
    }
    this.contentDOM = el('div', 'conflict-version-body');
    this.dom.append(bar, this.contentDOM);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== DIV || !isVersionAttrs(String(node.attrs.attrs))) return false;
    this.labelFor(String(node.attrs.attrs));
    return true;
  }

  /** Who and when: the date its commit was made once the host says, the commit until then. */
  private labelFor(attrs: string): void {
    if (attrs === this.shown) return;
    this.shown = attrs;
    const { by, commit } = versionOf(attrs);
    this.label.textContent = versionLabel(attrs);
    this.label.title = commit ? `Commit ${commit}` : '';
    if (!commit || !this.ctx?.files) return;
    void this.ctx.files.commit(commit).then((info) => {
      if (info && this.shown === attrs) this.label.textContent = versionDateLabel(by, info.date);
    }, () => undefined);
  }

  stopEvent(e: Event): boolean {
    return (e.target as HTMLElement).closest?.('.conflict-version-bar') !== null;
  }

  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return !this.contentDOM.contains(m.target);
  }
}

class PlainDivView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  constructor(node: PMNode) {
    this.dom = this.contentDOM = el('div', 'fenced-div');
    this.dom.dataset.attrs = String(node.attrs.attrs);
  }
  update(node: PMNode): boolean {
    const attrs = String(node.attrs.attrs);
    if (node.type.name !== DIV || isConflictAttrs(attrs) || isVersionAttrs(attrs) || hasClass(attrs, 'columns') || hasClass(attrs, 'column')) return false;
    this.dom.dataset.attrs = String(node.attrs.attrs);
    return true;
  }
}

/** Fenced divs: conflict blocks and their versions drawn as such; any other div as before. */
export function conflictViews(readOnly: boolean, ctx?: EditorContext): Record<string, NodeViewConstructor> {
  return {
    [DIV]: (node, view, getPos) => {
      const attrs = String(node.attrs.attrs);
      if (isConflictAttrs(attrs)) return new ConflictView(node, view, getPos, readOnly);
      if (isVersionAttrs(attrs)) {
        const pos = getPos();
        const parent = pos === undefined ? null : view.state.doc.resolve(pos).parent;
        if (parent?.type.name === DIV && isConflictAttrs(String(parent.attrs.attrs))) return new VersionView(node, view, getPos, readOnly, ctx);
      }
      return new PlainDivView(node);
    },
  };
}
