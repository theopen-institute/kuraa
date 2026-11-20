// The kuraa client: one web application, wrapped per platform by a shell.
import { createApp } from 'vue';
import App from './App.vue';
import type { AppProps } from './types.js';

export { App };
export type { AppProps };
export { HostApi, ApiError, type WorkspaceInfo, type TreeFile, type RoomInfo, type CommitInfo } from './api.js';
export type { EditorContext, FormatEditor } from '@kuraa/editor-kit';
export { webShell, type Shell, type ShellBridge, type ShellConfig, type PersonShell, type PersonInfo, type FolderPurpose } from './shell.js';
export { loadSettings, saveSettings, isComplete, type Settings } from './settings.js';

/** Mount the client into an element. Returns how to unmount it. */
export function mountApp(element: HTMLElement, props: AppProps): () => void {
  const app = createApp(App, { ...props });
  app.mount(element);
  return () => app.unmount();
}
