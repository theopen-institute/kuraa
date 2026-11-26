import { describe, expect, it } from 'vitest';
import { codeAndBelow, codeTree, mergeCodebooks, parseCodebook, randomColour, readCodebook, resolveCode, writeCodebook, type Code, type Codebook } from '../src/codebook.js';
import { findCodes } from '../src/codebox.js';
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

describe('a new code', () => {
  it('has a colour at random, plain #rrggbb, dark enough to read', () => {
    // Above all where it is brightest: yellow-green, at the top of the lightness and saturation drawn.
    for (const r of [[60 / 360, 1, 1], [90 / 360, 1, 1], [0.15, 0.99, 0.99]]) {
      const c = randomColour(((i) => () => r[i++ % 3]!)(0));
      const [cr, cg, cb] = [1, 3, 5].map((n) => parseInt(c.slice(n, n + 2), 16));
      expect(0.2126 * cr! + 0.7152 * cg! + 0.0722 * cb!).toBeLessThan(190);
    }
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) {
      const c = randomColour();
      expect(c).toMatch(/^#[0-9a-f]{6}$/);
      const [r, g, b] = [1, 3, 5].map((n) => parseInt(c.slice(n, n + 2), 16));
      expect(0.2126 * r! + 0.7152 * g! + 0.0722 * b!).toBeLessThan(190);
      seen.add(c);
    }
    expect(seen.size).toBeGreaterThan(1500);
    expect(randomColour(() => 0)).toBe(randomColour(() => 0));
  });
});

describe('the code box', () => {
  const s = (label: string) => ({ code: { id: label, label }, parents: [] });
  const all = [s('Trust in people'), s('Distrust'), s('Institutions'), s('Trust')];
  it('suggests the code named exactly first, then those starting so, then those with it in a word or anywhere', () => {
    expect(findCodes(all, 'trust').map((x) => x.code.label)).toEqual(['Trust', 'Trust in people', 'Distrust']);
    expect(findCodes(all, 'peop').map((x) => x.code.label)).toEqual(['Trust in people']);
    expect(findCodes(all, 'stit').map((x) => x.code.label)).toEqual(['Institutions']);
    expect(findCodes(all, 'zzz')).toEqual([]);
    expect(findCodes(all, '').length).toBe(4);
  });
});
