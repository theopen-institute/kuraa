// Where each place in a document is in its file's text, and back: for what is
// kept about a document apart from it (a feature's annotations, say), which
// names places by the file's text, while the editor knows them as positions in
// its ProseMirror document.
//
// A type may say exactly (DocumentType.sourceMap). Without that, sourceMapOf
// finds each top-level block's text in the block's source (ParsedDocument.blocks),
// character by character, in order: markup (`**`, `[`…`](…)`, escapes) is what
// the source has between them. Text the parser made that the source does not
// have (none in Kuraa's formats) keeps to the place before it.
import type { Node } from 'prosemirror-model';
import type { DocumentType, ParsedDocument } from './index.js';

/**
 * Places in a document and in its text, both ways. Text offsets are JavaScript's
 * (UTF-16 units). A place is the start of a range (bias 1, the default: at the
 * next character of text) or its end (bias -1: just after the character of text
 * before it), so a range maps to the same characters both ways, whatever
 * markup is between them and what is beside them.
 */
export interface SourceMap {
  /** The offset in the text of a document position. */
  toText(pos: number, bias?: 1 | -1): number;
  /** The document position of an offset in the text. */
  toDoc(offset: number, bias?: 1 | -1): number;
}

/** How far ahead in its source a character of a block's text is looked for: past that, the parser made it, and it is skipped. */
const LOOKAHEAD = 256;

interface BlockMap {
  /** Where the block starts in the document (before its opening). */
  start: number;
  /** Where it ends (after its closing). */
  end: number;
  /** Its source range. */
  from: number;
  to: number;
  /** Each character of its text: its document position, and its offset in the text. */
  pos: number[];
  off: number[];
  /** Where to type in it, if it holds text: just inside its opening. */
  inside: number | null;
}

/** The source map of a document as parsed: the type's own, else one found by aligning each block's text with its source. */
export function sourceMapOf(type: DocumentType, doc: Node, parsed: ParsedDocument): SourceMap {
  return type.sourceMap ? type.sourceMap(doc, parsed) : alignedSourceMap(doc, parsed);
}

/** A source map found by aligning each top-level block's text with its source range. */
export function alignedSourceMap(doc: Node, parsed: ParsedDocument): SourceMap {
  const text = parsed.text;
  const blocks: BlockMap[] = [];
  const paired = parsed.blocks.length === doc.childCount;
  if (paired) {
    doc.forEach((node, offset, i) => {
      const r = parsed.blocks[i]!;
      blocks.push(align(node, offset, offset + node.nodeSize, r.from, r.to, text));
    });
  } else {
    // Blocks the parser did not range one to one: the whole text against the whole document.
    blocks.push(align(doc, -1, doc.content.size + 1, 0, text.length, text));
  }
  const last = text.length;

  const blockAtPos = (pos: number): BlockMap | null => {
    let lo = 0;
    let hi = blocks.length - 1;
    let found: BlockMap | null = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (blocks[mid]!.start <= pos) {
        found = blocks[mid]!;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return found;
  };
  const blockAtOffset = (offset: number): BlockMap | null => {
    let found: BlockMap | null = null;
    for (const b of blocks) {
      if (b.from <= offset) found = b;
      else break;
    }
    return found;
  };

  return {
    toText(pos, bias = 1) {
      const b = blockAtPos(pos);
      if (!b) return 0;
      if (pos >= b.end) return b.to;
      const n = b.pos.length;
      if (!n) return b.from;
      const j = firstAtLeast(b.pos, pos);
      if (bias < 0) return j === 0 ? b.off[0]! : b.off[j - 1]! + 1;
      return j === n ? b.off[n - 1]! + 1 : b.off[j]!;
    },
    toDoc(offset, bias = 1) {
      const o = Math.max(0, Math.min(offset, last));
      const b = blockAtOffset(o);
      if (!b) return blocks[0]?.inside ?? 0;
      const n = b.pos.length;
      if (!n) return b.inside ?? b.start;
      const j = firstAtLeast(b.off, o);
      if (bias < 0) return j === 0 ? b.pos[0]! : b.pos[j - 1]! + 1;
      return j === n ? b.pos[n - 1]! + 1 : b.pos[j]!;
    },
  };
}

/** Align a block's text with its source range: each character of it found in order, in the source after the one before. */
function align(node: Node, start: number, end: number, from: number, to: number, text: string): BlockMap {
  const pos: number[] = [];
  const off: number[] = [];
  let cursor = from;
  let inside: number | null = node.isTextblock ? start + 1 : null;
  node.descendants((child, p) => {
    if (inside === null && child.isTextblock) inside = start + 1 + p + 1;
    if (!child.isText) return true;
    const at = start + 1 + p;
    const s = child.text!;
    for (let i = 0; i < s.length; i++) {
      const limit = Math.min(to, cursor + LOOKAHEAD);
      let k = -1;
      for (let x = cursor; x < limit; x++) {
        if (text.charCodeAt(x) === s.charCodeAt(i)) {
          k = x;
          break;
        }
      }
      if (k < 0) continue;
      pos.push(at + i);
      off.push(k);
      cursor = k + 1;
    }
    return false;
  });
  return { start, end, from, to, pos, off, inside };
}

/** The first index whose value is at least `v`, in an ascending list (its length if none is). */
function firstAtLeast(list: number[], v: number): number {
  let lo = 0;
  let hi = list.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (list[mid]! < v) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
