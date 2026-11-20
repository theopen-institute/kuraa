// The desktop side of the ShellBridge (see packages/client/src/shell.ts), exposed
// to the page as window.kuraa. The launcher page uses home, openFolder and join; the
// client reads config at start-up and uses openFolder and leave from Settings.
// The Preferences window uses window.kuraaApp (preferences.ts).
import { contextBridge, ipcRenderer } from 'electron';
import type { ShellBridge, ShellConfig } from '@kuraa/client';
import type { AppBridge, PreferencesView } from './preferences.js';

const bridge: ShellBridge = {
  // Synchronous, so the client has its connection before it first renders.
  config: () => ipcRenderer.sendSync('kuraa:config') as ShellConfig | null,
  openFolder: () => ipcRenderer.invoke('kuraa:open-folder'),
  join: (url, token) => ipcRenderer.invoke('kuraa:join', url, token),
  leave: () => ipcRenderer.invoke('kuraa:leave'),
  home: () => ipcRenderer.invoke('kuraa:home'),
  // This computer's person's key: the client shows it in the menu's You section.
  person: () => ipcRenderer.invoke('kuraa:person'),
  createPerson: (name) => ipcRenderer.invoke('kuraa:create-person', name) as Promise<string | null>,
  importPerson: (line) => ipcRenderer.invoke('kuraa:import-person', line) as Promise<string | null>,
  copyPerson: () => ipcRenderer.invoke('kuraa:copy-person') as Promise<boolean>,
  revokeKey: (key) => ipcRenderer.invoke('kuraa:revoke-key', key) as Promise<string | null>,
  preferences: () => ipcRenderer.invoke('kuraa:show-preferences'),
  // The Help menu's Markdown and Shortcuts: the page shows its sheet.
  onHelp: (show) => {
    ipcRenderer.on('kuraa:help', () => show());
  },
};
contextBridge.exposeInMainWorld('kuraa', bridge);

const appBridge: AppBridge = {
  preferences: () => ipcRenderer.invoke('kuraa:preferences') as Promise<PreferencesView>,
  savePreferences: (p) => ipcRenderer.invoke('kuraa:save-preferences', p),
  chooseFolder: (purpose) => ipcRenderer.invoke('kuraa:choose-folder', purpose) as Promise<string | null>,
  chooseFile: () => ipcRenderer.invoke('kuraa:choose-file') as Promise<string | null>,
};
contextBridge.exposeInMainWorld('kuraaApp', appBridge);

// A right-click the page answered with a menu of its own (a table's, the file list's) gets no
// native one: the main process is told, once the page's handlers have run, whether it was.
window.addEventListener('contextmenu', (e) => ipcRenderer.send('kuraa:context-menu', e.defaultPrevented));
