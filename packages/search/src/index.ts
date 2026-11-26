// Search (docs/decisions/0089-preview-search-and-outline-are-components.md): every
// text file of the workspace, and open documents as they are being typed. The
// searching is the host's (0042), asked through the core; this is a feature
// with a client half only, and this, its host half, says what it is and that it
// is on by default.
import { defineFeature } from '@kuraa/feature-kit/host';

export const searchFeature = defineFeature({
  id: 'search',
  label: 'Search',
  description: 'Search every file of the workspace (⇧⌘F).',
  onByDefault: true,
});
