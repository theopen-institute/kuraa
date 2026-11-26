// Preview (docs/decisions/0089-preview-search-and-outline-are-components.md): the
// open document rendered beside it, and saved as HTML, Word or PDF. Rendering
// is the host's (0041), asked through the core; this is a feature with a client
// half only, and this, its host half, says what it is and that it is on by
// default.
import { defineFeature } from '@kuraa/feature-kit/host';

export const previewFeature = defineFeature({
  id: 'preview',
  label: 'Preview',
  description: 'The document rendered beside it, and saved as HTML, Word or PDF (⇧⌘R).',
  onByDefault: true,
});
