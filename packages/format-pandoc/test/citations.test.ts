// Citations: read from their markdown, written back as Pandoc citations, and
// never mistaken for text to escape (nor emails for citations).
import { describe, expect, it } from 'vitest';
import type { Node as PMNode } from 'prosemirror-model';
import { citeKey, pandocMarkdown as md, readCitation } from '../src/index.js';

const schema = md.schema;
const para = (...content: (PMNode | string)[]) =>
  schema.node('doc', null, [schema.node('paragraph', null, content.map((c) => (typeof c === 'string' ? schema.text(c) : c)))]);
const cite = (text: string) => schema.node('citation', { text });

/** The inline nodes of a one-paragraph document, as [type, text]. */
function inlines(src: string): [string, string][] {
  const out: [string, string][] = [];
  md.parse(src).doc.firstChild!.forEach((n) => out.push([n.type.name, n.isText ? n.text! : String(n.attrs.text ?? '')]));
  return out;
}

describe('citations', () => {
  it('serializes citation nodes as Pandoc citations', () => {
    expect(md.serialize(para('As ', cite('[@a; @b, p. 3]'), ' shows.'))).toBe('As [@a; @b, p. 3] shows.\n');
    expect(md.serialize(para(cite('@smith2020'), ' found it.'))).toBe('@smith2020 found it.\n');
    expect(md.serialize(para(cite('@smith2020 [p. 3]'), ' found it.'))).toBe('@smith2020 [p. 3] found it.\n');
    expect(md.serialize(para('Smith says so ', cite('[-@smith2020]'), '.'))).toBe('Smith says so [-@smith2020].\n');
  });

  it('round-trips each kind of citation', () => {
    for (const src of [
      'See [@a; @b, p. 3] here.\n',
      '@smith2020 found it.\n',
      'As @smith2020 [p. 3] found.\n',
      'Smith says so [-@smith2020].\n',
      'Many [see @doe:99, chap. 2; also @roe-2001] agree.\n',
      'Ein Beleg von @müller2019.\n',
    ]) {
      const parsed = md.parse(src);
      expect(md.serialize(parsed.doc)).toBe(src);
      expect(md.parse(md.serialize(parsed.doc)).doc.eq(parsed.doc)).toBe(true);
    }
  });

  it('reads an in-text citation with its locator as one citation', () => {
    expect(inlines('As @smith2020 [p. 3] found.\n')).toEqual([['text', 'As '], ['citation', '@smith2020 [p. 3]'], ['text', ' found.']]);
    expect(inlines('As @smith2020 found.\n')).toEqual([['text', 'As '], ['citation', '@smith2020'], ['text', ' found.']]);
  });

  it('escapes an @ typed as text, but leaves emails alone', () => {
    expect(md.serialize(para('Write to ada@example.org or @ada.'))).toBe('Write to ada@example.org or \\@ada.\n');
    expect(md.serialize(para('[@not a citation]'))).toBe('\\[\\@not a citation\\]\n');
    expect(inlines('Write to ada@example.org now.\n')).toEqual([['text', 'Write to ada@example.org now.']]);
    const typed = para('ü @über');
    expect(md.parse(md.serialize(typed)).doc.eq(typed)).toBe(true);
  });

  it('reads what a citation cites', () => {
    expect(readCitation('[see @a, p. 3; -@b]')).toEqual({ bracketed: true, items: [
      { key: 'a', suppressAuthor: false, prefix: 'see', suffix: ', p. 3' },
      { key: 'b', suppressAuthor: true, prefix: '', suffix: '' },
    ] });
    expect(readCitation('@smith2020 [p. 3]')).toEqual({ bracketed: false, items: [{ key: 'smith2020', suppressAuthor: false, prefix: '', suffix: 'p. 3' }] });
    expect(readCitation('@{odd key}')?.items[0]?.key).toBe('odd key');
    expect(readCitation('[sic]')).toBe(null);
    expect(citeKey('smith2020')).toBe('@smith2020');
    expect(citeKey('odd key')).toBe('@{odd key}');
  });
});
