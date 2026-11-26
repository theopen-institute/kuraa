import { describe, expect, it } from 'vitest';
import { Schema } from 'prosemirror-model';
import { liveWords, targetOf } from '../src/count.js';

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    front_matter: { content: 'text*', group: 'block', code: true },
    paragraph: { content: 'inline*', group: 'block' },
    code_block: { content: 'text*', group: 'block', code: true },
    citation: { inline: true, group: 'inline', atom: true },
    text: { group: 'inline' },
  },
  marks: { em: {}, code: { code: true } },
});

describe('the open document’s words (0094)', () => {
  it('counts each paragraph’s prose: not the header, code, or atoms', () => {
    const { nodes, marks } = schema;
    const doc = nodes.doc.create(null, [
      nodes.front_matter.create(null, schema.text('title: Not counted at all')),
      nodes.paragraph.create(null, [schema.text('We came by '), schema.text('sea', [marks.em.create()]), schema.text(', then '), schema.text('x <- 1', [marks.code.create()]), schema.text(' rested'), nodes.citation.create(), schema.text('.')]),
      nodes.code_block.create(null, schema.text('library(not, counted)')),
      nodes.paragraph.create(null, schema.text('Two more.')),
    ]);
    // We came by sea then rested (6); Two more (2).
    expect(liveWords(doc)).toBe(8);
  });

  it('takes a target as a whole number above nought', () => {
    expect(targetOf(2000)).toBe(2000);
    expect(targetOf('80,000')).toBe(80000);
    expect(targetOf('  1500 ')).toBe(1500);
    expect(targetOf(0)).toBeNull();
    expect(targetOf('lots')).toBeNull();
    expect(targetOf(undefined)).toBeNull();
  });
});
