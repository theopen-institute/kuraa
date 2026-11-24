// The words the desktop app's own parts show (its menus, its dialogs, what it
// says when joining a host), apart from the client's (packages/client/src/
// strings.ts) and in the same plain words: a *host* and its *access code*, a
// folder whose every version is kept. British spelling.

export const D = {
  menu: {
    preferences: 'Settings…',
    yourWorkspaces: 'Your Workspaces',
    openFolder: 'Open Folder…',
    help: 'Help',
    shortcuts: 'Markdown and Shortcuts',
    checkUpdates: 'Check for Updates…',
    showLog: 'Show Log File',
  },
  updates: {
    title: 'Updates',
    checking: 'Looking for a newer version of kuraa…',
    latest: (version: string) => `kuraa ${version} is the latest version.`,
    downloading: (version: string) => `Downloading kuraa ${version}…`,
    starting: 'Starting the download…',
    /** How far a download has come: 12 MB of 98 MB · 4.1 MB a second. */
    progress: (done: string, total: string, speed: string | null) => `${done} of ${total}${speed ? ` · ${speed} a second` : ''}`,
    ready: (version: string) => `kuraa ${version} is ready.`,
    readyDetail: 'Restart now to use it, or it is put in place when kuraa next starts.',
    failedTitle: 'Could not update kuraa.',
    off: (why: string) => `This copy of kuraa does not update itself${why ? ` (${why})` : ''}.`,
    restart: 'Restart Now',
    later: 'Later',
    /** Closes the window; the download goes on, and the page says when it is ready. */
    hide: 'Hide',
    ok: 'OK',
  },
  folder: {
    choose: 'Choose a workspace folder',
    whereNew: 'Where new workspaces go',
    whereData: 'Where packages and tools are kept',
    useAsk: (name: string) => `Use “${name}” as a workspace?`,
    useDetail: (items: number) =>
      `kuraa keeps every version of the files in it${items ? `, starting with the ${items === 1 ? 'item' : `${items} items`} already there` : ''}. The history is kept inside the folder (as git does), and the folder stays usable by other programs.`,
    use: 'Use this folder',
    cancel: 'Cancel',
    missing: (path: string) => `There is no folder at ${path}.`,
    couldNotOpen: 'Could not open the folder',
  },
  errors: {
    workspaces: 'Could not open your workspaces',
    notAllowed: 'Not allowed.',
  },
  join: {
    rejected: 'The host did not accept the access code.',
    answered: (status: number) => `The host could not be joined (it answered ${status}).`,
    unreachable: (url: string, why: string) => `Cannot reach ${url}: ${why}`,
  },
  lookUp: (text: string) => `Look Up “${text}”`,
  noSuggestions: 'No suggestions',
  addToDictionary: 'Add to Dictionary',
} as const;
