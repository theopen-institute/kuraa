// The client side of the `lines` layout hint: source files edited in ProseMirror,
// one node per line (see packages/format-text). Highlighting runs CodeMirror's
// parsers over the document text, outside any CodeMirror editor, and shows the
// result as decorations, so remote cursors and presence work as in prose.
import type { LayoutHint } from '@kuraa/kernel';
import type { Node as PMNode, NodeType, Schema, Slice } from 'prosemirror-model';
import { Plugin, PluginKey, type Command, type EditorState, type Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { keymap } from 'prosemirror-keymap';
import { baseKeymap } from 'prosemirror-commands';
import { TreeFragment, type Tree } from '@lezer/common';
import { highlightTree } from '@lezer/highlight';
import { highlighter, language as languageNamed } from './languages.js';

type Lines = Extract<LayoutHint, { kind: 'lines' }>;

/** Files longer than this are shown without highlighting. */
const MAX_HIGHLIGHT = 2_000_000;

/** The document as text (lines joined by '\n'), and where each line starts in the text and in the document. */
function textOf(doc: PMNode): { text: string; textStarts: number[]; docStarts: number[] } {
  const parts: string[] = [];
  const textStarts: number[] = [];
  const docStarts: number[] = [];
  let text = 0;
  doc.forEach((line, offset) => {
    textStarts.push(text);
    docStarts.push(offset + 1);
    const content = line.textContent;
    parts.push(content);
    text += content.length + 1;
  });
  return { text: parts.join('\n'), textStarts, docStarts };
}

function changedRange(a: string, b: string) {
  const min = Math.min(a.length, b.length);
  let from = 0;
  while (from < min && a.charCodeAt(from) === b.charCodeAt(from)) from++;
  let toA = a.length;
  let toB = b.length;
  while (toA > from && toB > from && a.charCodeAt(toA - 1) === b.charCodeAt(toB - 1)) {
    toA--;
    toB--;
  }
  return { fromA: from, toA, fromB: from, toB };
}

interface Highlight {
  text: string;
  language: string | undefined;
  fragments: readonly TreeFragment[];
  decorations: DecorationSet;
}

/** The language a lines document is highlighted as: fixed by the type, or from the file's path and first line. */
export function languageFor(hint: Lines, path: string, doc: PMNode): string | undefined {
  return hint.language ?? hint.languageOf?.(path, doc.firstChild?.textContent ?? '');
}

const highlightKey = new PluginKey<Highlight>('lines-highlight');

/** Syntax highlighting for a lines document, re-parsing incrementally after each change. */
export function highlightPlugin(hint: Lines, path: string): Plugin<Highlight> {
  const compute = (doc: PMNode, previous: Highlight | null): Highlight => {
    const { text, textStarts, docStarts } = textOf(doc);
    const language = languageFor(hint, path, doc);
    const lang = languageNamed(language);
    if (!lang || text.length > MAX_HIGHLIGHT) return { text, language, fragments: [], decorations: DecorationSet.empty };
    // Earlier parse trees are reusable only for the same language (a #! line may have changed it).
    let fragments = previous && previous.language === language ? previous.fragments : [];
    if (previous && fragments.length) fragments = TreeFragment.applyChanges(fragments, [changedRange(previous.text, text)]);
    const tree: Tree = lang.parser.parse(text, fragments);
    // Map text offsets to document positions; highlightTree reports ranges in order.
    let line = 0;
    const pos = (offset: number) => {
      while (line + 1 < textStarts.length && textStarts[line + 1]! <= offset) line++;
      while (line > 0 && textStarts[line]! > offset) line--;
      return docStarts[line]! + (offset - textStarts[line]!);
    };
    const decorations: Decoration[] = [];
    highlightTree(tree, highlighter, (from, to, classes) => {
      const a = pos(from);
      const b = pos(to);
      if (b > a) decorations.push(Decoration.inline(a, b, { class: classes }));
    });
    return { text, language, fragments: TreeFragment.addTree(tree, fragments), decorations: DecorationSet.create(doc, decorations) };
  };
  return new Plugin<Highlight>({
    key: highlightKey,
    state: {
      init: (_, state) => compute(state.doc, null),
      apply: (tr, value, _old, state) => (tr.docChanged ? compute(state.doc, value) : value),
    },
    props: { decorations: (state) => highlightKey.getState(state)?.decorations },
  });
}

/** The indentation the file uses: a tab, or its smallest run of leading spaces. */
function indentUnit(doc: PMNode, language?: string): string {
  let tabs = 0;
  let spaced = 0;
  let smallest = Infinity;
  let seen = 0;
  doc.forEach((line) => {
    if (seen++ > 2000) return;
    const lead = /^[ \t]*/.exec(line.textContent)![0];
    if (!lead || lead.length === line.textContent.length) return;
    if (lead.startsWith('\t')) tabs++;
    else {
      spaced++;
      if (lead.length >= 2) smallest = Math.min(smallest, lead.length);
    }
  });
  if (tabs > spaced) return '\t';
  if (smallest !== Infinity) return ' '.repeat(Math.min(smallest, 8));
  return ' '.repeat(language === 'python' || language === 'julia' ? 4 : 2);
}

/** Positions of the line nodes the selection touches. */
function selectedLines(state: EditorState, lineType: NodeType): number[] {
  const { from, to } = state.selection;
  const out: number[] = [];
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type === lineType) out.push(pos);
    return false;
  });
  return out;
}

