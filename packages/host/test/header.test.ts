// A document's header changed by its fields (0095): only those named, the rest
// of the header and the document as they were.
import { describe, expect, it } from 'vitest';
import { withHeaderFields } from '../src/header.js';

describe('header fields set in a document’s text', () => {
  it('sets and takes away fields, keeping the rest of the header, its comments, and the text', () => {
    const doc = '---\ntitle: The harbour # kept\nstatus: Draft\n---\n\nBoats.\n';
    expect(withHeaderFields(doc, { synopsis: 'They arrive.', status: 'Done' })).toBe('---\ntitle: The harbour # kept\nstatus: Done\nsynopsis: They arrive.\n---\n\nBoats.\n');
    expect(withHeaderFields(doc, { status: null })).toBe('---\ntitle: The harbour # kept\n---\n\nBoats.\n');
    expect(withHeaderFields(doc, { status: 'Draft' })).toBe(doc);
  });

  it('makes a header where there is none, and takes it away when it is left with no fields', () => {
    expect(withHeaderFields('Just text.\n', { label: 'Scene' })).toBe('---\nlabel: Scene\n---\n\nJust text.\n');
    expect(withHeaderFields('---\nlabel: Scene\n---\n\nJust text.\n', { label: '' })).toBe('Just text.\n');
  });

  it('keeps Windows line ends, and refuses a header that does not parse', () => {
    expect(withHeaderFields('---\r\ntitle: A\r\n---\r\nText\r\n', { status: 'Done' })).toBe('---\r\ntitle: A\r\nstatus: Done\r\n---\r\nText\r\n');
    expect(() => withHeaderFields('---\ntitle: [unclosed\n---\nText\n', { status: 'x' })).toThrow(/not valid YAML/);
  });
});
