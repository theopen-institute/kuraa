// The manuscript's words.

export const S = {
  label: 'Manuscript',
  make: 'Make a manuscript',
  made: (folder: string) => `${folder || 'The top level'} is a manuscript: its documents, in the folder’s order, make one book. Drag them to arrange them.`,
  unmake: 'No longer a manuscript',
  unmade: (title: string) => `${title} is no longer a manuscript. Its files are as they were.`,
  isManuscript: (title: string) => `Manuscript: ${title}`,
  exclude: 'Leave out of the manuscript',
  include: 'Put back in the manuscript',
  leftOut: 'Left out of the manuscript',
};
