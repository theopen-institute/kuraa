// What other panels do to the live document: put a past version in its place
// (as an edit, so everyone sees it and it can be undone), and find a search
// match in it. Free of Vue; the editor calls them on its ProseMirror view.
import type { DocumentType } from '@kuraa/kernel';
import type { Node as PMNode } from 'prosemirror-model';
import { Selection, TextSelection, type Transaction, type EditorState } from 'prosemirror-state';

/**
 * A transaction that makes the document read as `text`, changing only what
 * differs (the blocks before and after a change stay as they are, with
 * everyone's cursors in them). Null if it already does.
 */
export function replaceWithText(state: EditorState, type: DocumentType, text: string): Transaction | null {
  const doc = state.doc;
  const next = type.parse(text).doc;
  const start = doc.content.findDiffStart(next.content);
  if (start === null) return null;
  let { a: endA, b: endB } = doc.content.findDiffEnd(next.content)!;
  const overlap = start - Math.min(endA, endB);
  if (overlap > 0) {
    endA += overlap;
    endB += overlap;
  }
  return state.tr.replace(start, endA, next.slice(start, endB));
}

export interface MatchTarget {
  /** 1-based line of the file (or of the open document's text) the match was on. */
  line: number;
  /** Where the match starts in that line. */
  at: number;
  query: string;
  caseSensitive: boolean;
}

/** Where `query` occurs in `text`, from `from`. */
function occurrences(text: string, query: string, caseSensitive: boolean): number[] {
  const hay = caseSensitive ? text : text.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  const out: number[] = [];
  if (!needle) return out;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** The text of a node's textblocks, joined by newlines, with each character's document position (-1 between blocks). */
function textWithPositions(node: PMNode, offset: number): { text: string; pos: number[] } {
  let text = '';
  const pos: number[] = [];
  const visit = (n: PMNode, at: number) => {
    if (n.isText) {
      for (let i = 0; i < n.text!.length; i++) pos.push(at + i);
      text += n.text;
      return;
    }
    if (n.isTextblock && text) {
      text += '\n';
      pos.push(-1);
    }
    n.forEach((child, childOffset) => visit(child, at + 1 + childOffset));
  };
  if (node.isText) visit(node, offset);
  else node.forEach((child, childOffset) => visit(child, offset + 1 + childOffset));
  return { text, pos };
}

/** The `nth` occurrence (or the last there is) of `query` in a node, as a document range. */
function nthIn(node: PMNode, offset: number, query: string, caseSensitive: boolean, nth: number): { from: number; to: number } | null {
  const { text, pos } = textWithPositions(node, offset);
  const found = occurrences(text, query, caseSensitive).filter((i) => !pos.slice(i, i + query.length).includes(-1));
  if (!found.length) return null;
  const i = found[Math.min(nth, found.length - 1)]!;
  return { from: pos[i]!, to: pos[i + query.length - 1]! + 1 };
}

/**
 * Where a search match is in the live document. The match was found in the
 * document's text (by line); the text is serialized again here and the line
 * found (the nearest that has the phrase), then the block that holds it, then
 * the phrase inside that block (the same occurrence, counting from the block's
 * start). If the phrase is not in the block as the editor shows it (it was in
 * markup), the start of the block.
 */
export function locateMatch(type: DocumentType, doc: PMNode, target: MatchTarget): { from: number; to: number } | null {
  const text = type.serialize(doc);
  const lines = text.split('\n');
  const has = (l: number) => l >= 0 && l < lines.length && occurrences(lines[l]!, target.query, target.caseSensitive).length > 0;
  let line = -1;
  for (let d = 0; d < lines.length && line < 0; d++) {
    if (has(target.line - 1 - d)) line = target.line - 1 - d;
    else if (has(target.line - 1 + d)) line = target.line - 1 + d;
  }
  if (line < 0) return null;
  const inLine = occurrences(lines[line]!, target.query, target.caseSensitive);
  const column = inLine.reduce((best, c) => (Math.abs(c - target.at) < Math.abs(best - target.at) ? c : best), inLine[0]!);
  const lineStart = lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
  const offset = lineStart + column;

  // A source file: one node per line.
  if (type.editor?.layout?.kind === 'lines') {
    if (line < doc.childCount) {
      let at = 0;
      for (let i = 0; i < line; i++) at += doc.child(i).nodeSize;
      return nthIn(doc.child(line), at, target.query, target.caseSensitive, inLine.indexOf(column));
    }
    return null;
  }

  const parsed = type.parse(text);
  if (parsed.blocks.length === doc.childCount) {
    let k = parsed.blocks.findIndex((b) => offset >= b.from && offset < b.to);
    if (k < 0) k = parsed.blocks.length - 1;
    const block = parsed.blocks[k]!;
    const nth = occurrences(text.slice(block.from, offset), target.query, target.caseSensitive).length;
    let at = 0;
    for (let i = 0; i < k; i++) at += doc.child(i).nodeSize;
    return nthIn(doc.child(k), at, target.query, target.caseSensitive, nth) ?? { from: at, to: at };
  }
  // Blocks that do not line up: the same occurrence in the whole document.
  return nthIn(doc, -1, target.query, target.caseSensitive, occurrences(text.slice(0, offset), target.query, target.caseSensitive).length);
}

/** A selection for a range `locateMatch` gave: the phrase, or a cursor near a block's start. */
export function selectionFor(doc: PMNode, range: { from: number; to: number }): Selection {
  if (range.from === range.to) return Selection.near(doc.resolve(Math.min(range.from + 1, doc.content.size)));
  return TextSelection.create(doc, range.from, range.to);
}
