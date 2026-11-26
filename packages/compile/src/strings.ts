// Compile's words.
import type { CompileFormat } from './settings.js';

export const S = {
  label: 'Compile',
  compileMenu: 'Compile…',
  exclude: 'Leave out of Compile',
  include: 'Put back in Compile',
  leftOut: 'Left out of Compile',
  noHeading: 'No heading in Compile',
  heading: 'Heading in Compile',
  noHeadingMark: 'No heading in Compile: what is in it goes on at the level it is at',
  compiledAs: (title: string) => `Compiled as “${title}”`,
  none: 'Right-click a folder and choose Compile… to make one book of its documents, in the order the file tree shows them.',
  folderTitle: (folder: string) => `Compile ${folder}`,
  top: 'the whole workspace',
  bookTitle: 'Title',
  format: 'Format',
  formats: { docx: 'Word', pdf: 'PDF', html: 'HTML' } as Record<CompileFormat, string>,
  compile: 'Compile',
  compiling: 'Compiling…',
  saveAgain: 'Save again',
  saved: (name: string) => `Saved ${name}.`,
  details: 'Details',
  about: 'Folders’ names and documents’ titles become headings, one level deeper for each folder down. Documents and folders left out (faded in the file tree) are skipped; right-click one to put it back.',
  leftOutCount: (n: number) => (n === 1 ? '1 document or folder in it is left out.' : `${n} documents or folders in it are left out.`),
};
