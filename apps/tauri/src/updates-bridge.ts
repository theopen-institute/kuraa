// The updates window's bridge (Check for Updates…: shell.rs's show_updates),
// as window.updates, what its page (the Electron app's static/updates.html) draws
// from: what to show, as it changes, and which button was pressed. Nothing else.
// The shell sends how updating stands (updates.rs, in the shape of the Electron
// app's UpdateStatus); what that shows is worked out here, by the same pure
// function the Electron app's window uses (update-view.ts), with its words.
import { updateView, type UpdateChoice, type UpdateStatus, type UpdateView } from '../../desktop/src/update-view.js';

declare const __KURAA_VERSION__: string;

declare global {
  interface Window {
    __kuraaUpdates?: (status: UpdateStatus) => void;
  }
}

const invoke = (cmd: string, args?: Record<string, unknown>) => window.__TAURI_INTERNALS__?.invoke(cmd, args).catch(() => undefined);

let show: ((v: UpdateView) => void) | null = null;
let last: UpdateStatus | null = null;
window.__kuraaUpdates = (status) => {
  last = status;
  show?.(updateView(status, __KURAA_VERSION__));
};

Object.defineProperty(window, 'updates', {
  value: Object.freeze({
    onView: (fn: (v: UpdateView) => void) => {
      show = fn;
      if (last) fn(updateView(last, __KURAA_VERSION__));
      void invoke('updates_ready');
    },
    choose: (choice: UpdateChoice) => void invoke('updates_choose', { choice }),
    size: (height: number) => void invoke('updates_size', { height }),
  }),
});
