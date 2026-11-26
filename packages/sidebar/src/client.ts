// The sidebar's client half (0087): a layout that gives navigation (it offers
// the workspaces and Settings, through the core's menu of workspaces).
import { createApp } from 'vue';
import { defineClientFeature } from '@kuraa/feature-kit/client';
import SidebarLayout from './SidebarLayout.vue';

export const sidebarClient = defineClientFeature({
  id: 'sidebar',
  layout: {
    id: 'sidebar',
    label: 'Sidebar',
    navigation: true,
    mount(element, ctx) {
      const app = createApp(SidebarLayout, { ctx });
      app.mount(element);
      return () => app.unmount();
    },
  },
});
