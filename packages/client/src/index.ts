// The kuraa client: one web application, wrapped per platform by a shell.
export { App, mountApp, type AppProps } from './App.js';
export { HostApi, ApiError, type WorkspaceInfo, type TreeFile, type RoomInfo, type CommitInfo } from './api.js';
export type { EditorContext, FormatEditor } from '@kuraa/editor-kit';
export { webShell, type Shell, type ShellBridge, type ShellConfig } from './shell.js';
export { loadSettings, saveSettings, isComplete, type Settings } from './settings.js';
