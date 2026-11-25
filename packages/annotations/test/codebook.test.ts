import { describe, expect, it } from 'vitest';
import { codeAndBelow, codeTree, mergeCodebooks, parseCodebook, readCodebook, resolveCode, writeCodebook, type Code, type Codebook } from '../src/codebook.js';
import { codeOf, describePages, kindOf, writePage, type Item } from '../src/format.js';

const book = (codes: Code[]): Codebook => ({ scheme: 'urn:uuid:scheme', label: 'Codebook', codes });

describe('a codebook', () => {
  it('is a SKOS concept scheme, one code to a line, sorted by id, the same bytes whatever order', () => {
    const a: Code = { id: 'urn:uuid:b', label: 'Trust', definition: 'Saying who is relied on', color: '#0f766e' };
    const b: Code = { id: 'urn:uuid:a', label: 'Distrust', broader: 'urn:uuid:b', color: '#c2410c' };
    const text = writeCodebook(book([a, b]));
    expect(text).toBe(writeCodebook(book([b, a])));
    const v = JSON.parse(text);
    expect(v['@context'].prefLabel).toBe('skos:prefLabel');
    expect(v['@graph'][0]).toEqual({ id: 'urn:uuid:scheme', type: 'ConceptScheme', prefLabel: 'Codebook' });
    expect(v['@graph'][1]).toMatchObject({ id: 'urn:uuid:a', type: 'Concept', inScheme: 'urn:uuid:scheme', prefLabel: 'Distrust', broader: 'urn:uuid:b' });
    const read = readCodebook(text);
    expect({ scheme: read.scheme, label: read.label, codes: read.codes }).toEqual(book([b, a]));
    expect(writeCodebook(read)).toBe(text);
    expect(readCodebook('nonsense').codes).toEqual([]);
  });

  it('merges by code: both sides’ new codes kept, the later change winning, never conflicting', () => {
    const base = writeCodebook(book([{ id: 'urn:uuid:a', label: 'Trust', modified: '1' }]));
    const x = writeCodebook(book([{ id: 'urn:uuid:a', label: 'Trust in people', modified: '2' }, { id: 'urn:uuid:b', label: 'Fear' }]));
    const y = writeCodebook(book([{ id: 'urn:uuid:a', label: 'Trusting', modified: '3' }, { id: 'urn:uuid:c', label: 'Hope' }]));
    const merged = readCodebook(mergeCodebooks(base, x, y)!);
    expect(merged.codes.map((c) => [c.id, c.label])).toEqual([['urn:uuid:a', 'Trusting'], ['urn:uuid:b', 'Fear'], ['urn:uuid:c', 'Hope']]);
    expect(mergeCodebooks(base, x, y)).toBe(mergeCodebooks(base, y, x));
  });

  it('follows codes merged into others, and finds the codes under one', () => {
    const b = book([
      { id: 'top', label: 'Institutions' },
      { id: 'child', label: 'Council', broader: 'top' },
      { id: 'grandchild', label: 'Mayor', broader: 'child' },
      { id: 'old', label: 'Govt', replacedBy: 'child' },
      { id: 'gone', label: 'Unused', deleted: true },
    ]);
    expect(resolveCode(b, 'old')!.id).toBe('child');
    expect([...codeAndBelow(b, 'top')].sort()).toEqual(['child', 'grandchild', 'old', 'top']);
    expect(codeTree(b).map(({ code, depth }) => [code.label, depth])).toEqual([['Institutions', 0], ['Council', 1], ['Mayor', 2]]);
  });

  it('tells no codebook from text that is not one, which is never taken for empty', () => {
    expect(parseCodebook(null)).toMatchObject({ codes: [] });
    expect(parseCodebook('')).toMatchObject({ codes: [] });
    expect(parseCodebook('{"@graph": [')).toBeNull();
    expect(parseCodebook('{"items": []}')).toBeNull();
    const good = writeCodebook(book([{ id: 'urn:uuid:a', label: 'Trust' }]));
    expect(mergeCodebooks(good, '{ broken', good)).toBeNull();
    expect(mergeCodebooks('{ broken', good, good)).toBeNull();
  });

  it('keeps what else the file says, and takes only a plain colour', () => {
    const text = JSON.stringify({
      '@context': { skos: 'http://www.w3.org/2004/02/skos/core#', scopeNote: 'skos:scopeNote', mine: 'http://example.org/mine' },
      '@graph': [
        { id: 'urn:uuid:s', type: 'ConceptScheme', prefLabel: 'Ours' },
        { id: 'urn:uuid:a', type: 'Concept', inScheme: 'urn:uuid:s', prefLabel: 'Trust', scopeNote: 'Only of people', color: 'red;background:url(x)' },
        { id: 'urn:uuid:b', type: 'Concept', inScheme: 'urn:uuid:s', prefLabel: 'Fear', color: '#ABCDEF' },
        { id: 'urn:uuid:n', type: 'Note', mine: 'kept' },
      ],
    });
    const b = parseCodebook(text)!;
    const trust = b.codes.find((c) => c.id === 'urn:uuid:a')!;
    expect(trust.color).toBeUndefined();
    expect(trust.extra).toEqual({ scopeNote: 'Only of people', color: 'red;background:url(x)' });
    expect(b.codes.find((c) => c.id === 'urn:uuid:b')!.color).toBe('#abcdef');
    const again = JSON.parse(writeCodebook(b));
    expect(again['@context']).toMatchObject({ scopeNote: 'skos:scopeNote', mine: 'http://example.org/mine', prefLabel: 'skos:prefLabel' });
    expect(again['@graph']).toContainEqual({ id: 'urn:uuid:n', type: 'Note', mine: 'kept' });
    expect(again['@graph'].find((n: { id: string }) => n.id === 'urn:uuid:a')).toMatchObject({ scopeNote: 'Only of people', prefLabel: 'Trust' });
  });

  it('shows codes caught in a loop at the top, and counts a merged code only as what replaced it', () => {
    const loop = book([
      { id: 'x', label: 'X', broader: 'y' },
      { id: 'y', label: 'Y', broader: 'x' },
      { id: 'z', label: 'Z' },
    ]);
    const tree = codeTree(loop);
    expect(tree.map(({ code }) => code.id).sort()).toEqual(['x', 'y', 'z']);
    expect(tree.find(({ code }) => code.id === 'x')!.depth).toBe(0);
    const merged = book([
      { id: 'top', label: 'Institutions' },
      { id: 'other', label: 'Feelings' },
      { id: 'fear', label: 'Fear', broader: 'other' },
      { id: 'old', label: 'Govt', broader: 'top', replacedBy: 'fear' },
    ]);
    expect([...codeAndBelow(merged, 'top')]).toEqual(['top']);
    expect([...codeAndBelow(merged, 'other')].sort()).toEqual(['fear', 'old', 'other']);
    const twoWay = book([{ id: 'p', label: 'P', replacedBy: 'q' }, { id: 'q', label: 'Q', replacedBy: 'p' }]);
    expect(resolveCode(twoWay, 'p')).not.toBeNull();
    expect(codeTree(twoWay).length).toBeGreaterThan(0);
  });
});

describe('a coding', () => {
  it('is an annotation classifying a passage with a code', () => {
    const coding: Item = { id: 'urn:uuid:x', type: 'Annotation', motivation: 'classifying', created: 'a', modified: 'a', body: { type: 'SpecificResource', source: 'urn:uuid:code', purpose: 'classifying' }, target: '../p.md' };
    expect(kindOf(coding)).toBe('coding');
    expect(codeOf(coding)).toBe('urn:uuid:code');
    expect(describePages(null, writePage([coding], 'a'.repeat(64)))).toBe('1 coding added');
  });
});
