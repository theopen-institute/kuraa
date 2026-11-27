// The corkboard's and the outline's words.

const n = (x: number) => x.toLocaleString();

export const S = {
  corkboard: 'Corkboard',
  outline: 'Outline',
  top: 'Workspace',
  crumbs: 'The folders above it',
  empty: 'Nothing in this folder yet.',
  summary: (documents: number, words: number) => `${n(documents)} ${documents === 1 ? 'document' : 'documents'} · ${n(words)} ${words === 1 ? 'word' : 'words'}`,
  noSynopsis: 'Synopsis…',
  synopsisPlaceholder: 'Synopsis…',
  folderCard: (documents: number, words: number) => `Folder · ${n(documents)} ${documents === 1 ? 'document' : 'documents'} · ${n(words)} ${words === 1 ? 'word' : 'words'}`,
  file: 'File',
  words: (x: number, target: number | null) => (target ? `${n(x)} / ${n(target)} words` : `${n(x)} ${x === 1 ? 'word' : 'words'}`),
  columns: { title: 'Title', synopsis: 'Synopsis', label: 'Label', status: 'Status', words: 'Words', target: 'Target' },
  open: (title: string) => `Open ${title}`,
  openFolder: (name: string) => `Show ${name}`,
  dragHint: 'Drag to arrange: the file tree follows',
  saveFailed: (why: string) => `Not saved: ${why}`,
};
