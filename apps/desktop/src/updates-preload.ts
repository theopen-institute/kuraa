// The updates window's bridge (update-window.ts), exposed to its page as
// window.updates: what to show, as it changes, and which button was pressed.
// Nothing else: the page cannot reach the app's other calls.
import { contextBridge, ipcRenderer } from 'electron';
import type { UpdateChoice, UpdateView } from './update-view.js';

contextBridge.exposeInMainWorld('updates', {
  onView: (show: (v: UpdateView) => void) => {
    ipcRenderer.on('kuraa-updates:view', (_e, v: UpdateView) => show(v));
    ipcRenderer.send('kuraa-updates:ready');
  },
  choose: (choice: UpdateChoice) => ipcRenderer.send('kuraa-updates:choose', choice),
  size: (height: number) => ipcRenderer.send('kuraa-updates:size', height),
});
