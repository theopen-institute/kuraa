// Composition mode (docs/decisions/0120-composition-mode.md): the page alone,
// full screen, with typewriter scrolling, the other paragraphs faded and the
// words at its foot. All of it is its client half's (client.ts); the host half
// only names it, for Settings › Components. It keeps nothing in the workspace:
// each person's settings are kept in their browser.
import { defineFeature } from '@kuraa/feature-kit/host';

export const compositionFeature = defineFeature({
  id: 'composition',
  label: 'Composition mode',
  description: 'The page alone, full screen, with typewriter scrolling and the words at its foot: ⌥⌘P, or the document’s ⋯ menu.',
  onByDefault: true,
});
