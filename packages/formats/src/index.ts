// The document types a standard host and client load. Host and client must load
// the same implementations (a type's version is part of the room key), so both
// take this list; a shell or host may pass its own instead.
import type { DocumentType } from '@kuraa/kernel';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { rmarkdown } from '@kuraa/format-rmarkdown';
import { textTypes } from '@kuraa/format-text';

export const standardTypes: DocumentType[] = [pandocMarkdown, rmarkdown, ...textTypes];
