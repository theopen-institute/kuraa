import { describe, expect, it } from 'vitest';
import { detailsOfText, isEmpty, keywordsOf, labelColour } from '../src/details.js';

describe('a document’s details (0094)', () => {
  it('are read from its header: synopsis, label, status, keywords', () => {
    const d = detailsOfText('---\ntitle: The harbour\nsynopsis: They arrive at night.\nlabel: Chapter\nstatus: First draft\nkeywords: [harbour, night, harbour]\n---\n\nText.\n');
    expect(d).toEqual({ synopsis: 'They arrive at night.', label: 'Chapter', status: 'First draft', keywords: ['harbour', 'night'] });
    expect(isEmpty(detailsOfText('No header.\n'))).toBe(true);
    expect(isEmpty(detailsOfText('---\ntitle: [unclosed\n---\n'))).toBe(true);
  });

  it('take keywords as a list or words with commas between', () => {
    expect(keywordsOf('sea, night , ,sea')).toEqual(['sea', 'night']);
    expect(keywordsOf(['a', 2, null])).toEqual(['a', '2']);
    expect(keywordsOf(undefined)).toEqual([]);
  });

  it('give a label the same colour each time, whatever its case', () => {
    expect(labelColour('Chapter')).toBe(labelColour('chapter'));
    expect(labelColour('Chapter')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
