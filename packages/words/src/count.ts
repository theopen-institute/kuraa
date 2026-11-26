// The words of a document as it is open (0094), counted as a file's are
// (kernel's countWords): each paragraph's text, but code (blocks, inline), the
// header, maths and other atoms, which are not prose.
import type { Node as PMNode } from 'prosemirror-model';
import { countWords } from '@kuraa/kernel';

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

/** A target as a header or a field has it: a whole number above nought, or null. */
export function targetOf(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\s*\d[\d,_ ]*\s*$/.test(v) ? Number(v.replace(/[,_ ]/g, '')) : NaN;
  return Number.isFinite(n) && n >= 1 ? Math.round(n) : null;
}