function lineCommands(schema: Schema, hint: Lines, path: string): Record<string, Command> {
  const lineType = schema.nodes[hint.line]!;
  const inLine = (state: EditorState) => state.selection.$from.parent.type === lineType;

  // A new line, indented like the one it came from.
  const newline: Command = (state, dispatch) => {
    if (!inLine(state)) return false;
    if (dispatch) {
      const tr = state.tr.deleteSelection();
      const $pos = tr.selection.$from;
      const line = $pos.parent;
      const indent = /^[ \t]*/.exec(line.textBetween(0, $pos.parentOffset))![0];
      tr.split($pos.pos, 1, [{ type: lineType, attrs: line.attrs }]);
      if (indent) tr.insertText(indent);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };

  const indent: Command = (state, dispatch) => {
    if (!inLine(state)) return false;
    const unit = indentUnit(state.doc, languageFor(hint, path, state.doc));
    if (dispatch) {
      const lines = selectedLines(state, lineType);
      const tr = state.tr;
      if (state.selection.empty || lines.length < 2) tr.insertText(unit);
      else for (const pos of lines.reverse()) tr.insertText(unit, pos + 1);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };

  const outdent: Command = (state, dispatch) => {
    if (!inLine(state)) return false;
    const unit = indentUnit(state.doc, languageFor(hint, path, state.doc));
    if (dispatch) {
      const tr = state.tr;
      for (const pos of selectedLines(state, lineType).reverse()) {
        const text = state.doc.nodeAt(pos)!.textContent;
        const n = text.startsWith('\t') ? 1 : Math.min(/^ */.exec(text)![0].length, unit === '\t' ? 4 : unit.length);
        if (n) tr.delete(pos + 1, pos + 1 + n);
      }
      dispatch(tr.scrollIntoView());
    }
    return true;
  };

  return { Enter: newline, 'Shift-Enter': newline, Tab: indent, 'Shift-Tab': outdent };
}

const NEWLINE = /\r\n|\r|\n/g;

function insertsNewline(trs: readonly Transaction[]): boolean {
  return trs.some((tr) => tr.steps.some((step) => {
    const slice = (step as { slice?: Slice }).slice;
    let found = false;
    slice?.content.descendants((n) => {
      if (n.isText && /[\r\n]/.test(n.text!)) found = true;
      return !found;
    });
    return found;
  }));
}

/** The terminator most lines use; '\n' if none do. */
function usualEol(doc: PMNode, attr: string): string {
  const counts = new Map<string, number>();
  doc.forEach((line, _, i) => {
    const eol = String(line.attrs[attr] ?? '');
    if (eol && i < doc.childCount - 1) counts.set(eol, (counts.get(eol) ?? 0) + 1);
  });
  let best = '\n';
  let most = 0;
  for (const [eol, n] of counts) if (n > most) [best, most] = [eol, n];
  return best;
}

/**
 * Text arriving with line breaks in it (pasted or dropped) becomes separate
 * lines, ended the way the file's lines usually are, as in other editors.
 */
function splitPlugin(schema: Schema, hint: Lines): Plugin {
  const lineType = schema.nodes[hint.line]!;
  return new Plugin({
    appendTransaction(trs, _old, state) {
      if (!insertsNewline(trs)) return null;
      const broken: { pos: number; node: PMNode }[] = [];
      state.doc.forEach((node, pos) => {
        if (/[\r\n]/.test(node.textContent)) broken.push({ pos, node });
      });
      if (!broken.length) return null;
      const tr = state.tr;
      const usual = usualEol(state.doc, hint.eolAttr);
      for (const { pos, node } of broken.reverse()) {
        let eol = String(node.attrs[hint.eolAttr] ?? '');
        for (const m of [...node.textContent.matchAll(NEWLINE)].reverse()) {
          const at = pos + 1 + m.index;
          tr.delete(at, at + m[0].length);
          tr.split(at, 1, [{ type: lineType, attrs: { ...node.attrs, [hint.eolAttr]: eol } }]);
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, [hint.eolAttr]: usual });
          eol = usual;
        }
      }
      return tr;
    },
  });
}

/** Everything a lines document needs in the editor, besides the session's plugins. */
export function linesPlugins(schema: Schema, hint: Lines, path: string, history: { undo: Command; redo: Command }): Plugin[] {
  return [
    highlightPlugin(hint, path),
    splitPlugin(schema, hint),
    keymap({ ...lineCommands(schema, hint, path), 'Mod-z': history.undo, 'Mod-Shift-z': history.redo, 'Mod-y': history.redo }),
    keymap(baseKeymap),
    // Copy lines as lines (the default puts a blank line between blocks).
    new Plugin({ props: { clipboardTextSerializer: (slice) => slice.content.textBetween(0, slice.content.size, '\n') } }),
  ];
}
