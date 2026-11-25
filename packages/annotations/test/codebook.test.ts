import { describe, expect, it } from 'vitest';
import { codeAndBelow, codeTree, mergeCodebooks, readCodebook, resolveCode, writeCodebook, type Code, type Codebook } from '../src/codebook.js';
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
    expect(readCodebook(text)).toEqual(book([b, a]));
    expect(readCodebook('nonsense').codes).toEqual([]);
  });

  it('merges by code: both sides’ new codes kept, the later change winning, never conflicting', () => {
    const base = writeCodebook(book([{ id: 'urn:uuid:a', label: 'Trust', modified: '1' }]));
    const x = writeCodebook(book([{ id: 'urn:uuid:a', label: 'Trust in people', modified: '2' }, { id: 'urn:uuid:b', label: 'Fear' }]));
    const y = writeCodebook(book([{ id: 'urn:uuid:a', label: 'Trusting', modified: '3' }, { id: 'urn:uuid:c', label: 'Hope' }]));
    const merged = readCodebook(mergeCodebooks(base, x, y));
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
});

describe('a coding', () => {
  it('is an annotation classifying a passage with a code', () => {
    const coding: Item = { id: 'urn:uuid:x', type: 'Annotation', motivation: 'classifying', created: 'a', modified: 'a', body: { type: 'SpecificResource', source: 'urn:uuid:code', purpose: 'classifying' }, target: '../p.md' };
    expect(kindOf(coding)).toBe('coding');
    expect(codeOf(coding)).toBe('urn:uuid:code');
    expect(describePages(null, writePage([coding], 'a'.repeat(64)))).toBe('1 coding added');
  });
});
