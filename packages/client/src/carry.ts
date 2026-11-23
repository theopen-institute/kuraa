// Edits a room never had, carried to the room that replaced it.
import { mergeLines, type DocumentType, type MergeSide } from '@kuraa/kernel';
import type { Node as PMNode } from 'prosemirror-model';

/**
 * What changed from `base` to `ours` (edits made in a room the host had not yet
 * acknowledged when it replaced the room with another device's), merged three
 * ways into `theirs` (the new room), as merges are made (0025): an edit the new
 * room already holds is not made twice. The document to make the new room's, or
 * null if it holds them all.
 */
export function carryOver(type: DocumentType, base: PMNode, ours: PMNode, theirs: PMNode, sides: [MergeSide, MergeSide]): PMNode | null {
  const b = type.serialize(base);
  const o = type.serialize(ours);
  if (o === b) return null;
  const t = type.serialize(theirs);
  const merged = type.merge ? type.merge(b, o, t, sides) : mergeLines(b, o, t, sides);
  return merged.text === t ? null : type.parse(merged.text).doc;
}
