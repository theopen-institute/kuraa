// The R Markdown editor: the Pandoc editor, plus knitr chunks. A fence with a
// header in braces (```{r label, echo=FALSE}) makes a chunk, by Enter or a
// space; ⌥⌘I inserts an empty R chunk. Running chunks is the client's job
// (the format's node view hint says chunks can run).
import { createPandocEditor, insertNode } from '@kuraa/format-pandoc/editor';
import type { FormatEditor } from '@kuraa/editor-kit';

const chunkAttrs = (header: string) => ({ header, engine: /^\s*([A-Za-z][\w-]*)/.exec(header)?.[1] ?? 'r' });

export const rmarkdownEditor: FormatEditor = {
  label: 'R Markdown editing',
  description: 'Markdown editing, plus fences that make code chunks, ⌥⌘I for a new R chunk, and R Markdown’s header fields.',
  ...createPandocEditor({
    fence(info, schema) {
      const chunk = schema.nodes.code_chunk;
      return chunk && info.startsWith('{') ? { type: chunk, attrs: chunkAttrs(info.slice(1, -1)) } : null;
    },
    keys: (schema) => ({ 'Mod-Alt-i': insertNode(schema.nodes.code_chunk) }),
    // Listed with the client's keys for running chunks (its group has this title).
    help: [
      { group: 'Code chunks', does: 'New R chunk', type: '```{r}', enter: true, keys: ['Mod-Alt-i'], note: 'options in the braces: {r label, echo=FALSE}' },
    ],
    headerFields: [
      {
        key: 'output',
        label: 'Output',
        description: 'What knitting makes. With options (toc: true, …) it is edited as YAML.',
        group: 'R Markdown',
        kind: 'text',
        choices: ['html_document', 'pdf_document', 'word_document', 'html_notebook', 'md_document', 'github_document', 'beamer_presentation', 'ioslides_presentation', 'slidy_presentation', 'powerpoint_presentation'],
      },
      { key: 'params', label: 'Parameters', description: 'Values the document reads as params$name, one name: value per line.', group: 'R Markdown', kind: 'yaml', initial: { name: 'value' } },
      { key: 'always_allow_html', label: 'Allow HTML everywhere', description: 'Keep HTML output (widgets, say) when knitting to PDF or Word.', group: 'R Markdown', kind: 'boolean' },
    ],
  }),
};
