// The Pandoc markdown editor: what the format does in the editor. Typing the
// markdown for a construct turns it into that construct (Backspace straight
// afterwards turns it back); key bindings for marks, headings and lists;
// footnotes as a word processor has them (./notes.ts); the YAML header kept out
// of the page, for the header in the client's Document settings (./header.ts).
//
// `createPandocEditor` is the extension point, as `createPandocType` is for the
// format: R Markdown adds its chunks through it.
import type { EditorContext, FormatEditor, HeaderField, HelpItem } from '@kuraa/editor-kit';
import type { Attrs, MarkType, NodeType, Schema } from 'prosemirror-model';
import { TextSelection, type Command, type EditorState, type Plugin } from 'prosemirror-state';
import { chainCommands, createParagraphNear, exitCode, lift, liftEmptyBlock, newlineInCode, setBlockType, splitBlock, toggleMark, wrapIn } from 'prosemirror-commands';
import { liftListItem, sinkListItem, splitListItem, wrapInList } from 'prosemirror-schema-list';
import { InputRule, inputRules, textblockTypeInputRule, undoInputRule, wrappingInputRule } from 'prosemirror-inputrules';
import { keymap } from 'prosemirror-keymap';
import { footnotes } from './notes.js';
import { headerBehaviour, headerSpec } from './header.js';
import { conflictViews, nextConflict } from './conflicts.js';
import { citationPlugins, citationRules, citationViews } from './citations.js';
import { imagePlugins, imageRules, imageViews } from './images.js';
import { insertTable, tableEnter, tableKeys, tablePlugins } from './tables.js';

export { arrangeNotes } from './notes.js';
export { pandocHeaderFields } from './header.js';
export { conflictPositions, nextConflict, versionDateLabel, versionLabel } from './conflicts.js';
export { Bibliography, citationLabel, describeEntry } from './citations.js';
export { addColumn, addRow, buildTable, cellAt, deleteColumn, deleteRow, deleteTable, goToCell, headerCells, insertTable } from './tables.js';
export { workspacePath } from './paths.js';
export { IMAGE_TYPES, MAX_IMAGE_BYTES } from './images.js';

export interface PandocEditorExtension {
  /**
   * A fence line typed then Enter or a space: ```` ``` ````, ```` ```lang ````, ```` ```{…} ````.
   * Return the block to make for `info`, or null for Pandoc's code block.
   */
  fence?(info: string, schema: Schema): { type: NodeType; attrs: Attrs } | null;
  /** More key bindings, taking precedence over Pandoc's. */
  keys?(schema: Schema, ctx: EditorContext): Record<string, Command>;
  /** More typing cues, tried before Pandoc's. */
  rules?(schema: Schema): InputRule[];
  /** More header fields to offer, after Pandoc's (one with the same key replaces Pandoc's). */
  headerFields?: HeaderField[];
  /** What its cues and keys do, for the Markdown and shortcuts sheet (each of its keys should be here). */
  help?: HelpItem[];
}

