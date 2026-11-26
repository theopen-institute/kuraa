// The sidebar (docs/decisions/0087-navigation-is-made-of-components.md): a
// layout down the left of the window, with the workspace, its connection and
// the navigation views. A feature with a client half only; this, its host half,
// says what it is and that it is on by default.
import { defineFeature } from '@kuraa/feature-kit/host';

export const sidebarFeature = defineFeature({
  id: 'sidebar',
  label: 'Sidebar',
  description: 'Navigation down the left: the workspace, its connection, and the ways of seeing its files.',
  onByDefault: true,
});
