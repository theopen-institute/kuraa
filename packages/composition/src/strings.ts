// Composition mode's words.
export const S = {
  label: 'Composition mode',
  menu: 'Composition mode',
  help: 'The page alone, full screen: nothing but what you are writing. Escape leaves it.',
  countLabel: 'Words',
  count: (words: number, target: number | null) => (target
    ? `${words.toLocaleString()} of ${target.toLocaleString()} words · ${Math.min(999, Math.round((words / target) * 100))}%`
    : `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'}`),
  typewriter: 'Typewriter scrolling',
  typewriterAbout: 'The line you are writing stays at one height on the screen.',
  showCount: 'Word count and target',
  showCountAbout: 'At the foot of the page: the document’s words, and its target where it has one.',
  fade: 'Fade the other paragraphs',
  fadeAbout: 'Only the paragraph you are writing in at full strength.',
};
