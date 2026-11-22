// Client implementations of the node view hints that document types declare.
import type { NodeViewHint } from '@kuraa/kernel';
import type { Node as PMNode } from 'prosemirror-model';
import { Selection, TextSelection } from 'prosemirror-state';
import type { EditorView as PMView, NodeView, NodeViewConstructor } from 'prosemirror-view';
import { EditorView as CMView, keymap as cmKeymap, drawSelection, lineNumbers, type ViewUpdate, type KeyBinding } from '@codemirror/view';
import { defaultKeymap, indentWithTab } from '@codemirror/commands';
import { syntaxHighlighting } from '@codemirror/language';
import { highlighter, languageSupport } from './languages.js';
import { chunkOf, describeRun, engineOf, renderOutputs, type Chunk, type ChunkRunner, type Rebuild } from './runs.js';
import { chunkName, describeBehind } from './upstream.js';
import { askText } from './ask.js';
import { defaultBlock } from './blocks.js';
import { APP_KEYS } from './keys.js';
import { S } from './strings.js';

/** What node views can use besides the document: the chunk runner, when the host runs code. */
export interface NodeViewContext {
  runner?: ChunkRunner | null;
}

/**
 * A text block edited in CodeMirror, kept in sync with ProseMirror (and so with
 * the room). A runnable block (a knitr chunk) also gets run controls in its
 * header and its latest output below; outputs are not part of the document.
 */
class CodeView implements NodeView {
  dom: HTMLElement;
  private cm: CMView;
  private updating = false;
  private label: HTMLElement | null = null;
  private input: HTMLInputElement | null = null;
  private runner: ChunkRunner | null = null;
  private actions: HTMLElement | null = null;
  private output: HTMLElement | null = null;
  private shownRun: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(private node: PMNode, private view: PMView, private getPos: () => number | undefined, private hint: Extract<NodeViewHint, { kind: 'code' }>, ctx: NodeViewContext = {}) {
    this.dom = document.createElement('div');
    this.dom.className = `code-node code-node-${node.type.name}`;
    const header = document.createElement('div');
    header.className = 'code-node-header';
    const h = hint.header;
    const editableAttr = h?.attr || hint.languageAttr;
    if (editableAttr) {
      if (h?.prefix) header.append(Object.assign(document.createElement('span'), { className: 'code-node-affix', textContent: h.prefix }));
      this.input = document.createElement('input');
      this.input.className = 'code-node-attr';
      this.input.spellcheck = false;
      this.input.value = String(node.attrs[editableAttr] ?? '');
      this.input.placeholder = hint.languageAttr ? S.code.language : '';
      this.input.addEventListener('change', () => this.setAttr(editableAttr, this.input!.value));
      header.append(this.input);
      if (h?.suffix) header.append(Object.assign(document.createElement('span'), { className: 'code-node-affix', textContent: h.suffix }));
    } else if (h?.prefix) {
      this.label = Object.assign(document.createElement('span'), { className: 'code-node-label', textContent: h.prefix });
      header.append(this.label);
    }
    if (hint.run && ctx.runner) {
      this.runner = ctx.runner;
      this.actions = document.createElement('span');
      this.actions.className = 'chunk-actions';
      header.append(this.actions);
    }
    if (header.childNodes.length) this.dom.append(header);

    const language = languageSupport(hint.language ?? (hint.languageAttr ? String(node.attrs[hint.languageAttr] ?? '') : undefined));
    this.cm = new CMView({
      doc: node.textContent,
      extensions: [
        cmKeymap.of([...this.cmKeymap(), indentWithTab, ...defaultKeymap]),
        drawSelection(),
        lineNumbers(),
        syntaxHighlighting(highlighter),
        language ?? [],
        hint.wrap === false ? [] : CMView.lineWrapping,
        CMView.editable.of(view.editable),
        CMView.updateListener.of((u) => this.forward(u)),
      ],
    });
    this.dom.append(this.cm.dom);
    if (this.runner) {
      this.output = document.createElement('div');
      this.output.className = 'chunk-output';
      this.output.contentEditable = 'false';
      this.dom.append(this.output);
      this.unsubscribe = this.runner.subscribe(() => this.renderRun());
      this.renderRun();
    }
  }

  // --- Running -------------------------------------------------------------

