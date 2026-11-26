// The kinds of file offered for a new file or a file's kind (FileActions.vue, RenameDialog.vue).
import type { TypeRegistry } from '@kuraa/kernel';

export interface FileTypeChoice {
  id: string;
  label: string;
  /** The usual extension for new files of this type, with the dot. */
  extension: string;
  /** Heading the type is listed under. */
  group: string;
  /** Documents of this type have a title: a new one is asked for its title, not a filename. */
  titled: boolean;
}

/** Types offered for new files: documents first (Markdown leading), then text and source files by name. */
export function fileTypeChoices(registry: TypeRegistry): FileTypeChoice[] {
  const choices = registry.all()
    .filter((t) => t.extensions?.length)
    .map((t) => ({ id: t.id, label: t.label, extension: t.extensions![0]!, group: t.editor?.layout ? 'Text and source files' : 'Documents', titled: !!t.title }));
  const rank = (c: FileTypeChoice) => (c.group === 'Documents' ? 0 : 1);
  return choices.sort((a, b) => rank(a) - rank(b) || (a.id === 'pandoc-markdown' ? -1 : b.id === 'pandoc-markdown' ? 1 : a.label.localeCompare(b.label)));
}
