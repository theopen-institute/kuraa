// What automatic commits say.
import { describe, expect, it } from 'vitest';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { textFile } from '@kuraa/format-text';
import { changedParts, describeEdit } from '../src/messages.js';

const DOC = '---\ntitle: Field notes\n---\n\nIntro.\n\n# Methods\n\nWe walked.\n\n# Results\n\nCrabs.\n\n# Discussion\n\nMore crabs.\n';

describe('automatic commit messages', () => {
  it('name the document, the headings over what changed, and who edited', () => {
    const after = DOC.replace('We walked.', 'We walked twice.').replace('More crabs.', 'Fewer crabs.');
    expect(describeEdit(pandocMarkdown, 'notes/field.md', DOC, after, ['Ada', 'Bo', 'Ada'])).toBe('Edit Field notes: Methods, Discussion (Ada, Bo)');
    expect(describeEdit(pandocMarkdown, 'notes/field.md', null, DOC, [])).toBe('Create Field notes');
  });

  it('count a changed heading, the header, removed blocks, and text before any heading', () => {
    expect(changedParts(pandocMarkdown, DOC, DOC.replace('# Results', '# Findings'))).toEqual(['Findings', 'Results']);
    expect(changedParts(pandocMarkdown, DOC, DOC.replace('title: Field notes', 'title: Notes'))).toEqual(['header']);
    expect(changedParts(pandocMarkdown, DOC, DOC.replace('Crabs.\n\n', ''))).toEqual(['Results']);
    expect(changedParts(pandocMarkdown, DOC, DOC.replace('Intro.', 'Introduction.'))).toEqual([]);
  });

  it('shorten a long list of parts, and name files without titles by filename', () => {
    const after = DOC.replace('Intro.', 'I.').replace('We walked.', 'W.').replace('Crabs.', 'C.').replace('More crabs.', 'M.').replace('title: Field notes', 'title: Field notes\nlang: en');
    expect(describeEdit(pandocMarkdown, 'f.md', DOC, after, [])).toBe('Edit Field notes: header, Methods, Results and 1 more');
    const r = textFile;
    expect(describeEdit(r, 'scripts/clean.R', 'x <- 1\n', 'x <- 2\n', ['Ada'])).toBe('Edit clean.R (Ada)');
  });
});
