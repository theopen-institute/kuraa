// What a Pandoc document refers to (0109): its images, links and link
// definitions, each with where its target is written in the text, for the host
// to write again when files move. Read from the same Markdown tree the parser
// starts from, so nothing in code (a fenced block, `inline code`) counts.
import type { Reference } from '@kuraa/kernel';
import { parseFragment, type MdNode } from './parse.js';

/** After `](`: the target (in angle brackets, or up to a space or the closing parenthesis, balanced), a title, then `)`. */
const INLINE = /^\]\(\s*(<[^<>\n]*>|(?:[^\s()<>\\]|\\.|\((?:[^\s()\\]|\\.)*\))+)(?:\s+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\((?:[^()\\]|\\.)*\)))?\s*\)$/s;
/** A definition: `[label]: target "title"`. */
const DEFINITION = /^\s*\[(?:[^\]\\]|\\.)+\]:\s*(<[^<>\n]*>|\S+)/s;

export function pandocReferences(text: string): Reference[] {
  let root: MdNode;
  try {
    root = parseFragment(text, 0, true);
  } catch {
    return [];
  }
  const out: Reference[] = [];
  const visit = (node: MdNode) => {
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) {
      if (node.type === 'image' || node.type === 'link') {
        const found = inlineTarget(text, start, end);
        if (found) out.push({ kind: node.type, ...found });
      } else if (node.type === 'definition') {
        const m = DEFINITION.exec(text.slice(start, end));
        if (m) {
          const at = start + m[0].length - m[1]!.length;
          out.push({ kind: 'definition', from: at, to: at + m[1]!.length, target: unangle(m[1]!) });
        }
      }
    }
    for (const c of node.children ?? []) visit(c);
  };
  visit(root);
  return out.sort((a, b) => a.from - b.from);
}

/** An inline image's or link's target: the `](…)` that ends where the node does (the last such: an image's description may hold brackets). */
function inlineTarget(text: string, start: number, end: number): Omit<Reference, 'kind'> | null {
  const slice = text.slice(start, end);
  for (let i = slice.lastIndexOf(']('); i >= 0; i = slice.lastIndexOf('](', i - 1)) {
    const m = INLINE.exec(slice.slice(i));
    if (m) {
      const at = start + i + m[0].indexOf(m[1]!, 2);
      return { from: at, to: at + m[1]!.length, target: unangle(m[1]!) };
    }
    if (i === 0) break;
  }
  return null;
}

const unangle = (t: string) => (t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t.replace(/\\(.)/g, '$1'));
