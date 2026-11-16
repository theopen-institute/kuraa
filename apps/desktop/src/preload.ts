// The launcher's bridge to the main process. The client itself needs nothing from here.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('kuraa', {
  openFolder: (): Promise<void> => ipcRenderer.invoke('kuraa:open-folder'),
  /** Resolves to an error message, or null once the client is loading. */
  join: (url: string, token: string): Promise<string | null> => ipcRenderer.invoke('kuraa:join', url, token),
});
