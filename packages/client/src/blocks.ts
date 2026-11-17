// The block to make when the user needs somewhere to type (after a code block at
// the end of a document, say): the schema's default block for the top level, as
// ProseMirror's own commands use. Paragraphs, for the markdown formats.
import type { NodeType, Schema } from 'prosemirror-model';

export function defaultBlock(schema: Schema): NodeType | null {
  const type = schema.topNodeType.contentMatch.defaultType;
  return type?.isTextblock && !type.spec.code ? type : null;
}
