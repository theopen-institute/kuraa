// The file tree (docs/decisions/0087-navigation-is-made-of-components.md): the
// workspace's folders and files, as a navigation view. A feature with a client
// half only; this, its host half, says what it is and that it is on by default.
import { defineFeature } from '@kuraa/feature-kit/host';

export const filesFeature = defineFeature({
  id: 'files',
  label: 'File tree',
  description: 'The workspace’s folders and files, to open, drag into folders, and right-click.',
  onByDefault: true,
});