/** Insert a node at the cursor, putting the cursor inside it if it holds text. */
export const insertNode = (type: NodeType | undefined, attrs?: Attrs): Command => (state, dispatch) => {
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

const markActive = (state: EditorState, type: MarkType): boolean => {
  const { from, $from, to, empty } = state.selection;
  if (empty) return !!type.isInSet(state.storedMarks || $from.marks());
  return state.doc.rangeHasMark(from, to, type);
};

const toggleLink = (schema: Schema, ctx: EditorContext): Command => (state, dispatch, view) => {
  const link = schema.marks.link!;
  if (markActive(state, link)) return toggleMark(link)(state, dispatch);
  if (state.selection.empty || !view) return false;
  if (dispatch) {
    void ctx.ui.askText('Link address', 'https://', 'Add link').then((href) => {
      href = href?.trim() ?? '';
      if (!href || view.isDestroyed) return;
      // The selection as it is now: remote edits made while the dialog was open have moved it.
      const { from, to, empty } = view.state.selection;
      if (!empty) view.dispatch(view.state.tr.addMark(from, to, link.create({ href })));
      view.focus();
    });
  }
  return true;
};

/** `**text**` and the like: drop the delimiters and mark what was between them, keeping its marks. */
function markRule(pattern: RegExp, type: MarkType | undefined, attrs?: (m: RegExpMatchArray) => Attrs): InputRule | null {
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

/** The block a fence makes: the extension's, or Pandoc's code block. */
function fenceBlock(info: string, schema: Schema, ext: PandocEditorExtension): { type: NodeType; attrs: Attrs } {
  return ext.fence?.(info, schema) ?? { type: schema.nodes.code_block!, attrs: { info } };
}

/** Enter on a line that is just a fence starts a code block (or what the extension makes of it). */
const fenceOnEnter = (schema: Schema, ext: PandocEditorExtension): Command => (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parent.type !== schema.nodes.paragraph || $from.parentOffset !== $from.parent.content.size) return false;
  const fence = /^```\s*(\{[^}]*\}|[^`\s{]*)\s*$/.exec($from.parent.textContent);
  if (!fence) return false;
  const { type, attrs } = fenceBlock(fence[1]!, schema, ext);
  if (dispatch) {
    const tr = state.tr.replaceWith($from.before(), $from.after(), type.create(attrs));
    dispatch(tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1)).scrollIntoView());
  }
  return true;
};

/** `$$` on a line of its own, then Enter: a display math block. */
const mathOnEnter = (schema: Schema): Command => (state, dispatch) => {
  const math = schema.nodes.math_display;
  const { $from, empty } = state.selection;
  if (!math || !empty || $from.parent.type !== schema.nodes.paragraph || $from.parent.textContent.trim() !== '$$') return false;
  if ($from.parentOffset !== $from.parent.content.size) return false;
  if (dispatch) {
    const tr = state.tr.replaceWith($from.before(), $from.after(), math.create());
    dispatch(tr.setSelection(TextSelection.create(tr.doc, $from.before() + 1)).scrollIntoView());
  }
  return true;
};

