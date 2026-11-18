// Conflict blocks in the editor: where a merge kept two versions of a passage
// (see ../merge.ts), the page shows both, who wrote each, and a way to choose:
// keep one, or keep both one after the other. Choosing is an ordinary edit, so
// it reaches everyone, and nothing has to be chosen straight away: the rest of
// the document is edited as usual, and so are the versions themselves.
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import type { EditorView, NodeView, NodeViewConstructor } from 'prosemirror-view';
import { isConflictAttrs, isVersionAttrs } from '../merge.js';

const DIV = 'fenced_div';

/** A version's author and commit, from its attributes: `{.version by="Ada" commit="3f2c1e0"}`. */
export function versionLabel(attrs: string): string {
  const by = /\bby="([^"]*)"/.exec(attrs)?.[1] ?? 'Someone';
  const commit = /\bcommit="([^"]*)"/.exec(attrs)?.[1];
  return commit ? `${by} · ${commit}` : by;
}

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

  constructor(node: PMNode, view: EditorView, getPos: () => number | undefined, readOnly: boolean) {
    this.dom = el('div', 'conflict-version');
    this.dom.dataset.testid = 'conflict-version';
    const bar = el('div', 'conflict-version-bar');
    bar.contentEditable = 'false';
    this.label = el('span', 'conflict-by', versionLabel(String(node.attrs.attrs)));
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
    this.label.textContent = versionLabel(String(node.attrs.attrs));
    return true;
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
    if (node.type.name !== DIV || isConflictAttrs(String(node.attrs.attrs)) || isVersionAttrs(String(node.attrs.attrs))) return false;
    this.dom.dataset.attrs = String(node.attrs.attrs);
    return true;
  }
}

/** Fenced divs: conflict blocks and their versions drawn as such; any other div as before. */
export function conflictViews(readOnly: boolean): Record<string, NodeViewConstructor> {
  return {
    [DIV]: (node, view, getPos) => {
      const attrs = String(node.attrs.attrs);
      if (isConflictAttrs(attrs)) return new ConflictView(node, view, getPos, readOnly);
      if (isVersionAttrs(attrs)) {
        const pos = getPos();
        const parent = pos === undefined ? null : view.state.doc.resolve(pos).parent;
        if (parent?.type.name === DIV && isConflictAttrs(String(parent.attrs.attrs))) return new VersionView(node, view, getPos, readOnly);
      }
      return new PlainDivView(node);
    },
  };
}
