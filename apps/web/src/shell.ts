// Works out which shell this page runs in, and the connection it supplies.
// This is the only place that knows about the different shells:
//
//   desktop app   the preload script exposes window.kuraa (a ShellBridge)
//   pnpm dev      Vite was started with the dev host's token; the host is
//                 behind Vite's proxy at this page's own origin
//   web           a host or hub serves this page; a link may carry ?token=… (with
//                 ?host=… if it is another server's; on a hub ?w=<workspace>), remembered
//                 for this tab so reloads work
import { webShell, type FolderPurpose, type Settings, type Shell, type ShellBridge } from '@kuraa/client';

export interface ResolvedShell {
  shell: Shell;
  /** Win over stored settings. */
  overrides: Partial<Settings>;
  /** Fill gaps in stored settings. */
  defaults: Partial<Settings>;
}

const TAB_KEY = 'kuraa:connection';

export function resolveShell(): ResolvedShell {
  const bridge = (window as { kuraa?: ShellBridge }).kuraa;
  if (bridge) {
    const config = bridge.config();
    return {
      shell: {
        managesHost: config?.managesHost ?? false,
        workspace: config?.workspace,
        leave: () => void bridge.leave(),
        // Its own workspaces again, with the hub's current address and access code.
        ...(config?.managesHost ? { reconnect: () => void bridge.home() } : {}),
        // The app's own folder dialog, and its menu's Preferences, Open Folder and Help.
        ...(bridge.chooseFolder ? { chooseFolder: (purpose: FolderPurpose) => bridge.chooseFolder!(purpose) } : {}),
        ...(bridge.onPreferences ? { onPreferences: (show: () => void) => bridge.onPreferences!(show) } : {}),
        ...(bridge.onOpenFolder ? { onOpenFolder: (show: () => void) => bridge.onOpenFolder!(show) } : {}),
        ...(bridge.onHelp ? { onHelp: (show: () => void) => bridge.onHelp!(show) } : {}),
        // The app updating itself (decision 0051): Restart now, once an update is downloaded.
        ...(bridge.onUpdateReady ? { onUpdateReady: (show: (version: string) => void) => bridge.onUpdateReady!(show) } : {}),
        ...(bridge.restartToUpdate ? { restartToUpdate: () => bridge.restartToUpdate!() } : {}),
        // Its spell checker, for the editor's own menus (a table's), which take the place of its own.
        ...(bridge.spellingSuggestions && bridge.addToDictionary
          ? { spelling: { suggest: (word: string) => bridge.spellingSuggestions!(word), learn: (word: string) => bridge.addToDictionary!(word) } }
          : {}),
      },
      overrides: config ? { hostUrl: config.hostUrl, token: config.token } : {},
      defaults: config ? { name: config.name, email: config.email } : {},
    };
  }

  const devToken = import.meta.env.VITE_KURAA_DEV_TOKEN;
  if (devToken) {
    return {
      shell: { managesHost: true },
      overrides: { hostUrl: location.origin, token: devToken },
      defaults: { name: import.meta.env.VITE_KURAA_DEV_NAME ?? '', email: import.meta.env.VITE_KURAA_DEV_EMAIL ?? '' },
    };
  }

  // Host and token from the link override stored settings; name and email only
  // fill gaps. They leave the address bar so the token does not linger in history.
  const url = new URL(location.href);
  const take = (param: string) => {
    const value = url.searchParams.get(param) ?? '';
    url.searchParams.delete(param);
    return value;
  };
  // A code is for the server named with it, else for this page's own: an address
  // alone is ignored, so a link can never send a code kept here somewhere else.
  const linkHost = take('host');
  const linkToken = take('token');
  const fromLink: Partial<Settings> = linkToken ? { hostUrl: linkHost || location.origin, token: linkToken } : {};
  const defaults = { name: take('name'), email: take('email') };
  // On a hub, ?w=<id> opens that workspace.
  const workspace = take('w');
  if (url.href !== location.href) history.replaceState(null, '', url);

  // Remembered for this tab, so a reload keeps the connection and the suggested name.
  let tab: { overrides: Partial<Settings>; defaults: Partial<Settings> };
  try {
    const stored = JSON.parse(sessionStorage.getItem(TAB_KEY) ?? '{}') as Partial<typeof tab>;
    tab = { overrides: stored.overrides ?? {}, defaults: stored.defaults ?? {} };
    if (fromLink.hostUrl || fromLink.token) tab.overrides = fromLink;
    if (defaults.name || defaults.email) tab.defaults = defaults;
    sessionStorage.setItem(TAB_KEY, JSON.stringify(tab));
  } catch {
    tab = { overrides: fromLink, defaults };
  }
  return { shell: workspace ? { ...webShell, workspace } : webShell, ...tab };
}
