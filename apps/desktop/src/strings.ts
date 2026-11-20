// The words the desktop app's own parts show (its menus, its dialogs, what it
// says when joining a server), apart from the client's (packages/client/src/
// strings.ts) and in the same plain words: a *server* and its *access code*, a
// folder whose every version is kept. British spelling.

export const D = {
  menu: {
    preferences: 'Preferences…',
    yourWorkspaces: 'Your Workspaces',
    openFolder: 'Open Folder…',
    join: 'Join Shared Server…',
    help: 'Help',
    shortcuts: 'Markdown and Shortcuts',
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
    rejected: 'The server did not accept the access code.',
    answered: (status: number) => `The server could not be joined (it answered ${status}).`,
    unreachable: (url: string, why: string) => `Cannot reach ${url}: ${why}`,
  },
  lookUp: (text: string) => `Look Up “${text}”`,
  noSuggestions: 'No suggestions',
  addToDictionary: 'Add to Dictionary',
} as const;
