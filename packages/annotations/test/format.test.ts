import { describe, expect, it } from 'vitest';
import { aboutOf, describePages, findPassage, fromCodePoints, mergePages, readPage, selectorsFor, toCodePoints, writePage, type Item } from '../src/format.js';

const ME = 'a'.repeat(64);
const comment = (id: string, value: string, modified = '2026-11-25T10:00:00Z', target: Item['target'] = '../p01.md'): Item => ({
  id, type: 'Annotation', motivation: 'commenting', created: '2026-11-25T10:00:00Z', modified,
  creator: { id: `urn:kuraa:person:${ME}`, type: 'Person', name: 'Ana' },
  body: { type: 'TextualBody', value, format: 'text/markdown', purpose: 'commenting' }, target,
});

describe('an annotation page', () => {
  it('is a W3C AnnotationPage, one annotation to a line, sorted by id, the same bytes whatever order', () => {
    const a = comment('urn:uuid:b', 'second');
    const b = comment('urn:uuid:a', 'first');
    const text = writePage([a, b], ME)!;
    expect(text).toBe(writePage([b, a], ME));
    const page = JSON.parse(text);
    expect(page).toMatchObject({ '@context': 'http://www.w3.org/ns/anno.jsonld', id: `@${ME}.jsonld`, type: 'AnnotationPage' });
    expect(page.items.map((i: Item) => i.id)).toEqual(['urn:uuid:a', 'urn:uuid:b']);
    expect(text.split('\n').filter((l) => l.includes('"motivation"'))).toHaveLength(2);
    expect(readPage(text)).toEqual([b, a].map((i) => expect.objectContaining({ id: i.id })));
    // None: no file.
    expect(writePage([], ME)).toBeNull();
    expect(readPage('not json')).toEqual([]);
  });

  it('keeps annotations of kinds it does not know, and whatever else they hold', () => {
    const odd = { id: 'urn:uuid:z', type: 'Annotation', motivation: 'bookmarking', target: '../p01.md', extra: { nested: [1, 2] } };
    expect(readPage(writePage([odd], ME))).toEqual([odd]);
  });

  it('merges a person’s two devices’ versions by id, the later change winning, never conflicting', () => {
    const base = writePage([comment('urn:uuid:a', 'one'), comment('urn:uuid:b', 'two')], ME)!;
    const x = writePage([comment('urn:uuid:a', 'one, edited', '2026-11-25T11:00:00Z'), comment('urn:uuid:b', 'two'), comment('urn:uuid:c', 'new here')], ME)!;
    const y = writePage([comment('urn:uuid:a', 'one, edited later', '2026-11-25T12:00:00Z')], ME)!;
    const merged = readPage(mergePages(base, x, y));
    expect(merged.map((i) => [i.id, (i.body as { value: string }).value])).toEqual([
      ['urn:uuid:a', 'one, edited later'],
      ['urn:uuid:c', 'new here'],
    ]);
    expect(mergePages(base, x, y)).toBe(mergePages(base, y, x));
  });
});

describe('a passage', () => {
  const text = '# Notes\n\nAfter the flood 🌊, I never trusted the council. Nobody came for us.\n';

  it('is named by its quote and its place in code points, and found again there', () => {
    const from = text.indexOf('I never trusted');
    const to = from + 'I never trusted the council'.length;
    const [quote, place] = selectorsFor(text, from, to) as [{ exact: string; prefix: string; suffix: string }, { start: number; end: number }];
    expect(quote.exact).toBe('I never trusted the council');
    expect(quote.suffix.startsWith('. Nobody')).toBe(true);
    // The wave is two JavaScript units and one code point.
    expect(place.start).toBe(from - 1);
    expect(fromCodePoints(text, place.start)).toBe(from);
    expect(toCodePoints(text, from)).toBe(place.start);
    const about = aboutOf({ id: 'x', target: { source: '../p01.md', selector: [quote, place] } } as Item);
    expect(about).toMatchObject({ kind: 'passage', exact: 'I never trusted the council' });
    expect(findPassage(text, about as never)).toEqual({ from, to });
  });

  it('is found by its quote when the text moved, the one whose surroundings agree, and not when its words are gone', () => {
    const p = { kind: 'passage' as const, exact: 'the council', prefix: 'I never trusted ', suffix: '. Nobody', start: 5, end: 16 };
    const moved = 'The council met. Later: I never trusted the council. Nobody came.';
    expect(findPassage(moved, p)).toEqual({ from: moved.lastIndexOf('the council'), to: moved.lastIndexOf('the council') + 11 });
    expect(findPassage('Nothing of it here.', p)).toBeNull();
  });

  it('is about the document, or another annotation, as its target says', () => {
    expect(aboutOf(comment('urn:uuid:a', 'x'))).toEqual({ kind: 'document' });
    expect(aboutOf({ ...comment('urn:uuid:a', 'x'), motivation: 'replying', target: 'urn:uuid:parent' })).toEqual({ kind: 'annotation', id: 'urn:uuid:parent' });
  });
});

describe('what a change did', () => {
  it('says so in a few words', () => {
    const before = writePage([comment('urn:uuid:a', 'one')], ME);
    const after = writePage([comment('urn:uuid:a', 'one, edited', 'later'), comment('urn:uuid:b', 'two'), { ...comment('urn:uuid:c', 'reply'), motivation: 'replying' }], ME);
    expect(describePages(before, after)).toBe('1 comment added, 1 comment changed, 1 reply added');
    expect(describePages(after, null)).toBe('2 comments removed, 1 reply removed');
  });
});
