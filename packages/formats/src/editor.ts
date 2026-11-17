// The editor modules for the standard document types, by type id: what each
// format does in the editor. Browser only; the host never loads this.
import type { FormatEditor } from '@kuraa/editor-kit';
import { pandocEditor } from '@kuraa/format-pandoc/editor';
import { rmarkdownEditor } from '@kuraa/format-rmarkdown/editor';

export const standardEditors: Record<string, FormatEditor> = {
  'pandoc-markdown': pandocEditor,
  rmarkdown: rmarkdownEditor,
};
