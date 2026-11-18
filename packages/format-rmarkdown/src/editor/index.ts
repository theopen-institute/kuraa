// The R Markdown editor: the Pandoc editor, plus knitr chunks. A fence with a
// header in braces (```{r label, echo=FALSE}) makes a chunk, by Enter or a
// space; ⌥⌘I inserts an empty R chunk. Running chunks is the client's job
// (the format's node view hint says chunks can run).
import { createPandocEditor, insertNode } from '@kuraa/format-pandoc/editor';
import type { FormatEditor } from '@kuraa/editor-kit';

const chunkAttrs = (header: string) => ({ header, engine: /^\s*([A-Za-z][\w-]*)/.exec(header)?.[1] ?? 'r' });

export const rmarkdownEditor: FormatEditor = {
  label: 'R Markdown editing',
  description: 'Markdown editing, plus fences that make code chunks and ⌥⌘I for a new R chunk.',
  ...createPandocEditor({
    fence(info, schema) {
      const chunk = schema.nodes.code_chunk;
      return chunk && info.startsWith('{') ? { type: chunk, attrs: chunkAttrs(info.slice(1, -1)) } : null;
    },
    keys: (schema) => ({ 'Mod-Alt-i': insertNode(schema.nodes.code_chunk) }),
  }),
};
