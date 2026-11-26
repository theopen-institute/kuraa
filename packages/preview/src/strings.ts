// Preview's words, and its keys (as key bindings write them).

const rules = new Intl.PluralRules('en');
const count = (n: number, one: string, other: string) => `${n.toLocaleString()} ${rules.select(n) === 'one' ? one : other}`;

export const KEYS = {
  open: 'Mod-Shift-r',
} as const;

export const S = {
  title: 'Preview',
  render: 'Render',
  renderTitle: (key: string) => `Render the document as it is now (${key})`,
  saveAs: 'Save as',
  saveTitle: (label: string) => `Render the document as it is now to ${label}, and save it`,
  onSave: 'Update when saved',
  cannot: 'This file cannot be rendered.',
  nothingYet: 'Nothing rendered yet. Render shows the document here as readers will see it.',
  rendering: (label: string, progress: string | null) => `Rendering ${label}…${progress ? ` ${progress}` : ''}`,
  done: (message: string, at: string, by: string | null) => `${message} ${at}${by ? `, for ${by}` : ''}.`,
  frame: 'The rendered document',
  download: (label: string, mb: string) => `Download ${label} (about ${mb})`,
  downloading: (label: string, progress: string | null) => `Downloading ${label}…${progress ? ` ${progress}` : ''}`,
  downloadFailed: (label: string, why: string) => `${label} could not be downloaded: ${why}`,
  formats: { html: 'HTML', docx: 'Word', pdf: 'PDF' } as Record<string, string>,
  madeFrom: 'Files it was made from…',
  madeFromTitle: 'Save the workspace’s files as they were when this was rendered (a zip), to make it again or keep with it',
  madeFromUnsaved: (n: number) => `${count(n, 'file', 'files')} had changes not yet saved in the history when it was rendered: those are in the zip as last saved.`,
  details: 'Details',
  /** The group it is listed under on the Markdown and shortcuts sheet: the client's own, to sit with Find and Search. */
  helpGroup: 'Finding your way',
};
