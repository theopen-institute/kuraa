// The Pandoc markdown editor: what the format does in the editor. Typing the
// markdown for a construct turns it into that construct (Backspace straight
// afterwards turns it back); key bindings for marks, headings and lists;
// footnotes as a word processor has them (./notes.ts); the YAML header kept out
// of the page, for the header in the client's Document settings (./header.ts).
//
// `createPandocEditor` is the extension point, as `createPandocType` is for the
// format: R Markdown adds its chunks through it.
import type { EditorContext, FormatEditor, HeaderField, HelpItem } from '@kuraa/editor-kit';
import type { Attrs, Mark, MarkType, NodeType, Schema } from 'prosemirror-model';
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
import { joinAfterList, liftAtItemStart, listRules, switchList } from './lists.js';
import { splitTask, taskPlugin, taskRules, untask } from './tasks.js';

export { arrangeNotes } from './notes.js';
export { pandocHeaderFields } from './header.js';
export { conflictPositions, nextConflict, versionDateLabel, versionLabel } from './conflicts.js';
export { Bibliography, citationLabel, describeEntry } from './citations.js';
export { addColumn, addRow, buildTable, cellAt, deleteColumn, deleteRow, deleteTable, goToCell, headerCells, insertTable, spanAt, wordAt } from './tables.js';
export { workspacePath } from './paths.js';
export { joinAfterList, liftAtItemStart, listRules, switchList } from './lists.js';
export { splitTask, taskPlugin, taskRules, untask } from './tasks.js';
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

/**
 * The link the selection is in or on (all of it in one link), as its range in the
 * document; null if none. A cursor just after a link's last letter is in it.
 */
export function linkAt(state: EditorState, type: MarkType): { from: number; to: number; href: string } | null {
  const { $from, $to, from, to } = state.selection;
  if (!$from.parent.inlineContent || !$from.sameParent($to)) return null;
  // The paragraph's links, each as one run of text however its other marks change along it.
  const runs: { from: number; to: number; mark: Mark }[] = [];
  const start = $from.start();
  $from.parent.forEach((child, offset) => {
    const mark = type.isInSet(child.marks);
    if (!mark) return;
    const a = start + offset;
    const last = runs[runs.length - 1];
    if (last && last.to === a && mark.eq(last.mark)) last.to = a + child.nodeSize;
    else runs.push({ from: a, to: a + child.nodeSize, mark });
  });
  const run = runs.find((r) => r.from <= from && to <= r.to);
  return run ? { from: run.from, to: run.to, href: String(run.mark.attrs.href ?? '') } : null;
}

/**
 * A link's address as typed or pasted, tidied: spaces and `<…>` around it
 * taken away, and an address pasted after the `https://` the dialog offers
 * (`https://https://…`) given one scheme. Nothing but a scheme is no address.
 */
export function tidyHref(typed: string): string {
  let href = typed.trim().replace(/^<(.*)>$/s, '$1').trim();
  const doubled = /^[a-z][a-z0-9+.-]*:\/\/(?=[a-z][a-z0-9+.-]*:)/i;
  while (doubled.test(href)) href = href.replace(doubled, '');
  return /^[a-z][a-z0-9+.-]*:(\/\/)?$/i.test(href) ? '' : href;
}

/**
 * ⌘K (and ⌘⇧K): link the selected text, asking for the address; in a link,
 * change its address, or take the link away (the address emptied).
 */
