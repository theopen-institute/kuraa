// Editor commands: one list drives the toolbar, the palette and the key bindings.
import type { MarkType, NodeType, Schema } from 'prosemirror-model';
import { type Command, type EditorState, TextSelection } from 'prosemirror-state';
import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark, wrapIn, lift } from 'prosemirror-commands';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { InputRule, inputRules, textblockTypeInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { askText } from './ask.js';
import type { Plugin } from 'prosemirror-state';

export interface EditorCommand {
  id: string;
  title: string;
  group: 'mark' | 'block' | 'insert' | 'history';
  icon?: string;
  keys?: string;
  command: Command;
  active?: (state: EditorState) => boolean;
}

function markActive(state: EditorState, type: MarkType): boolean {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
}

function blockActive(state: EditorState, type: NodeType, attrs: Record<string, unknown> = {}): boolean {
  const { $from } = state.selection;
  const node = $from.parent;
  return node.type === type && Object.entries(attrs).every(([k, v]) => node.attrs[k] === v);
}

const insertNode = (type: NodeType | undefined, attrs?: Record<string, unknown>): Command => (state, dispatch) => {
  if (!type) return false;
  const node = type.createAndFill(attrs);
  if (!node) return false;
  if (dispatch) {
    const tr = state.tr.replaceSelectionWith(node);
    const pos = tr.selection.from;
    if (node.isTextblock || node.type.spec.code) tr.setSelection(TextSelection.near(tr.doc.resolve(Math.max(0, pos - node.nodeSize + 1))));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

const toggleLink: (schema: Schema) => Command = (schema) => (state, dispatch, view) => {
  const link = schema.marks.link!;
  if (markActive(state, link)) return toggleMark(link)(state, dispatch);
  if (state.selection.empty || !view) return false;
  if (dispatch) {
    void askText('Link address', 'https://', 'Add link').then((href) => {
      href = href?.trim() ?? '';
      if (!href || view.isDestroyed) return;
      // Use the selection as it is now: remote edits made while the dialog was open have moved it.
      const { from, to, empty } = view.state.selection;
      if (!empty) view.dispatch(view.state.tr.addMark(from, to, link.create({ href })));
      view.focus();
    });
  }
  return true;
};

export function editorCommands(schema: Schema, history: { undo: Command; redo: Command }): EditorCommand[] {
  const m = schema.marks;
  const n = schema.nodes;
  const cmds: EditorCommand[] = [
    { id: 'mark.strong', title: 'Bold', group: 'mark', icon: 'B', keys: 'Mod-b', command: toggleMark(m.strong!), active: (s) => markActive(s, m.strong!) },
    { id: 'mark.em', title: 'Italic', group: 'mark', icon: 'I', keys: 'Mod-i', command: toggleMark(m.em!), active: (s) => markActive(s, m.em!) },
    { id: 'mark.code', title: 'Inline code', group: 'mark', icon: '`', keys: 'Mod-e', command: toggleMark(m.code!), active: (s) => markActive(s, m.code!) },
    { id: 'mark.strike', title: 'Strikeout', group: 'mark', icon: 'S', keys: 'Mod-Shift-x', command: toggleMark(m.strike!), active: (s) => markActive(s, m.strike!) },
    { id: 'mark.link', title: 'Link', group: 'mark', icon: '🔗', keys: 'Mod-Shift-k', command: toggleLink(schema), active: (s) => markActive(s, m.link!) },
    { id: 'block.paragraph', title: 'Paragraph', group: 'block', icon: '¶', keys: 'Mod-Alt-0', command: setBlockType(n.paragraph!), active: (s) => blockActive(s, n.paragraph!) },
    ...[1, 2, 3].map((level): EditorCommand => ({
      id: `block.h${level}`, title: `Heading ${level}`, group: 'block', icon: `H${level}`, keys: `Mod-Alt-${level}`,
      command: setBlockType(n.heading!, { level }), active: (s) => blockActive(s, n.heading!, { level }),
    })),
    { id: 'block.bullet', title: 'Bullet list', group: 'block', icon: '•', keys: 'Mod-Shift-8', command: wrapInList(n.bullet_list!) },
    { id: 'block.ordered', title: 'Numbered list', group: 'block', icon: '1.', keys: 'Mod-Shift-7', command: wrapInList(n.ordered_list!) },
    { id: 'block.quote', title: 'Block quote', group: 'block', icon: '❝', keys: 'Mod-Shift-.', command: wrapIn(n.blockquote!) },
    { id: 'block.lift', title: 'Lift out of block', group: 'block', icon: '⇤', keys: 'Mod-[', command: lift },
    { id: 'insert.code', title: 'Code block', group: 'insert', icon: '</>', keys: 'Mod-Alt-c', command: setBlockType(n.code_block!) },
    { id: 'insert.math', title: 'Display math', group: 'insert', icon: '∑', command: insertNode(n.math_display) },
    { id: 'insert.hr', title: 'Horizontal rule', group: 'insert', icon: '—', command: insertNode(n.horizontal_rule) },
    { id: 'history.undo', title: 'Undo', group: 'history', icon: '↶', keys: 'Mod-z', command: history.undo },
    { id: 'history.redo', title: 'Redo', group: 'history', icon: '↷', keys: 'Mod-Shift-z', command: history.redo },
  ];
  if (n.code_chunk) {
    cmds.splice(cmds.findIndex((c) => c.id === 'insert.math'), 0, {
      id: 'insert.chunk', title: 'Code chunk', group: 'insert', icon: '{ }', keys: 'Mod-Alt-i', command: insertNode(n.code_chunk),
    });
  }
  return cmds;
}

export function editorPlugins(schema: Schema, cmds: EditorCommand[]): Plugin[] {
  const n = schema.nodes;
  const keys: Record<string, Command> = {};
  for (const c of cmds) if (c.keys) keys[c.keys] = c.command;
  keys['Mod-y'] = cmds.find((c) => c.id === 'history.redo')!.command;
  keys['Shift-Enter'] = chainCommands(exitCode, (state, dispatch) => {
    if (dispatch) dispatch(state.tr.replaceSelectionWith(n.hard_break!.create()).scrollIntoView());
    return true;
  });
  keys['Enter'] = splitListItem(n.list_item!);
  keys['Tab'] = sinkListItem(n.list_item!);
  keys['Shift-Tab'] = liftListItem(n.list_item!);

  const rules: InputRule[] = [
    textblockTypeInputRule(/^(#{1,6})\s$/, n.heading!, (m) => ({ level: m[1]!.length })),
    wrappingInputRule(/^\s*>\s$/, n.blockquote!),
    wrappingInputRule(/^\s*([-+*])\s$/, n.bullet_list!, (m) => ({ bullet: m[1] === '*' ? '*' : m[1] })),
    wrappingInputRule(/^(\d+)\.\s$/, n.ordered_list!, (m) => ({ order: Number(m[1]) }), (m, node) => node.childCount + node.attrs.order === Number(m[1])),
    textblockTypeInputRule(/^```([^`\s]*)\s$/, n.code_block!, (m) => ({ info: m[1] ?? '' })),
  ];
  return [inputRules({ rules }), keymap(keys), keymap(baseKeymap)];
}
