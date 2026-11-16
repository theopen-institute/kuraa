// Editor commands and markdown cues. The command list drives the key bindings and
// is there for future interfaces (a toolbar, a palette); for now the editor has no
// buttons, and formatting comes from typing markdown.
import type { MarkType, NodeType, Schema } from 'prosemirror-model';
import { type Command, type EditorState, TextSelection } from 'prosemirror-state';
import { baseKeymap, chainCommands, exitCode, setBlockType, toggleMark, wrapIn, lift } from 'prosemirror-commands';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { InputRule, inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules';
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
  keys['Enter'] = chainCommands(fenceOnEnter(schema), splitListItem(n.list_item!));
  keys['Backspace'] = undoInputRule;
  keys['Tab'] = sinkListItem(n.list_item!);
  keys['Shift-Tab'] = liftListItem(n.list_item!);

  return [inputRules({ rules: markdownRules(schema) }), keymap(keys), keymap(baseKeymap)];
}

// Markdown cues. Typing the markdown for a construct turns it into that construct;
// Backspace straight afterwards turns it back into the typed text.

/** `**text**` and the like: drop the delimiters and mark what was between them, keeping its marks. */
function markRule(pattern: RegExp, type: MarkType | undefined, attrs?: (m: RegExpMatchArray) => Record<string, unknown>): InputRule | null {
  if (!type) return null;
  return new InputRule(pattern, (state, match, start, end) => {
    const inner = match[1]!;
    const open = match[0].indexOf(inner);
    // The last character of the closing delimiter has just been typed and is not in the document yet.
    const close = match[0].length - open - inner.length - 1;
    const code = state.schema.marks.code;
    if (code && state.doc.rangeHasMark(start, end, code)) return null;
    const tr = state.tr;
    tr.delete(end - close, end);
    tr.addMark(start + open, end - close, type.create(attrs?.(match)));
    tr.delete(start, start + open);
    tr.removeStoredMark(type);
    return tr;
  });
}

const chunkAttrs = (header: string) => ({ header, engine: /^\s*([A-Za-z][\w-]*)/.exec(header)?.[1] ?? 'r' });

function markdownRules(schema: Schema): InputRule[] {
  const n = schema.nodes;
  const m = schema.marks;
  // The opening delimiter must not follow a backslash or another delimiter, and the
  // text must not start or end with a space, as in Pandoc.
  const rules: (InputRule | null)[] = [
    textblockTypeInputRule(/^(#{1,6})\s$/, n.heading!, (x) => ({ level: x[1]!.length })),
    wrappingInputRule(/^\s*>\s$/, n.blockquote!),
    wrappingInputRule(/^\s*([-+*])\s$/, n.bullet_list!, (x) => ({ bullet: x[1] === '*' ? '*' : x[1] })),
    wrappingInputRule(/^(\d+)\.\s$/, n.ordered_list!, (x) => ({ order: Number(x[1]) }), (x, node) => node.childCount + node.attrs.order === Number(x[1])),
    n.code_chunk ? textblockTypeInputRule(/^```(\{[^}]*\})\s$/, n.code_chunk, (x) => chunkAttrs(x[1]!.slice(1, -1))) : null,
    textblockTypeInputRule(/^```([^`\s{]*)\s$/, n.code_block!, (x) => ({ info: x[1] ?? '' })),
    n.horizontal_rule ? new InputRule(/^(?:---|\*\*\*|___)$/, (state, _x, start) => {
      const $start = state.doc.resolve(start);
      // Only when the paragraph holds nothing else (two characters typed, the third arriving now).
      if ($start.parent.type !== n.paragraph || $start.parentOffset !== 0 || $start.parent.content.size !== 2) return null;
      const tr = state.tr.replaceWith($start.before(), $start.after(), [n.horizontal_rule!.create(), n.paragraph!.create()]);
      return tr.setSelection(TextSelection.create(tr.doc, $start.before() + 2));
    }) : null,
    markRule(/(?<![*\\])\*\*([^*\s](?:[^*]*[^*\s])?)\*\*$/, m.strong),
    markRule(/(?<![_\\\w])__([^_\s](?:[^_]*[^_\s])?)__$/, m.strong),
    markRule(/(?<![*\\])\*([^*\s](?:[^*]*[^*\s])?)\*$/, m.em),
    markRule(/(?<![_\\\w])_([^_\s](?:[^_]*[^_\s])?)_$/, m.em),
    markRule(/(?<![~\\])~~([^~\s](?:[^~]*[^~\s])?)~~$/, m.strike),
    markRule(/(?<![~\\])~([^~\s]+)~$/, m.subscript),
    markRule(/(?<![\^\\])\^([^^\s]+)\^$/, m.superscript),
    markRule(/(?<![`\\])`([^`]+)`$/, m.code),
    markRule(/(?<![!\\])\[([^\]]+)\]\(([^)\s]+)\)$/, m.link, (x) => ({ href: x[2] })),
    n.math_inline ? new InputRule(/(?<![\\$\w])\$([^\s$](?:[^$]*[^\s$])?)\$$/, (state, x, start, end) =>
      state.tr.replaceWith(start, end, n.math_inline!.create({ tex: x[1] }))) : null,
  ];
  return rules.filter((r): r is InputRule => r !== null);
}

/** Enter on a line that is just a fence (```, ```r, ```{r}) starts a code block or chunk. */
const fenceOnEnter = (schema: Schema): Command => (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== schema.nodes.paragraph || $from.parentOffset !== $from.parent.content.size) return false;
  const fence = /^```\s*(\{[^}]*\}|[^`\s{]*)\s*$/.exec($from.parent.textContent);
  if (!fence) return false;
  const info = fence[1]!;
  const chunk = info.startsWith('{') && schema.nodes.code_chunk;
  const type = chunk ? schema.nodes.code_chunk! : schema.nodes.code_block!;
  if (dispatch) {
    const tr = state.tr.replaceWith($from.before(), $from.after(), type.create(chunk ? chunkAttrs(info.slice(1, -1)) : { info }));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1)).scrollIntoView());
  }
  return true;
};
