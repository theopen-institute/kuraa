// Search's client half (0089): a workspace's panel, with an icon (so navigation
// offers a button for it), opened by its keys (⇧⌘F), which while it is open put
// the cursor back in its field rather than close it.
import { createApp } from 'vue';
import { defineClientFeature } from '@kuraa/feature-kit/client';
import SearchPanel from './SearchPanel.vue';
import { KEYS, S } from './strings.js';

export const searchClient = defineClientFeature({
  id: 'search',
  helpGroup: S.helpGroup,
  panels: [{
    id: 'search',
    label: S.title,
    about: 'workspace',
    keys: KEYS.open,
    toggle: false,
    help: S.help,
    // A magnifying glass.
    icon: { paths: ['M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0z', 'M10.5 10.5 14 14'] },
    mount(element, ctx) {
      const app = createApp(SearchPanel, { ctx });
      app.mount(element);
      return () => app.unmount();
    },
  }],
});
