// Works out which shell this page runs in, and the connection it supplies.
// This is the only place that knows about the different shells:
//
//   desktop app   the preload script exposes window.kuraa (a ShellBridge)
//   pnpm dev      Vite was started with the dev host's token; the host is
//                 behind Vite's proxy at this page's own origin
//   web           a host or hub serves this page; a link may carry ?token=… (and
//                 ?host=…, and on a hub ?w=<workspace>), remembered for this tab so reloads work
import { webShell, type Settings, type Shell, type ShellBridge } from '@kuraa/client';

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
        openFolder: () => void bridge.openFolder(),
        leave: () => void bridge.leave(),
        // The key of this computer, which runs the host: only on the app's own workspaces.
        ...(config?.managesHost && bridge.person && bridge.createPerson && bridge.importPerson && bridge.copyPerson && bridge.revokeKey ? {
          person: {
            afterChange: 'Your workspaces restart, and it vouches for this computer\'s key.',
            get: () => bridge.person!(),
            create: (name: string) => bridge.createPerson!(name),
            import: (line: string) => bridge.importPerson!(line),
            copy: () => bridge.copyPerson!(),
            revoke: (key: string) => bridge.revokeKey!(key),
          },
        } : {}),
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
  const fromLink = { hostUrl: take('host'), token: take('token') };
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