  private chunk(): Chunk | null {
    const pos = this.getPos();
    if (pos === undefined || !this.hint.run) return null;
    return chunkOf(this.node, this.hint, pos, this.runner?.chunkAt(pos)?.index ?? 0);
  }

  /** Whether this block can run here: asked on every change to the runs, so it reads only the header, not the code. */
  private runnable(): boolean {
    return !!this.hint.run && this.getPos() !== undefined && !!this.runner?.canRun(engineOf(this.node, this.hint));
  }

  private report(p: Promise<unknown>): void {
    p.catch((e: Error) => {
      if (this.output) this.output.prepend(Object.assign(document.createElement('pre'), { className: 'out-error', textContent: e.message }));
    });
  }

  private runChunk(): boolean {
    const c = this.chunk();
    if (!c || !this.runner?.canRun(c.engine) || this.runner.unavailable) return false;
    this.report(this.runner.run(c));
    return true;
  }

  /** ⌘↩: run the selection, or the current line and move to the next one. */
  private runLine(): boolean {
    const c = this.chunk();
    if (!c || !this.runner?.canRun(c.engine) || this.runner.unavailable) return false;
    const { state } = this.cm;
    const { main } = state.selection;
    if (!main.empty) {
      this.report(this.runner.run(c, state.sliceDoc(main.from, main.to)));
      return true;
    }
    const line = state.doc.lineAt(main.head);
    if (line.text.trim()) this.report(this.runner.run(c, line.text));
    if (line.number < state.doc.lines) this.cm.dispatch({ selection: { anchor: state.doc.line(line.number + 1).from }, scrollIntoView: true });
    return true;
  }

