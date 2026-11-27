// Bullets and numbers, one inside the other. Tab puts an item in a level as a
// list of the same kind; these turn a list, or an item, into the other kind:
//
// - ⌘⇧8 or ⌘⇧7 in a list of the other kind turns the innermost list the
//   selection is in into bullets or numbers (outside a list, it makes one).
// - "- " or "1. " typed in an empty item of a list of the other kind turns that
//   item alone into a list of that kind, where it is (the items before and after
//   it stay as they were), so Enter, Tab, "- " under "1. First" gives bullets
//   inside a numbered item, as Pandoc writes them.
//
// Two lists of one kind side by side are read back from the file as one, so a
// list next to one of the kind it becomes is made one with it now.
import type { Attrs, Node, NodeType, Schema } from 'prosemirror-model';
import { TextSelection, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { liftListItem } from 'prosemirror-schema-list';
import { InputRule } from 'prosemirror-inputrules';

const isList = (node: Node) => node.type.name === 'bullet_list' || node.type.name === 'ordered_list';

/** The depth of the innermost list holding the whole selection, or -1. */
function listDepth(state: EditorState): number {
  const { $from, $to } = state.selection;
  for (let d = $from.depth; d > 0; d--) {
    if (!isList($from.node(d))) continue;
    return $to.depth >= d && $to.before(d) === $from.before(d) ? d : -1;
  }
  return -1;
}

/**
 * Turn items `from` to `to` (exclusive) of the list at `pos` into a list of
 * `type`, the items before and after staying lists of their own kind: split
 * from them, so the selection stays where it was. Numbers after carry on from
 * the numbered items before them (the ones turned are not counted); else they
 * start as the list did.
 * Joined to a list of `type` next to it.
 */
function convert(tr: Transaction, pos: number, from: number, to: number, type: NodeType, attrs: Attrs): void {
  const list = tr.doc.nodeAt(pos)!;
  const startOf = (index: number) => {
    let at = pos + 1;
    for (let i = 0; i < index; i++) at += list.child(i).nodeSize;
    return at;
  };
  // The later split first, so the earlier one's place is as it was.
  if (to < list.childCount) {
    const order = list.type.name === 'ordered_list' && from > 0 ? { order: Number(list.attrs.order ?? 1) + from } : {};
    tr.split(startOf(to), 1, [{ type: list.type, attrs: { ...list.attrs, ...order } }]);
  }
  let at = pos;
  if (from > 0) {
    tr.split(startOf(from), 1);
    at = startOf(from) + 1;
  }
  tr.setNodeMarkup(at, type, { ...attrs, tight: list.attrs.tight });
  const end = at + tr.doc.nodeAt(at)!.nodeSize;
  // Joined to a list of its new kind just after it, then just before it.
  if (tr.doc.resolve(end).nodeAfter?.type === type) tr.join(end);
  if (tr.doc.resolve(at).nodeBefore?.type === type) tr.join(at);
}

/** ⌘⇧8, ⌘⇧7 in a list of the other kind: that list, as `type`. False elsewhere (so the list is made instead). */
export const switchList = (type: NodeType, attrs: Attrs = {}): Command => (state, dispatch) => {
  const d = listDepth(state);
  if (d < 0) return false;
  const list = state.selection.$from.node(d);
  if (list.type === type) return false;
  if (dispatch) {
    const tr = state.tr;
    convert(tr, state.selection.$from.before(d), 0, list.childCount, type, attrs);
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/** "- " or "1. " typed in an empty item of a list of the other kind: that item, as a list of `type`. */
function itemRule(match: RegExp, type: NodeType, attrs: (m: RegExpMatchArray) => Attrs): InputRule {
  return new InputRule(match, (state, m, start, end) => {
    const $start = state.doc.resolve(start);
    if ($start.depth < 3) return null;
    const para = $start.parent;
    const item = $start.node(-1);
    const list = $start.node(-2);
    if (!para.isTextblock || item.type.name !== 'list_item' || !isList(list) || list.type === type) return null;
    // Nothing in the item but what was just typed.
    if ($start.parentOffset !== 0 || end !== $start.end() || item.childCount !== 1) return null;
    const index = $start.index(-2);
    // The cursor, where the cue was, is carried through the splits.
    const tr = state.tr.delete(start, end);
    convert(tr, $start.before(-2), index, index + 1, type, attrs(m));
    return tr;
  });
}

/** The typing cues that turn an empty item into the other kind of list, tried before those that make a list. */
export function listRules(schema: Schema): InputRule[] {
  const n = schema.nodes;
  if (!n.bullet_list || !n.ordered_list) return [];
  return [
    itemRule(/^\s*([-+*])\s$/, n.bullet_list, (x) => ({ bullet: x[1] === '*' ? '*' : x[1] })),
    itemRule(/^(\d+)\.\s$/, n.ordered_list, (x) => ({ order: Number(x[1]) })),
  ];
}

/**
 * Backspace at the very start of a list item: the item a level out (out of the
 * list, at the top level), as Enter in an empty item does. Not joined to the
 * item before it, which would put what comes next inside that item (a heading
 * typed after it, say) where nothing shows it is.
 */
export const liftAtItemStart = (item: NodeType): Command => (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const $at = selection.$from;
  if ($at.parentOffset > 0 || $at.depth < 2 || $at.node(-1).type !== item || $at.index(-1) !== 0) return false;
  return liftListItem(item)(state, dispatch);
};

/**
 * Backspace at the start of a paragraph just after a list: up to the end of the
 * list's last line, the paragraph's text joined to it (an empty one gone), as a
 * word processor does. ProseMirror's own Backspace would put the paragraph back
 * in the list as an item, so the number Backspace took away (liftAtItemStart)
 * came back, and the next took it away again.
 */
export const joinAfterList: Command = (state, dispatch) => {
  const { selection } = state;
  if (!(selection instanceof TextSelection) || !selection.empty) return false;
  const $at = selection.$from;
  const para = $at.parent;
  if ($at.parentOffset > 0 || para.type.name !== 'paragraph' || $at.depth < 1) return false;
  const index = $at.index(-1);
  if (index === 0) return false;
  const list = $at.node(-1).child(index - 1);
  if (!isList(list)) return false;
  // The list's last line: the last textblock in it, however deep.
  let last: Node = list;
  let end = $at.before() - 1; // just inside the list's end
  while (!last.isTextblock) {
    const child = last.lastChild;
    if (!child) return false;
    last = child;
    end -= 1; // into the child, past its closing token
  }
  if (!last.type.validContent(last.content.append(para.content))) return false;
  if (dispatch) {
    const tr = state.tr.delete($at.before(), $at.after());
    if (para.content.size) tr.insert(end, para.content);
    dispatch(tr.setSelection(TextSelection.create(tr.doc, end)).scrollIntoView());
  }
  return true;
};
