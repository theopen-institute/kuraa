// Word counts' words.

const n = (x: number) => x.toLocaleString();

export const S = {
  panel: 'Words',
  count: (words: number, target: number | null) => (target ? `${n(words)} / ${n(target)} words` : `${n(words)} ${words === 1 ? 'word' : 'words'}`),
  today: (written: number, target: number | null) => `${written > 0 ? '+' : ''}${n(written)}${target ? ` / ${n(target)}` : ''} today`,
  statusTitle: 'Words in this document, and written today: click for targets',
  thisDocument: 'This document',
  words: 'words',
  documentTarget: 'Target for this document',
  documentTargetAbout: 'Kept in the document’s header (target-words), for everyone who opens it.',
  noHeader: 'This kind of document has no header to keep a target in.',
  todayTitle: 'Today',
  written: (x: number) => (x === 1 ? 'word written today' : 'words written today'),
  sessionTarget: 'Target for a day',
  sessionAbout: 'Counted in this browser: each document’s words now, less its words when you first opened it today. A new day starts afresh.',
  restart: 'Start counting again',
  none: 'None',
  reached: 'Reached',
  of: (pct: number) => `${pct}%`,
  folders: 'A folder’s words, and a target for a book, are in Compile (right-click a folder, Compile…).',
};