function markdownRules(schema: Schema, ext: PandocEditorExtension): InputRule[] {
  const n = schema.nodes;
  const m = schema.marks;
  // As in Pandoc: an opening delimiter must not follow a backslash or another
  // delimiter, and the text must not start or end with a space.
  const rules: (InputRule | null)[] = [
    textblockTypeInputRule(/^(#{1,6})\s$/, n.heading!, (x) => ({ level: x[1]!.length })),
    wrappingInputRule(/^\s*>\s$/, n.blockquote!),
    wrappingInputRule(/^\s*([-+*])\s$/, n.bullet_list!, (x) => ({ bullet: x[1] === '*' ? '*' : x[1] })),
    wrappingInputRule(/^(\d+)\.\s$/, n.ordered_list!, (x) => ({ order: Number(x[1]) }), (x, node) => node.childCount + node.attrs.order === Number(x[1])),
    // ```{…} then a space: whatever the extension makes of it (Pandoc alone waits for Enter).
    new InputRule(/^```(\{[^}]*\})\s$/, (state, x, start, end) => {
      const block = ext.fence?.(x[1]!, schema);
      if (!block) return null;
      return state.tr.delete(start, end).setBlockType(start, start, block.type, block.attrs);
    }),
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
    // $$tex$$ in a line: display math there.
    n.math_inline ? new InputRule(/(?<![\\$\w])\$\$([^\s$](?:[^$]*[^\s$])?)\$\$$/, (state, x, start, end) =>
      state.tr.replaceWith(start, end, n.math_inline!.create({ tex: x[1], display: true }))) : null,
  ];
  return rules.filter((r): r is InputRule => r !== null);
}

/**
 * The key bindings of a Pandoc document: marks, blocks, lists, footnotes,
 * tables, conflicts, and the extension's. Each key with a modifier is named in
 * PANDOC_HELP (a test checks), so the shortcuts sheet lists what is bound.
 */
export function pandocKeys(schema: Schema, ctx: EditorContext, ext: PandocEditorExtension = {}, notes = footnotes(schema, ctx)): Record<string, Command> {
  const n = schema.nodes;
  const m = schema.marks;
  // In a note, Shift+Enter starts a new paragraph; elsewhere it is a line break.
  const newParagraph = chainCommands(splitListItem(n.list_item!), newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock);
  return {
    'Mod-b': toggleMark(m.strong!),
    'Mod-i': toggleMark(m.em!),
    'Mod-e': toggleMark(m.code!),
    'Mod-Shift-x': toggleMark(m.strike!),
    'Mod-Shift-k': toggleLink(schema, ctx),
    'Mod-Alt-0': setBlockType(n.paragraph!),
    'Mod-Alt-1': setBlockType(n.heading!, { level: 1 }),
    'Mod-Alt-2': setBlockType(n.heading!, { level: 2 }),
    'Mod-Alt-3': setBlockType(n.heading!, { level: 3 }),
    'Mod-Shift-8': wrapInList(n.bullet_list!),
    'Mod-Shift-7': wrapInList(n.ordered_list!),
    'Mod-Shift-.': wrapIn(n.blockquote!),
    'Mod-[': lift,
    'Mod-Alt-c': setBlockType(n.code_block!),
    ...notes.keys,
    Enter: chainCommands(...(notes.enter ? [notes.enter] : []), fenceOnEnter(schema, ext), mathOnEnter(schema), ...tableEnter, splitListItem(n.list_item!)),
    'Shift-Enter': chainCommands(
      (state, dispatch, view) => (notes.inNote(state) ? newParagraph(state, dispatch, view) : false),
      exitCode,
      (state, dispatch) => {
        if (dispatch) dispatch(state.tr.replaceSelectionWith(n.hard_break!.create()).scrollIntoView());
        return true;
      },
    ),
    Backspace: undoInputRule,
    ...tableKeys(),
    Tab: chainCommands(tableKeys().Tab!, sinkListItem(n.list_item!)),
    'Shift-Tab': chainCommands(tableKeys()['Shift-Tab']!, liftListItem(n.list_item!)),
    'Mod-Alt-n': nextConflict,
    ...(ext.keys?.(schema, ctx) ?? {}),
  };
}

const TYPING = 'Typing';
const WRITING = 'Citations, images, math and tables';
const KEYS = 'Keys';

/** What Pandoc markdown's cues and keys do: the Markdown and shortcuts sheet (decisions 0008, 0040). */
export const PANDOC_HELP: HelpItem[] = [
  { group: TYPING, type: '# ', does: 'Heading (## for the next level, up to ######)' },
  { group: TYPING, type: '> ', does: 'Block quote' },
  { group: TYPING, type: '- ', does: 'Bullet list (or * or +)' },
  { group: TYPING, type: '1. ', does: 'Numbered list' },
  { group: TYPING, type: '**bold**', does: 'Bold (or __bold__)' },
  { group: TYPING, type: '*italic*', does: 'Italic (or _italic_)' },
  { group: TYPING, type: '~~gone~~', does: 'Struck through' },
  { group: TYPING, type: '`code`', does: 'Code in a line' },
  { group: TYPING, type: 'H~2~O   x^2^', does: 'Subscript, superscript' },
  { group: TYPING, type: '[text](https://…)', does: 'Link' },
  { group: TYPING, type: '---', does: 'A line across the page' },
  { group: TYPING, type: '``` then Enter', does: 'Code block (```python for a language)' },
  { group: TYPING, type: '[^label]', does: 'Footnote: a new one is added at the end' },
  { group: TYPING, type: '^[text]', does: 'Inline note' },
  { group: TYPING, keys: ['Backspace'], does: 'Straight after a cue: back to what you typed' },
  { group: WRITING, type: '@', does: 'Cite: choose from the bibliography the header names' },
  { group: WRITING, type: '[@smith2020, p. 3]', does: 'A citation as Pandoc writes it (@smith2020 alone cites in the text)' },
  { group: WRITING, type: '![caption](plot.png)', does: 'Image; or paste or drop an image file' },
  { group: WRITING, type: '$x^2$', does: 'Math in the line' },
  { group: WRITING, type: '$$ then Enter', does: 'Display math, on lines of its own' },
  { group: WRITING, type: '| a | b | then Enter', does: 'Table with those headings' },
  { group: WRITING, keys: ['Tab', 'Shift-Tab'], does: 'In a table: the next or previous cell' },
  { group: WRITING, keys: ['Shift-F10'], does: 'In a table: rows and columns (or right-click)' },
  { group: KEYS, keys: ['Mod-b'], does: 'Bold' },
  { group: KEYS, keys: ['Mod-i'], does: 'Italic' },
  { group: KEYS, keys: ['Mod-e'], does: 'Code' },
  { group: KEYS, keys: ['Mod-Shift-x'], does: 'Struck through' },
  { group: KEYS, keys: ['Mod-Shift-k'], does: 'Link the selected text' },
  { group: KEYS, keys: ['Mod-Alt-1', 'Mod-Alt-2', 'Mod-Alt-3'], does: 'Heading 1, 2, 3' },
  { group: KEYS, keys: ['Mod-Alt-0'], does: 'Plain paragraph' },
  { group: KEYS, keys: ['Mod-Shift-8'], does: 'Bullet list' },
  { group: KEYS, keys: ['Mod-Shift-7'], does: 'Numbered list' },
  { group: KEYS, keys: ['Mod-Shift-.'], does: 'Block quote' },
  { group: KEYS, keys: ['Mod-['], does: 'Out of a list or quote' },
  { group: KEYS, keys: ['Mod-Alt-c'], does: 'Code block' },
  { group: KEYS, keys: ['Mod-Alt-f'], does: 'A numbered footnote' },
  { group: KEYS, keys: ['Shift-Enter'], does: 'Line break; in a note, a new paragraph' },
  { group: KEYS, keys: ['Mod-Enter'], does: 'Leave a code block or table' },
  { group: KEYS, keys: ['Mod-Alt-n'], does: 'The next conflict' },
];

/** A Pandoc markdown editor, optionally extended (R Markdown adds its chunks). */
export function createPandocEditor(ext: PandocEditorExtension = {}): FormatEditor {
  return {
    plugins(ctx: EditorContext): Plugin[] {
      const { schema } = ctx;
      const notes = footnotes(schema, ctx);
      const header = headerBehaviour(schema, ctx);
      if (ctx.readOnly) return notes.plugins;
      const keys = pandocKeys(schema, ctx, ext, notes);
      return [
        ...citationPlugins(ctx),
        inputRules({ rules: [...(ext.rules?.(schema) ?? []), ...notes.rules, ...imageRules(schema), ...citationRules(schema), ...markdownRules(schema, ext)] }),
        keymap(keys),
        ...tablePlugins(),
        ...imagePlugins(ctx),
        ...notes.plugins,
        ...header.plugins,
      ];
    },
    nodeViews: (ctx) => ({
      ...footnotes(ctx.schema, ctx).nodeViews,
      ...headerBehaviour(ctx.schema, ctx).nodeViews,
      ...conflictViews(!!ctx.readOnly, ctx),
      ...citationViews(ctx),
      ...imageViews(ctx),
    }),
    header: headerSpec(ext.headerFields),
    commands: () => ({ insertTable, nextConflict }),
    help: [...PANDOC_HELP, ...(ext.help ?? [])],
  };
}

export const pandocEditor: FormatEditor = {
  ...createPandocEditor(),
  label: 'Markdown editing',
  description: 'Formatting as you type markdown, its keys (⌘B, ⌘I, …), footnotes numbered as the reader sees them, new ones put in order, citations from the bibliography, images pasted into the workspace, tables, the header (title, authors, …) edited in its own dialog, and conflict blocks shown with a way to choose.',
};
