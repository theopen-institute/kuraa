// Search's words, and its keys (as key bindings write them).

const rules = new Intl.PluralRules('en');
const count = (n: number, one: string, other: string) => `${n.toLocaleString()} ${rules.select(n) === 'one' ? one : other}`;

export const KEYS = {
  open: 'Mod-Shift-f',
} as const;

export const S = {
  title: 'Search',
  field: 'Search every file',
  matchCase: 'Match case',
  nothing: (q: string) => `Nothing found for “${q}”.`,
  summary: (matches: number, files: number, truncated: boolean) => `${count(matches, 'match', 'matches')} in ${count(files, 'file', 'files')}${truncated ? ' (only the first are shown)' : ''}.`,
  searching: 'Searching…',
  details: 'Details',
  /** The group it is listed under on the Markdown and shortcuts sheet: the client's own, to sit with Find and the Outline. */
  helpGroup: 'Finding your way',
  help: 'Search every file',
};
