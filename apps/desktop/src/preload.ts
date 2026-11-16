// The desktop side of the ShellBridge (see packages/client/src/shell.ts), exposed
// to the page as window.kuraa. The launcher page uses openFolder and join; the
// client reads config at start-up and uses openFolder and leave from Settings.
import { contextBridge, ipcRenderer } from 'electron';
import type { ShellBridge, ShellConfig } from '@kuraa/client';

const bridge: ShellBridge = {
  // Synchronous, so the client has its connection before it first renders.
  config: () => ipcRenderer.sendSync('kuraa:config') as ShellConfig | null,
  openFolder: () => ipcRenderer.invoke('kuraa:open-folder'),
  join: (url, token) => ipcRenderer.invoke('kuraa:join', url, token),
  leave: () => ipcRenderer.invoke('kuraa:leave'),
};
contextBridge.exposeInMainWorld('kuraa', bridge);
