// The desktop side of the ShellBridge (see packages/client/src/shell.ts), exposed
// to the page as window.kuraa. The launcher page uses home, openFolder and join; the
// client reads config at start-up, uses leave from Settings, picks folders with
// the native dialog, and is told when the app's menu asks for Preferences, Open
// Folder or the Help sheet. Everything else (Preferences, identity, opening a
// folder) goes through the hub's API, as in a browser (decision 0047).
import { contextBridge, ipcRenderer, webFrame } from 'electron';
import type { ShellBridge, ShellConfig } from '@kuraa/client';

const bridge: ShellBridge = {
  // Synchronous, so the client has its connection before it first renders.
  config: () => ipcRenderer.sendSync('kuraa:config') as ShellConfig | null,
  openFolder: () => ipcRenderer.invoke('kuraa:open-folder'),
  join: (url, token) => ipcRenderer.invoke('kuraa:join', url, token),
  leave: () => ipcRenderer.invoke('kuraa:leave'),
  home: () => ipcRenderer.invoke('kuraa:home'),
  chooseFolder: (purpose) => ipcRenderer.invoke('kuraa:choose-folder', purpose) as Promise<string | null>,
  // The app's menu: Preferences (⌥⌘,), Open Folder (⌘O), and Help's Markdown and Shortcuts: the page shows them.
  onPreferences: (show) => {
    ipcRenderer.on('kuraa:preferences', () => show());
  },
  onOpenFolder: (show) => {
    ipcRenderer.on('kuraa:open-folder', () => show());
  },
  onHelp: (show) => {
    ipcRenderer.on('kuraa:help', () => show());
  },
  // An update downloaded (updates.ts): the page says so, with Restart now.
  onUpdateReady: (show) => {
    ipcRenderer.on('kuraa:update-ready', (_e, version: unknown) => show(String(version)));
    ipcRenderer.send('kuraa:update-ready?');
  },
  restartToUpdate: () => ipcRenderer.send('kuraa:restart-to-update'),
  // The spell checker, for the page's own menus (a table's), which take the place of the native one.
  spellingSuggestions: (word) => (webFrame.isWordMisspelled(String(word)) ? webFrame.getWordSuggestions(String(word)).slice(0, 6) : null),
  addToDictionary: (word) => ipcRenderer.send('kuraa:add-to-dictionary', String(word)),
};
contextBridge.exposeInMainWorld('kuraa', bridge);

// A right-click the page answered with a menu of its own (a table's, the file list's) gets no
// native one: the main process is told, once the page's handlers have run, whether it was.
window.addEventListener('contextmenu', (e) => ipcRenderer.send('kuraa:context-menu', e.defaultPrevented));
