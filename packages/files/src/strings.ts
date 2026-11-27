// The file tree's words.

const rules = new Intl.PluralRules('en');
const count = (n: number, one: string, other: string) => `${n.toLocaleString()} ${rules.select(n) === 'one' ? one : other}`;

export const S = {
  label: 'Files',
  newFileIn: (name: string) => `New file in ${name}`,
  newFolderIn: (name: string) => `New folder in ${name}`,
  /** The space below the files, with none yet: its menu has a new file or folder. */
  space: 'New file or folder…',
  conflicts: (n: number) => count(n, 'conflict', 'conflicts'),
  conflictsTitle: (n: number) => `${count(n, 'passage was', 'passages were')} changed both here and elsewhere: both versions are in the document, to choose between. Click to go to the first`,
  noType: (path: string) => `${path}: Kuraa does not open this kind of file. You can rename, move or delete it.`,
  untitled: (path: string) => `${path}: no title yet (Rename… or Document settings… gives it one)`,
  readers: (words: string) => `Who can read it: ${words}`,
  writers: (words: string) => `Who can change it: ${words}`,
  fold: 'Close the folder',
  unfold: 'Open the folder',
  rename: 'Rename',
  delete: 'Delete',
  /** The group of its keys on the Markdown and shortcuts sheet: the client's own. */
  helpGroup: 'File list',
  help: {
    move: 'Move through files',
    folder: 'Open or close a folder',
    open: 'Open the file',
    rename: 'Rename',
    remove: 'Delete',
    menu: 'More',
    menuNote: 'new, move, the header',
  },
};
