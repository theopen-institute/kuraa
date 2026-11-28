import { describe, expect, it } from 'vitest';
import type { DocumentType } from '@kuraa/kernel';
import { detailsOfText, hasDetails, isEmpty, keywordsOf, labelColour } from '../src/details.js';

/** A type whose header is a line of `key=value` pairs (0123: any type's header will do). */
const plain = {
  header: {
    read: (text: string) => (text.startsWith('%') ? Object.fromEntries(text.split('\n')[0]!.slice(1).split(';').map((kv) => kv.split('=').map((x) => x.trim()))) : text.startsWith('!') ? null : {}),
    write: (text: string) => text,
  },
} as unknown as DocumentType;

describe('a document’s details (0094)', () => {
  it('are read from its header, as its type reads it: synopsis, label, status, keywords', () => {
    const d = detailsOfText(plain, '%title=The harbour; synopsis=They arrive at night.; label=Chapter; status=First draft; keywords=harbour, night\n\nText.\n');
    expect(d).toEqual({ synopsis: 'They arrive at night.', label: 'Chapter', status: 'First draft', keywords: ['harbour', 'night'] });
    expect(isEmpty(detailsOfText(plain, 'No header.\n'))).toBe(true);
    expect(isEmpty(detailsOfText(plain, '! a header that cannot be read\n'))).toBe(true);
  });

  it('are had by documents whose type has header fields (0123), none other', () => {
    expect(hasDetails(plain)).toBe(true);
    expect(hasDetails({} as DocumentType)).toBe(false);
    expect(hasDetails(undefined)).toBe(false);
    expect(isEmpty(detailsOfText(undefined, '%synopsis=x\n'))).toBe(true);
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
