// The Tauri app's side of the ShellBridge (packages/client/src/shell.ts), as
// window.kuraa: what the Electron app's preload offers, run in every page the
// main window shows, before the page's own scripts (the shell's initialization
// script, bundled into build/bridge.js). The launcher page uses home, openFolder
// and join; the client reads config at start-up, uses leave from Settings, picks
// folders with the system's dialog, asks the system's spell checker, and is told
// when the app's menu asks for Settings, Open Folder or the Help sheet, and when
// an update is ready. Everything else goes through the hub's API, as in a browser
// (decision 0047). The shell (src-tauri/src/bridge.rs) answers each call only from
// the pages it is for.
//
// The connection reaches the page in its address (`#kuraa-config=…`, put there
// by the shell, shell.rs), taken from it at once and kept for this tab, so
// reloading the window keeps it, as the Electron app's synchronous config did.
import type { FolderPurpose, ShellBridge, ShellConfig } from '@kuraa/client';

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke(cmd: string, args?: Record<string, unknown>): Promise<unknown> };
    /** Where the shell's calls to the page arrive (shell.rs's emit). */
    __kuraaShell?: { emit(event: string, value: unknown): void };
  }
}

const KEY = 'kuraa:shell-config';

const invoke = <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
  const ipc = window.__TAURI_INTERNALS__;
  return ipc ? (ipc.invoke(cmd, args) as Promise<T>) : Promise.reject(new Error('The app cannot be reached from this page.'));
};

/** The connection in the page's address (taken out of it, so it does not linger), else the one kept for this tab. */
function readConfig(): ShellConfig | null {
  const url = new URL(location.href);
  const m = /^#kuraa-config=([\w-]+)$/.exec(url.hash);
  if (m || url.searchParams.has('kuraa-shell')) {
    url.searchParams.delete('kuraa-shell');
    if (m) url.hash = '';
    history.replaceState(history.state, '', url.href.replace(/#$/, ''));
  }
  try {
    if (m) {
      const bytes = Uint8Array.from(atob(m[1]!.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      const config = JSON.parse(new TextDecoder().decode(bytes)) as ShellConfig;
      sessionStorage.setItem(KEY, JSON.stringify(config));
      return config;
    }
    const kept = sessionStorage.getItem(KEY);
    return kept ? (JSON.parse(kept) as ShellConfig) : null;
  } catch {
    return null;
  }
}

/** What the shell tells the page, by event: heard by whoever listens, or kept until someone does. */
const handlers = new Map<string, (value: unknown) => void>();
const waiting = new Map<string, unknown[]>();
window.__kuraaShell = {
  emit(event, value) {
    const h = handlers.get(event);
    if (h) h(value);
    else waiting.set(event, [...(waiting.get(event) ?? []), value]);
  },
};
function listen(event: string, fn: (value: unknown) => void): void {
  handlers.set(event, fn);
  for (const v of waiting.get(event) ?? []) fn(v);
  waiting.delete(event);
}

const isAppPage = location.protocol === 'tauri:' || location.hostname === 'tauri.localhost';
// The app's own pages have no connection; the client's has one (none in the address: not a page the shell sent here).
const config = isAppPage ? null : readConfig();

if (isAppPage || config) {
  // A joined host's page (managesHost false) is not this app's code: it may only go back to the app and ask the spell checker.
  const own = isAppPage || config?.managesHost === true;
  const bridge: ShellBridge = {
    config: () => config,
    openFolder: () => invoke('open_folder'),
    join: (url, token) => invoke<string | null>('join', { url, token }),
    leave: () => invoke('leave'),
    home: () => invoke('home'),
    ...(own
      ? {
          chooseFolder: (purpose: FolderPurpose) => invoke<string | null>('choose_folder', { purpose }),
          onUpdateReady: (show: (version: string) => void) => {
            listen('update-ready', (v) => show(String(v)));
            void invoke<string | null>('update_ready').then((v) => v && show(v), () => undefined);
          },
          restartToUpdate: () => void invoke('restart_to_update'),
        }
      : {}),
    // The app's menu: Settings (⌥⌘,), Open Folder (⌘O), and Help's Markdown and Shortcuts: the page shows them.
    onPreferences: (show) => listen('preferences', () => show()),
    onOpenFolder: (show) => listen('open-folder', () => show()),
    onHelp: (show) => listen('help', () => show()),
    // The system's spell checker, for the editor's own menus (a table's), which take the place of the webview's.
    spellingSuggestions: (word) => invoke<string[] | null>('spelling', { word: String(word) }).catch(() => null),
    addToDictionary: (word) => void invoke('learn_word', { word: String(word) }).catch(() => undefined),
  };
  Object.defineProperty(window, 'kuraa', { value: Object.freeze(bridge), configurable: false, writable: false });
}

// The closing page's (static/closing.html, 0131): told once everything is saved as the app quits, and Quit Now.
if (isAppPage) {
  Object.defineProperty(window, 'kuraaClosing', {
    value: Object.freeze({
      onSaved: (show: () => void) => {
        listen('closing-saved', () => show());
        void invoke<boolean>('closing_saved').then((saved) => saved && show(), () => undefined);
      },
      quitNow: () => void invoke('quit_now').catch(() => undefined),
    }),
  });
}
