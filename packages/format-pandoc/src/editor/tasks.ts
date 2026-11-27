// Task lists, as Pandoc and GitHub write them (`- [ ] To do`, `- [x] Done`):
//
// - a box drawn before each task item, ticked and unticked by a click (shown,
//   not to be clicked, where the document is read only);
// - "[ ] " or "[x] " typed at the start of a list item makes it a task ("- [ ] "
//   at the start of a line: a bullet, then a task);
// - Enter in a task, a new unticked task after it;
// - Backspace at the start of a task, its box gone (the item kept), as
//   Backspace undoes the other cues.
import type { Node, NodeType, Schema } from 'prosemirror-model';
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from 'prosemirror-state';
import { Decoration, DecorationSet, type EditorView } from 'prosemirror-view';
import { InputRule } from 'prosemirror-inputrules';

const isItem = (node: Node | null | undefined): node is Node => node?.type.name === 'list_item';
const isTask = (node: Node | null | undefined) => isItem(node) && node.attrs.checked !== null;

/** The depth of the innermost list item the position is in, or -1. */
function itemDepth(state: EditorState, $pos = state.selection.$from): number {
  for (let d = $pos.depth; d > 0; d--) if (isItem($pos.node(d))) return d;
  return -1;
}

function box(view: EditorView, getPos: () => number | undefined, checked: boolean, readOnly: boolean): HTMLElement {
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'task-box';
  input.checked = checked;
  input.disabled = readOnly;
  input.tabIndex = -1;
  input.contentEditable = 'false';
  input.setAttribute('aria-label', checked ? 'Done' : 'To do');
  // The editor's selection stays where it is.
  input.addEventListener('mousedown', (e) => e.preventDefault());
  input.addEventListener('click', (e) => {
    e.preventDefault();
    const at = getPos();
    if (at === undefined || !view.editable) return;
    const item = view.state.doc.nodeAt(at - 1);
    if (!isTask(item)) return;
    view.dispatch(view.state.tr.setNodeMarkup(at - 1, undefined, { ...item!.attrs, checked: !item!.attrs.checked }));
  });
  return input;
}

function boxes(doc: Node, readOnly: boolean): DecorationSet {
  const found: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.isTextblock) return false;
    if (isTask(node)) {
      const checked = !!node.attrs.checked;
      found.push(Decoration.widget(pos + 1, (view, getPos) => box(view, getPos, checked, readOnly), {
        side: -1, key: `task-${checked}`, ignoreSelection: true, stopEvent: () => true,
      }));
    }
    return true;
  });
  return DecorationSet.create(doc, found);
}

/** The boxes of a document's tasks. */
export function taskPlugin(readOnly: boolean): Plugin {
  const key = new PluginKey<DecorationSet>('tasks');
  return new Plugin<DecorationSet>({
    key,
    state: {
      init: (_c, state) => boxes(state.doc, readOnly),
      apply: (tr, set) => (tr.docChanged ? boxes(tr.doc, readOnly) : set),
    },
    props: { decorations: (state) => key.getState(state) },
  });
}

/**
 * "[ ] ", "[] " or "[x] " at the start of a list item: the item, a task. In a
 * task with nothing else in it (the one Enter made after a task), ticked or not as typed.
 */
export function taskRules(schema: Schema): InputRule[] {
  if (!schema.nodes.list_item) return [];
  return [new InputRule(/^\[([ xX]?)\]\s$/, (state, m, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.depth < 2 || $start.parentOffset !== 0 || $start.index(-1) !== 0) return null;
    const item = $start.node(-1);
    const empty = item.childCount === 1 && end === $start.end();
    if (!isItem(item) || (item.attrs.checked !== null && !empty)) return null;
    return state.tr.delete(start, end).setNodeMarkup($start.before(-1), undefined, { ...item.attrs, checked: /x/i.test(m[1] ?? '') });
  })];
}

/** Enter in a task (`split` being the list's Enter): the new item a task not yet done. */
export const splitTask = (split: Command): Command => (state, dispatch, view) => {
  const d = itemDepth(state);
  const { $from } = state.selection;
  const item = d > 0 ? $from.node(d) : null;
  // Not a ticked task, or an empty one (Enter takes it out of the list): as any item.
  if (!item || item.attrs.checked !== true || (item.childCount === 1 && $from.parent.content.size === 0)) return split(state, dispatch, view);
  // At the very start of the item, the new one is the empty one before it.
  const atStart = $from.parentOffset === 0 && $from.index(d) === 0;
  return split(state, dispatch && ((tr) => {
    const $at = tr.selection.$from;
    const e = itemDepth(state, $at);
    if (e > 0) {
      let pos = $at.before(e);
      let made: Node | null | undefined = $at.node(e);
      if (atStart) {
        const index = $at.index(e - 1);
        made = index > 0 ? $at.node(e - 1).child(index - 1) : null;
        pos = made ? pos - made.nodeSize : pos;
      }
      if (made && isTask(made) && made.attrs.checked) tr.setNodeMarkup(pos, undefined, { ...made.attrs, checked: false });
    }
    dispatch(tr);
  }), view);
};

/** Backspace at the start of a task: its box gone, the item kept. */
export const untask = (item: NodeType): Command => (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const $at = selection.$from;
  if ($at.parentOffset > 0 || $at.depth < 2 || $at.node(-1).type !== item || $at.index(-1) !== 0) return false;
  const task = $at.node(-1);
  if (task.attrs.checked === null) return false;
  if (dispatch) dispatch(state.tr.setNodeMarkup($at.before(-1), undefined, { ...task.attrs, checked: null }));
  return true;
};
