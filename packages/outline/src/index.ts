// The Outline (docs/decisions/0089-preview-search-and-outline-are-components.md):
// the open document's headings, over its top left, to go to one. A feature with
// a client half only; this, its host half, says what it is and that it is on
// by default.
import { defineFeature } from '@kuraa/feature-kit/host';

export const outlineFeature = defineFeature({
  id: 'outline',
  label: 'Outline',
  description: 'The document’s headings, to go to one (⌥⌘O).',
  onByDefault: true,
});
