// The document's outline: its headings, in order, for the Outline panel.
import type { Node as PMNode } from 'prosemirror-model';

export interface OutlineEntry {
  level: number;
  text: string;
  /** Where the heading starts in the document. */
  pos: number;
}

/** The document's headings (any node with a level and text: a format's heading), not those inside notes or quotes' own structure. */
export function outlineOf(doc: PMNode): OutlineEntry[] {
  const out: OutlineEntry[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'heading') {
      out.push({ level: Number(node.attrs.level) || 1, text: node.textContent.trim(), pos });
      return false;
    }
    // Headings are blocks: look only into blocks that hold blocks.
    return !node.isTextblock && !node.type.spec.code;
  });
  return out;
}

/** The heading the cursor is under: the last one before it. */
export function currentHeading(entries: OutlineEntry[], pos: number): number {
  let i = -1;
  for (let k = 0; k < entries.length && entries[k]!.pos <= pos; k++) i = k;
  return i;
}
