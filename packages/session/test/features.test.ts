import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { prosemirrorToYXmlFragment, updateYFragment, yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import type { Node as PMNode } from 'prosemirror-model';
import { Transform } from 'prosemirror-transform';
import { pandocMarkdown } from '../../format-pandoc/src/index.js';
import { anchorIn, entriesIn, peopleIn, positionIn, seedIn, updateIn, whatChanged } from '../src/features.js';
import { FRAGMENT } from '../src/model.js';
import { encodeDoc, featuresOfState } from '../src/server.js';

const schema = pandocMarkdown.schema;
const MD = '# Title\n\nSome **bold** text and `code` here.\n\n- one\n- two with *more*\n\n> quoted line\n';

function roomOf(md: string): Y.Doc {
  const ydoc = new Y.Doc();
  prosemirrorToYXmlFragment(pandocMarkdown.parse(md).doc, ydoc.getXmlFragment(FRAGMENT));
  return ydoc;
}
const docOf = (ydoc: Y.Doc): PMNode => yXmlFragmentToProseMirrorRootNode(ydoc.getXmlFragment(FRAGMENT), schema);
/** Every position in a document where text is (each character's start). */
function textPositions(doc: PMNode): number[] {
  const out: number[] = [];
  doc.descendants((n, pos) => {
    if (n.isText) for (let i = 0; i <= n.text!.length; i++) out.push(pos + i);
  });
  return out;
}
function edit(ydoc: Y.Doc, change: (doc: PMNode) => PMNode) {
  const next = change(docOf(ydoc));
  ydoc.transact(() => updateYFragment(ydoc, ydoc.getXmlFragment(FRAGMENT), next, { mapping: new Map(), isOMark: new Map() }));
}
const where = (doc: PMNode, phrase: string) => {
  let at = -1;
  doc.descendants((n, pos) => {
    if (at < 0 && n.isText && n.text!.includes(phrase)) at = pos + n.text!.indexOf(phrase);
    return at < 0;
  });
  return at;
};

describe('anchors in a room', () => {
  it('read back as the positions they were made at, everywhere in the text', () => {
    const ydoc = roomOf(MD);
    const doc = docOf(ydoc);
    for (const pos of textPositions(doc)) {
      expect(positionIn(ydoc, schema, anchorIn(ydoc, schema, pos))).toBe(pos);
      expect(positionIn(ydoc, schema, anchorIn(ydoc, schema, pos, -1))).toBe(pos);
    }
  });

  it('move with edits before them, and keep to their side when text is typed at them', () => {
    const ydoc = roomOf(MD);
    const doc = docOf(ydoc);
    const from = where(doc, 'text and');
    const to = from + 'text and'.length;
    const start = anchorIn(ydoc, schema, from, 1);
    const end = anchorIn(ydoc, schema, to, -1);
    // Typed before the passage (in the heading), and right at both of its ends, one edit at a time as typing is.
    edit(ydoc, (d) => new Transform(d).insert(2, schema.text('Big ')).doc);
    edit(ydoc, (d) => {
      const f = where(d, 'text and');
      return new Transform(d).insert(f + 'text and'.length, schema.text('END')).doc;
    });
    edit(ydoc, (d) => new Transform(d).insert(where(d, 'text and'), schema.text('START')).doc);
    expect(docOf(ydoc).textContent).toContain('STARTtext andEND');
    const now = docOf(ydoc);
    const a = positionIn(ydoc, schema, start)!;
    const b = positionIn(ydoc, schema, end)!;
    expect(now.textBetween(a, b)).toBe('text and');
  });

  it('are gone with what they were at, and found again in another copy of the room', () => {
    const ydoc = roomOf(MD);
    const doc = docOf(ydoc);
    const at = where(doc, 'quoted');
    const anchor = anchorIn(ydoc, schema, at);
    // Another device's copy of the room, kept in step.
    const other = new Y.Doc();
    Y.applyUpdate(other, Y.encodeStateAsUpdate(ydoc));
    expect(positionIn(other, schema, anchor)).toBe(at);
    // The quote taken away: the anchor no longer reads as a place in it.
    edit(ydoc, (d) => d.copy(d.content.cut(0, d.content.size - d.lastChild!.nodeSize)));
    const p = positionIn(ydoc, schema, anchor);
    expect(p === null || !docOf(ydoc).textContent.includes('quoted')).toBe(true);
  });
});

const ANA = 'a'.repeat(64);
const BO = 'b'.repeat(64);

describe('features’ state in a room, a map per person', () => {
  it('is seeded with anchors for one person, changed, and read from a saved state', () => {
    const parsed = pandocMarkdown.parse(MD);
    const at = where(parsed.doc, 'bold');
    const state = encodeDoc(parsed.doc, { person: ANA, seed: ({ anchorAt }) => ({ marks: { m1: { from: anchorAt(at), to: anchorAt(at + 4, -1), note: 'x' } } }) });
    const view = featuresOfState(state, schema);
    const m1 = view.entries('marks', ANA).m1 as { from: unknown; to: unknown };
    expect(view.positionOf(m1.from as never)).toBe(at);
    expect(view.positionOf(m1.to as never)).toBe(at + 4);
    expect(view.entries('marks', BO)).toEqual({});
    expect(view.seeded('marks', ANA)).toBe(true);
    expect(view.seeded('marks', BO)).toBe(false);
    expect(view.people('marks')).toEqual([ANA]);

    const ydoc = new Y.Doc();
    Y.applyUpdate(ydoc, state);
    updateIn(ydoc, 'marks', ANA, { set: { m2: 'two' }, remove: ['m1'] });
    updateIn(ydoc, 'marks', BO, { set: { b1: 'bo' } });
    expect(entriesIn(ydoc, 'marks', ANA)).toEqual({ m2: 'two' });
    expect(peopleIn(ydoc, 'marks')).toEqual([ANA, BO]);
    seedIn(ydoc, schema, BO, () => ({ other: { a: 1 } }));
    expect(entriesIn(ydoc, 'other', BO)).toEqual({ a: 1 });
  });
});

describe('what a change to a room changes', () => {
  const room = () => roomOf(MD);
  const changeOf = (ydoc: Y.Doc, fn: (copy: Y.Doc) => void) => {
    const copy = new Y.Doc();
    Y.applyUpdate(copy, Y.encodeStateAsUpdate(ydoc));
    const before = Y.encodeStateVector(copy);
    fn(copy);
    return Y.encodeStateAsUpdate(copy, before);
  };

  it('tells the document from each person’s maps, and anything else', () => {
    const ydoc = room();
    updateIn(ydoc, 'marks', ANA, { set: { m1: 1 } });
    // Bo's own map: his alone.
    let w = whatChanged(ydoc, changeOf(ydoc, (c) => updateIn(c, 'marks', BO, { set: { b: 1 } })));
    expect(w).toEqual({ doc: false, people: new Set([BO]), other: false });
    // Ana's entry taken away by someone: Ana's map.
    w = whatChanged(ydoc, changeOf(ydoc, (c) => updateIn(c, 'marks', ANA, { remove: ['m1'] })));
    expect([...w.people]).toEqual([ANA]);
    // Typing: the document.
    w = whatChanged(ydoc, changeOf(ydoc, (c) => edit(c, (d) => new Transform(d).insert(2, schema.text('x')).doc)));
    expect(w).toEqual({ doc: true, people: new Set(), other: false });
    // Seeding a person's maps: theirs.
    w = whatChanged(ydoc, changeOf(ydoc, (c) => seedIn(c, schema, BO, () => ({ marks: { s: 1 } }))));
    expect(w).toEqual({ doc: false, people: new Set([BO]), other: false });
    // Another kind of state: something else.
    w = whatChanged(ydoc, changeOf(ydoc, (c) => c.getMap('elsewhere').set('x', 1)));
    expect(w.other).toBe(true);
    // A change the room cannot place yet: anything.
    const elsewhere = new Y.Doc();
    elsewhere.getMap('feature:marks:' + BO).set('x', 1);
    const first = Y.encodeStateAsUpdate(elsewhere);
    const sv = Y.encodeStateVector(elsewhere);
    elsewhere.getMap('feature:marks:' + BO).set('y', 2);
    expect(whatChanged(ydoc, Y.encodeStateAsUpdate(elsewhere, sv)).other).toBe(true);
    void first;
  });
});
