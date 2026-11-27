// Running code (docs/decisions/0092-running-code-is-a-component.md): the open
// document's code session in its ⋯ menu (how it stands, Run all, Interrupt,
// Restart) and the workspace's packages (Packages…, and in Settings ›
// Workspace). Running a chunk from the document, and the session on the host,
// stay the core's (0011, 0019); this is a feature with a client half only, and
// this, its host half, says what it is and that it is on by default.
import { defineFeature } from '@kuraa/feature-kit/host';

export const codeFeature = defineFeature({
  id: 'code',
  label: 'Running code',
  description: 'The document’s code session in its menu (Run all, Interrupt, Restart) and the workspace’s packages.',
  onByDefault: true,
});
