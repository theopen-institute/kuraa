// Counting words (0094), the same everywhere: in the open document as it is
// typed, in a file on the host, in a folder's book. What a reader reads of a
// document's text is its type's to say (DocumentType.prose, 0123): the kernel
// knows no format. A word is a run of letters
// or digits (with the apostrophes and hyphens inside it); in scripts written
// without spaces (Chinese, Japanese), each character is one, as word
// processors count them.
import type { Node as PMNode } from 'prosemirror-model';

/** Letters or digits, with apostrophes and hyphens inside; or one character of a script written without spaces. */
const WORD = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]|[\p{L}\p{N}\p{M}]+(?:['’‐-][\p{L}\p{N}\p{M}]+)*/gu;

/** The words in plain text. */
export function countWords(text: string): number {
  let n = 0;
  for (const _ of text.matchAll(WORD)) n++;
  return n;
}

/** The words in a document's text, as its type counts them (its `prose`); null for a type without prose. */
export function proseWords(type: { prose?(text: string): string } | undefined, text: string): number | null {
  return type?.prose ? countWords(type.prose(text)) : null;
}

/**
 * How a document's words changed from one text to another (0094), each as a
 * reader reads it (its type's `prose`, 0123):
 * `net`, how many more there are (fewer, below nought); `added`, the words
 * written, each word counted as many more times as it appears now than before
 * (in any case), so a sentence rewritten counts though the length stays,
 * and a paragraph moved counts nothing. A document that is new (before: null)
 * or gone (after: null) is counted from or to nothing.
 */
export function wordChange(before: string | null, after: string | null): { net: number; added: number } {
  const bag = (text: string | null) => {
    const m = new Map<string, number>();
    if (text) for (const [w] of text.matchAll(WORD)) m.set(w.toLowerCase(), (m.get(w.toLowerCase()) ?? 0) + 1);
    return m;
  };
  const was = bag(before);
  const now = bag(after);
  let net = 0;
  let added = 0;
  for (const [w, n] of now) {
    const old = was.get(w) ?? 0;
    if (n > old) added += n - old;
    net += n;
  }
  for (const n of was.values()) net -= n;
  return { net, added };
}

/**
 * The words of a document as it is open, counted as a file's are: each
 * paragraph's text, but code (blocks, inline), the header, maths and other
 * atoms, which are not prose. (Words' and Composition's: 0094, 0120.)
 */
export function liveWords(doc: PMNode): number {
  let n = 0;
  doc.descendants((node) => {
    // Code blocks, the header (its YAML), raw blocks and display maths: not prose.
    if (node.type.spec.code) return false;
    if (!node.isTextblock) return true;
    let text = '';
    node.forEach((child) => {
      text += child.isText && !child.marks.some((m) => m.type.spec.code) ? child.text : ' ';
    });
    n += countWords(text);
    return false;
  });
  return n;
}

/** A target as a header or a field has it (`target-words`): a whole number above nought, or null. */
export function targetOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d[\d,_ ]*\s*$/.test(v) ? Number(v.replace(/[,_ ]/g, '')) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
}