const editLink = (schema: Schema, ctx: EditorContext): Command => (state, dispatch, view) => {
  const link = schema.marks.link!;
  const at = linkAt(state, link);
  if ((!at && state.selection.empty) || !view) return false;
  if (dispatch) {
    void ctx.ui.askText('Link address', at?.href || 'https://', at ? 'Change link' : 'Add link').then((answer) => {
      if (answer === null || view.isDestroyed) return;
      const href = tidyHref(answer);
      // Where it is now: remote edits made while the dialog was open have moved it.
      const now = linkAt(view.state, link);
      const { from, to, empty } = view.state.selection;
      const range = now ?? (empty ? null : { from, to });
      if (!range) return;
      const tr = view.state.tr.removeMark(range.from, range.to, link);
      if (href) tr.addMark(range.from, range.to, link.create({ href }));
      else if (!now) return;
      view.dispatch(tr);
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
    // In an empty item of the other kind of list: that item, as this kind (./lists.ts).
    ...listRules(schema),
    // "[ ] " or "[x] " at the start of a list item: a task (./tasks.ts).
    ...taskRules(schema),
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
    'Mod-k': editLink(schema, ctx),
    'Mod-Shift-k': editLink(schema, ctx),
    'Mod-Alt-0': setBlockType(n.paragraph!),
    'Mod-Alt-1': setBlockType(n.heading!, { level: 1 }),
    'Mod-Alt-2': setBlockType(n.heading!, { level: 2 }),
    'Mod-Alt-3': setBlockType(n.heading!, { level: 3 }),
    'Mod-Shift-8': chainCommands(switchList(n.bullet_list!), wrapInList(n.bullet_list!)),
    'Mod-Shift-7': chainCommands(switchList(n.ordered_list!), wrapInList(n.ordered_list!)),
    'Mod-Shift-.': wrapIn(n.blockquote!),
    'Mod-[': lift,
    'Mod-Alt-c': setBlockType(n.code_block!),
    'Mod-Alt-t': insertTable,
    ...notes.keys,
    Enter: chainCommands(...(notes.enter ? [notes.enter] : []), fenceOnEnter(schema, ext), mathOnEnter(schema), ...tableEnter, splitTask(splitListItem(n.list_item!))),
    'Shift-Enter': chainCommands(
      (state, dispatch, view) => (notes.inNote(state) ? newParagraph(state, dispatch, view) : false),
      exitCode,
      (state, dispatch) => {
        if (dispatch) dispatch(state.tr.replaceSelectionWith(n.hard_break!.create()).scrollIntoView());
        return true;
      },
    ),
    Backspace: chainCommands(undoInputRule, untask(n.list_item!), liftAtItemStart(n.list_item!), joinAfterList),
    ...tableKeys(),
    Tab: chainCommands(tableKeys().Tab!, sinkListItem(n.list_item!)),
    'Shift-Tab': chainCommands(tableKeys()['Shift-Tab']!, liftListItem(n.list_item!)),
    'Mod-Alt-n': nextConflict,
    ...(ext.keys?.(schema, ctx) ?? {}),
  };
}

const TEXT = 'Text';
const BLOCKS = 'Paragraphs';
const INSERT = 'Notes, citations, math';
const EDITING = 'Editing';

/**
 * What Pandoc markdown's cues and keys do: the Markdown and shortcuts sheet
 * (decisions 0008, 0040, 0085). One line for each thing, what to type for it
 * and its keys side by side; a note may name a key in braces ({Mod-Click}).
 */
export const PANDOC_HELP: HelpItem[] = [
  { group: TEXT, does: 'Bold', type: '**bold**', keys: ['Mod-b'] },
  { group: TEXT, does: 'Italic', type: '*italic*', keys: ['Mod-i'] },
  { group: TEXT, does: 'Struck through', type: '~~gone~~', keys: ['Mod-Shift-x'] },
  { group: TEXT, does: 'Code', type: '`code`', keys: ['Mod-e'] },
  { group: TEXT, does: 'Link', type: '[text](url)', keys: ['Mod-k', 'Mod-Shift-k'], note: '{Mod-Click} opens it' },
  { group: TEXT, does: 'Subscript, superscript', type: 'H~2~O x^2^' },

  { group: BLOCKS, does: 'Heading 1, 2, 3', type: '# ## ###', keys: ['Mod-Alt-1', 'Mod-Alt-2', 'Mod-Alt-3'] },
  { group: BLOCKS, does: 'Plain paragraph', keys: ['Mod-Alt-0'] },
  { group: BLOCKS, does: 'Bullet list', type: '- ', keys: ['Mod-Shift-8'] },
  { group: BLOCKS, does: 'Numbered list', type: '1. ', keys: ['Mod-Shift-7'] },
  { group: BLOCKS, does: 'Task (a box to tick)', type: '- [ ] ', note: '[x] for one done; click the box to tick it' },
  { group: BLOCKS, does: 'Block quote', type: '> ', keys: ['Mod-Shift-.'] },
  { group: BLOCKS, does: 'Code block', type: '```', enter: true, keys: ['Mod-Alt-c'], note: '```python for a language' },
  { group: BLOCKS, does: 'Line across the page', type: '---' },

  { group: INSERT, does: 'Footnote', type: '[^label]', keys: ['Mod-Alt-f'] },
  { group: INSERT, does: 'Inline note', type: '^[text]' },
  { group: INSERT, does: 'Citation', type: '@', note: 'pick from the bibliography' },
  { group: INSERT, does: 'Image', type: '![caption](file.png)', note: 'or paste or drop one' },
  { group: INSERT, does: 'Math', type: '$x^2$' },
  { group: INSERT, does: 'Display math', type: '$$', enter: true },
  { group: INSERT, does: 'Table', type: '| a | b |', enter: true, keys: ['Mod-Alt-t'] },

  { group: EDITING, does: 'List item in, out', keys: ['Tab', 'Shift-Tab'] },
  { group: EDITING, does: 'Out of a list or quote', keys: ['Mod-['] },
  { group: EDITING, does: 'Line break', keys: ['Shift-Enter'], note: 'in a note, a new paragraph; in a table, a new line in the cell' },
  { group: EDITING, does: 'Leave a code block or table', keys: ['Mod-Enter'] },
  { group: EDITING, does: 'Next cell, previous cell', keys: ['Tab', 'Shift-Tab'], note: 'in a table' },
  { group: EDITING, does: 'Rows and columns', keys: ['Shift-F10'], note: 'in a table; or right-click; select across rows to delete them together' },
  { group: EDITING, does: 'Next conflict', keys: ['Mod-Alt-n'] },
];

/** A Pandoc markdown editor, optionally extended (R Markdown adds its chunks). */
export function createPandocEditor(ext: PandocEditorExtension = {}): FormatEditor {
  return {
    plugins(ctx: EditorContext): Plugin[] {
      const { schema } = ctx;
      const notes = footnotes(schema, ctx);
      const header = headerBehaviour(schema, ctx);
      if (ctx.readOnly) return [...notes.plugins, taskPlugin(true)];
      const keys = pandocKeys(schema, ctx, ext, notes);
      return [
        ...citationPlugins(ctx),
        inputRules({ rules: [...(ext.rules?.(schema) ?? []), ...notes.rules, ...imageRules(schema), ...citationRules(schema), ...markdownRules(schema, ext)] }),
        keymap(keys),
        ...tablePlugins(ctx),
        ...imagePlugins(ctx),
        ...notes.plugins,
        ...header.plugins,
        taskPlugin(false),
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
