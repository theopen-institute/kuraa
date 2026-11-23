// Marks on what is not text (an image, maths, a citation, a note's mark, a line
// break, raw HTML) go through a room as they are: y-prosemirror keeps marks only
// on text, and kuraa's patch of it keeps the rest in an attribute of the node's
// element (patches/y-prosemirror@1.3.7.patch).
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Transform } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';
import { pandocMarkdown as md } from '../../format-pandoc/src/index.js';
import { combineStates, decodeDoc, encodeDoc, patchState } from '../src/server.js';

const through = (doc: PMNode) => decodeDoc(encodeDoc(doc), md.schema);

/** The position of the first inline node of a type. */
function find(doc: PMNode, name: string): number {
  let at = -1;
  doc.descendants((n, pos) => {
    if (at < 0 && n.type.name === name) at = pos;
    return at < 0;
  });
  if (at < 0) throw new Error(`no ${name}`);
  return at;
}

describe('marks on what is not text, through a room', () => {
  const cases = [
    'Mark *[inaudible]*.\n',
    'A *$x^2$* b.\n',
    'A **[@doe2020]** b.\n',
    'A *![alt](i.png)* b.\n',
    'A **foo[^1]** b.\n\n[^1]: n\n',
    'A *<span>x</span>* b.\n',
    'A *line  \nbreak* b.\n',
    'Term\n\n  : Def *[x]* one\n',
  ];
  for (const src of cases) {
    it(`keeps ${JSON.stringify(src)} as it is`, () => {
      const parsed = md.parse(src);
      const back = through(parsed.doc);
      expect(back.eq(parsed.doc)).toBe(true);
      expect(md.serialize(back, parsed)).toBe(src);
    });
  }

  it('takes a mark put on an image, or taken off, as an edit to the room, and another room joined to it sees it', () => {
    const parsed = md.parse('See ![a gull](gull.png) here.\n');
    const seed = encodeDoc(parsed.doc);
    const at = find(parsed.doc, 'image');
    const em = md.schema.marks.em!.create();
    const marked = new Transform(parsed.doc).addMark(at, at + 1, em).doc;
    const one = patchState(seed, marked);
    expect(decodeDoc(one, md.schema).eq(marked)).toBe(true);
    expect(md.serialize(decodeDoc(one, md.schema), parsed)).toBe('See *![a gull](gull.png)* here.\n');
    // Another room from the same seed, with an edit of its own, joined: both edits, the mark kept.
    const other = patchState(seed, new Transform(parsed.doc).insert(1, md.schema.text('Do ')).doc);
    const joined = decodeDoc(combineStates(one, other), md.schema);
    expect(md.serialize(joined, parsed)).toBe('Do See *![a gull](gull.png)* here.\n');
    // Taken off again.
    const plain = patchState(one, parsed.doc);
    expect(decodeDoc(plain, md.schema).eq(parsed.doc)).toBe(true);
  });

  it('reads rooms kept before marks were kept on such nodes (no attribute), and leaves out a mark it does not know', () => {
    const ydoc = new Y.Doc();
    const frag = ydoc.getXmlFragment('doc');
    const para = new Y.XmlElement('paragraph');
    const text = new Y.XmlText();
    text.insert(0, 'See ');
    const old = new Y.XmlElement('image');
    old.setAttribute('src', 'gull.png');
    old.setAttribute('alt', 'a gull');
    const unknown = new Y.XmlElement('image');
    unknown.setAttribute('src', 'tern.png');
    unknown.setAttribute('alt', 'a tern');
    unknown.setAttribute('pm-marks', [{ type: 'no-such-mark' }, { type: 'strong' }] as never);
    para.insert(0, [text, old, unknown]);
    frag.insert(0, [para]);
    const doc = decodeDoc(Y.encodeStateAsUpdate(ydoc), md.schema);
    const images: PMNode[] = [];
    doc.descendants((n) => {
      if (n.type.name === 'image') images.push(n);
    });
    expect(images.map((n) => n.marks.map((m) => m.type.name))).toEqual([[], ['strong']]);
  });
});
