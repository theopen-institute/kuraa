// Word counts' words.

const n = (x: number) => x.toLocaleString();
const signed = (x: number) => `${x > 0 ? '+' : ''}${n(x)}`;

export const S = {
  panel: 'Words',
  /** The ⋯ menu's foot: the document's words, and your total today in every document (net). */
  footer: (words: number, today: number) => `Word count: ${n(words)} (Total today: ${today > 0 ? '+' : ''}${n(today)})`,
  thisDocument: 'This document',
  words: 'words',
  documentTarget: 'Target for this document',
  documentTargetAbout: 'Kept in the document’s header (target-words), for everyone who opens it.',
  noHeader: 'This kind of document has no header to keep a target in.',
  todayTitle: 'Today',
  net: 'net',
  added: 'added',
  netAbout: 'Net: how many more words there are. Added: the words written, so rewriting counts even where the length stays.',
  dayTarget: 'Target for a day, in words added',
  dayAbout: 'From the workspace’s history, on every device: each save counts on the day it was made, for everyone it names. Your target is kept in this browser.',
  daysTitle: 'The last seven days',
  everyone: 'Everyone today',
  you: ' (you)',
  noDays: 'Nothing written yet.',
  none: 'None',
  signed,
  folders: 'A folder’s words, and a target for a book, are in Compile (right-click a folder, Compile…).',
};