  private button(label: string, title: string, onClick: () => void, className = ''): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `chunk-button ${className}`;
    b.textContent = label;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      onClick();
    });
    return b;
  }

  private renderRun(): void {
    const runner = this.runner;
    const pos = this.getPos();
    if (!runner || !this.actions || !this.output || pos === undefined) return;
    if (this.ticker) clearInterval(this.ticker);
    this.ticker = null;
    if (!this.runnable()) {
      this.actions.replaceChildren();
      this.output.replaceChildren();
      this.output.hidden = true;
      this.shownRun = null;
      return;
    }
    const { last, pending, stale, upstream } = runner.state(pos);

    // How a run waiting or under way stands: here, or on another device (0062), which this one cannot stop.
    const status = pending && Object.assign(document.createElement('span'), { className: 'chunk-status' });
    if (pending && status) {
      const where = pending.device;
      const tick = () => {
        const secs = Math.round((Date.now() - Date.parse(pending.queuedAt)) / 1000);
        status.textContent = pending.state === 'queued' ? (where ? S.code.queuedOn(where) : S.code.queued) : where ? S.code.runningOn(where, secs) : S.code.running(secs);
      };
      tick();
      if (pending.state === 'running') this.ticker = setInterval(tick, 1000);
    }
    if (pending && status && !pending.device) {
      this.actions.replaceChildren(status, this.button(S.code.stop, S.code.stopTitle, () => this.report(runner.interrupt()), 'stop'));
    } else if (runner.unavailable) {
      // Where code runs is not there (Podman missing, say): Run is offered, but not to press, with why beside it.
      const run = this.button(S.code.run, runner.unavailable, () => undefined, 'run');
      run.disabled = true;
      const why = Object.assign(document.createElement('span'), { className: 'chunk-unavailable', textContent: runner.unavailable, title: runner.unavailable });
      why.dataset.testid = 'chunk-unavailable';
      this.actions.replaceChildren(...(status ? [status] : []), why, run);
    } else {
      // Offered only when the session does not have the chunks above as they now read.
      const rebuild = runner.rebuild(pos);
      this.actions.replaceChildren(
        ...(status ? [status] : []),
        ...(rebuild ? [this.button(rebuild.fresh ? S.code.runAbove : S.code.rebuildAbove, rebuildTitle(rebuild), () => this.report(runner.rebuildAbove(pos)), 'rebuild')] : []),
        this.button(S.code.run, S.code.runTitle, () => this.runChunk(), 'run'),
      );
    }

    this.output.hidden = !last;
    this.output.classList.toggle('pending', !!pending);
    this.output.classList.toggle('stale', stale || !!upstream);
    if (!last) {
      this.output.replaceChildren();
      this.shownRun = null;
      return;
    }
    const meta = document.createElement('div');
    meta.className = 'chunk-meta';
    meta.append(Object.assign(document.createElement('span'), { textContent: describeRun(last) }));
    if (stale) meta.append(Object.assign(document.createElement('span'), { className: 'chunk-stale', textContent: S.code.codeChanged, title: S.code.codeChangedTitle }));
    else if (upstream) {
      meta.append(Object.assign(document.createElement('span'), {
        className: 'chunk-stale upstream',
        textContent: describeBehind(upstream),
        title: S.code.upstreamTitle(chunkName(upstream.chunk), upstream.why),
      }));
    }
    meta.append(this.button('×', S.code.clear, () => this.report(runner.clear(pos)), 'clear'));
    if (this.shownRun === last.id && this.output.firstChild) {
      this.output.firstChild.replaceWith(meta);
      return;
    }
    this.shownRun = last.id;
    const body = document.createElement('div');
    body.className = 'chunk-outputs';
    const rendered = renderOutputs(last.outputs);
    body.append(...(rendered.length ? rendered : [Object.assign(document.createElement('div'), { className: 'out-none', textContent: S.code.noOutput })]));
    this.output.replaceChildren(meta, body);
  }

  private setAttr(name: string, value: string) {
    const pos = this.getPos();
    if (pos === undefined) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, [name]: value }));
  }

  private forward(update: ViewUpdate) {
    if (this.updating || !this.cm.hasFocus) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    let offset = pos + 1;
    const { main } = update.state.selection;
    const selFrom = offset + main.from;
    const selTo = offset + main.to;
    const pmSel = this.view.state.selection;
    if (update.docChanged || pmSel.from !== selFrom || pmSel.to !== selTo) {
      const tr = this.view.state.tr;
      update.changes.iterChanges((fromA, toA, fromB, toB, text) => {
        if (text.length) tr.replaceWith(offset + fromA, offset + toA, this.view.state.schema.text(text.toString()));
        else tr.delete(offset + fromA, offset + toA);
        offset += toB - fromB - (toA - fromA);
      });
      tr.setSelection(TextSelection.create(tr.doc, selFrom, selTo));
      this.view.dispatch(tr);
    }
  }

  private cmKeymap(): KeyBinding[] {
    return [
      { key: 'ArrowUp', run: () => this.escape('line', -1) },
      { key: 'ArrowLeft', run: () => this.escape('char', -1) },
      { key: 'ArrowDown', run: () => this.escape('line', 1) },
      { key: 'ArrowRight', run: () => this.escape('char', 1) },
      // In a runnable chunk ⌘↩ runs the line (as in RStudio); elsewhere it leaves the block.
      { key: APP_KEYS.runLine, run: () => (this.runnable() ? this.runLine() : this.exitBelow()) },
      { key: APP_KEYS.runChunk, run: () => this.runChunk() },
      {
        // The markdown cue: a closing fence on the last line, then Enter, ends the block.
        key: 'Enter',
        run: () => {
          const { state } = this.cm;
          const { main } = state.selection;
          const line = state.doc.lineAt(main.head);
          if (!main.empty || line.number !== state.doc.lines || !/^\s*(`{3,}|~{3,})\s*$/.test(line.text)) return false;
          return this.exitBelow(line.number > 1 ? line.from - 1 : line.from, line.to);
        },
      },
    ];
  }

  /** Leave the code block for a new paragraph below it, first removing [from, to) of its text. */
  private exitBelow(from?: number, to?: number): boolean {
    const pos = this.getPos();
    if (pos === undefined) return false;
    const { state } = this.view;
    const tr = state.tr;
    if (from !== undefined && to !== undefined && to > from) tr.delete(pos + 1 + from, pos + 1 + to);
    const after = tr.mapping.map(pos + this.node.nodeSize);
    const block = defaultBlock(state.schema);
    if (!block) return false;
    tr.insert(after, block.create());
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
    return true;
  }

  private escape(unit: 'line' | 'char', dir: 1 | -1): boolean {
    const { state } = this.cm;
    const { main } = state.selection;
    if (!main.empty) return false;
    if (unit === 'line') {
      const line = state.doc.lineAt(main.head);
      if (dir < 0 ? line.from > 0 : line.to < state.doc.length) return false;
    } else if (dir < 0 ? main.from > 0 : main.to < state.doc.length) return false;
    const pos = this.getPos();
    if (pos === undefined) return false;
    const target = pos + (dir < 0 ? 0 : this.node.nodeSize);
    const $target = this.view.state.doc.resolve(target);
    const found = Selection.findFrom($target, dir, true);
    // Nothing to move to (the block starts or ends the document): make a paragraph to type in.
    if (!found) return dir > 0 ? this.exitBelow() : this.exitAbove();
    this.view.dispatch(this.view.state.tr.setSelection(found).scrollIntoView());
    this.view.focus();
    return true;
  }

  private exitAbove(): boolean {
    const pos = this.getPos();
    const block = defaultBlock(this.view.state.schema);
    if (pos === undefined || !block) return false;
    const tr = this.view.state.tr.insert(pos, block.create());
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    this.view.dispatch(tr.scrollIntoView());
    this.view.focus();
    return true;
  }

  setSelection(anchor: number, head: number) {
    this.cm.focus();
    this.updating = true;
    this.cm.dispatch({ selection: { anchor, head } });
    this.updating = false;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    const attr = this.hint.header?.attr || this.hint.languageAttr;
    if (this.input && attr && document.activeElement !== this.input) this.input.value = String(node.attrs[attr] ?? '');
    if (this.updating) return true;
    const next = node.textContent;
    const cur = this.cm.state.doc.toString();
    if (next !== cur) {
      let start = 0;
      let curEnd = cur.length;
      let nextEnd = next.length;
      while (start < curEnd && cur.charCodeAt(start) === next.charCodeAt(start)) start++;
      while (curEnd > start && nextEnd > start && cur.charCodeAt(curEnd - 1) === next.charCodeAt(nextEnd - 1)) { curEnd--; nextEnd--; }
      this.updating = true;
      this.cm.dispatch({ changes: { from: start, to: curEnd, insert: next.slice(start, nextEnd) } });
      this.updating = false;
    }
    return true;
  }

  selectNode() { this.cm.focus(); }
  stopEvent(e: Event) { return this.dom.contains(e.target as Node) && !(e.type === 'mousedown' && e.target === this.dom); }
  ignoreMutation() { return true; }
  destroy() {
    this.unsubscribe?.();
    if (this.ticker) clearInterval(this.ticker);
    this.cm.destroy();
  }
}

/** An inline atom shown as a chip (citation, inline math, raw markup); double-click to edit its source. */
class AtomView implements NodeView {
  dom: HTMLElement;
  constructor(private node: PMNode, private view: PMView, private getPos: () => number | undefined, private hint: Extract<NodeViewHint, { kind: 'atom' }>) {
    this.dom = document.createElement('span');
    this.dom.className = `atom ${hint.className ?? ''}`;
    this.render();
    this.dom.title = S.code.doubleClick;
    this.dom.addEventListener('dblclick', (e) => {
      e.preventDefault();
      if (!this.view.editable) return;
      void askText(S.code.editAtom(this.node.type.name.replace(/_/g, ' ')), String(this.node.attrs[this.hint.attr] ?? ''), S.common.save).then((value) => {
        const pos = this.getPos();
        if (value === null || pos === undefined || this.view.isDestroyed) return;
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, [this.hint.attr]: value }));
      });
    });
  }
  private render() {
    this.dom.textContent = `${this.hint.prefix ?? ''}${String(this.node.attrs[this.hint.attr] ?? '')}${this.hint.suffix ?? ''}`;
  }
  update(node: PMNode) {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
  ignoreMutation() { return true; }
}

export function buildNodeViews(hints: Record<string, NodeViewHint>, ctx: NodeViewContext = {}): Record<string, NodeViewConstructor> {
  const out: Record<string, NodeViewConstructor> = {};
  for (const [name, hint] of Object.entries(hints)) {
    out[name] = (node, view, getPos) =>
      hint.kind === 'code' ? new CodeView(node, view, getPos, hint, ctx) : new AtomView(node, view, getPos, hint);
  }
  return out;
}

/** What Rebuild above does, and why it is offered. */
function rebuildTitle(r: Rebuild): string {
  const n = r.chunks.length;
  return r.fresh ? S.code.rebuildFresh(n) : S.code.rebuildWhy(chunkName(r.chunk), r.why, n);
}
