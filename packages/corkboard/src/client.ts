// The corkboard's and the outline's client half (0095): two views of a folder
// for the main area, offered on a folder's menu; each switches to the other.
import { createApp } from 'vue';
import { defineClientFeature, type FolderViewContext } from '@kuraa/feature-kit/client';
import CorkboardView from './CorkboardView.vue';
import { S } from './strings.js';

const mountAs = (mode: 'cards' | 'rows') => (element: HTMLElement, ctx: FolderViewContext) => {
  const app = createApp(CorkboardView, { ctx, mode });
  app.mount(element);
  return () => app.unmount();
};

export const corkboardClient = defineClientFeature({
  id: 'corkboard',
  // Editing a document's synopsis, label, status or target in place: its header, open or not.
  uses: ['documents'],
  folderViews: [
    { id: 'corkboard', label: S.corkboard, mount: mountAs('cards') },
    { id: 'outline', label: S.outline, mount: mountAs('rows') },
  ],
});
