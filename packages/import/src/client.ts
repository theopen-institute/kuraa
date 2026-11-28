// Import's client half (0116): Import… on a folder's menu, and on the top
// level's (right-clicking the files' empty space, ＋'s menu), opening its
// dialog for that folder.
import { createApp } from 'vue';
import { defineClientFeature, type FeatureMenuItem } from '@kuraa/feature-kit/client';
import ImportDialog from './ImportDialog.vue';
import { into } from './store.js';
import { S } from './strings.js';

export const importClient = defineClientFeature({
  id: 'import',
  panels: [{
    id: 'import',
    label: S.label,
    about: 'workspace',
    place: 'dialog',
    help: false,
    mount(element, ctx) {
      const app = createApp(ImportDialog, { ctx });
      app.mount(element);
      return () => app.unmount();
    },
  }],
  fileMenu(path, ctx): FeatureMenuItem[] {
    if (!path.endsWith('/')) return [];
    return [{
      label: S.menu,
      testid: 'context:import',
      run: () => {
        into.value = path.replace(/\/+$/, '');
        ctx.openPanel('import');
      },
    }];
  },
});
