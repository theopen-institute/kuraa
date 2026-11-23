// A room replaced under a client (another device's room taken in its place):
// edits the host had not yet acknowledged are carried into the new room, once.
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { Transform } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';
import { pandocMarkdown as md } from '../../format-pandoc/src/index.js';
import { carryOver } from '../../client/src/carry.js';
import { applyDocument, trackAcknowledged } from '../src/acked.js';
import { decodeDoc, encodeSeed, patchState } from '../src/server.js';

const NOTES = '# Day one\n\nThe tide was out.\n\nWe counted crabs.\n\n# Day two\n\nIt rained.\n';
const SIDES: [{ by: string }, { by: string }] = [{ by: 'Bo' }, { by: 'Another device' }];

function insertAt(doc: PMNode, anchor: string, text: string): PMNode {
  let pos = -1;
  doc.descendants((n, p) => {
    if (pos < 0 && n.isTextblock && n.textContent.includes(anchor)) pos = p + 1 + n.textContent.indexOf(anchor);
    return pos < 0;
  });
  return new Transform(doc).insert(pos, md.schema.text(text)).doc;
}

const read = (ydoc: Y.Doc) => decodeDoc(Y.encodeStateAsUpdate(ydoc), md.schema);

describe('edits the host had not acknowledged when their room was replaced', () => {
  it('are known from the room as the host last had all of them, and carried into the new room once', () => {
    // Bo's client, in the old room: one edit the host has, one it has not.
    const old = new Y.Doc();
    Y.applyUpdate(old, encodeSeed(md.parse(NOTES).doc, 1));
    let unsynced = 0;
    const acked = trackAcknowledged(old, () => unsynced);
    expect(acked.unsent(md.schema)).toBeNull();
    applyDocument(old, insertAt(read(old), 'The tide', 'Bo1: '));
    unsynced = 1;
    unsynced = 0; // the host has it
    applyDocument(old, insertAt(read(old), 'We counted', 'Bo2: '));
    unsynced = 1; // on its way when the room was replaced
    const carry = acked.unsent(md.schema)!;
    expect(md.serialize(carry.base)).toContain('Bo1: The tide');
    expect(md.serialize(carry.base)).not.toContain('Bo2');
    expect(md.serialize(carry.ours)).toContain('Bo2: We counted');

    // The new room: another device's, from another seed, which the host merged Bo1 into, with an edit of its own.
    const next = new Y.Doc();
    const theirs = NOTES.replace('The tide', 'Bo1: The tide').replace('It rained', 'Ada: It rained');
    Y.applyUpdate(next, patchState(encodeSeed(md.parse(NOTES.replace('It rained', 'Ada: It rained')).doc, 2), md.parse(theirs).doc));
    const doc = carryOver(md, carry.base, carry.ours, read(next), SIDES);
    expect(doc).not.toBeNull();
    applyDocument(next, doc!);
    expect(md.serialize(read(next))).toBe(NOTES.replace('The tide', 'Bo1: The tide').replace('We counted', 'Bo2: We counted').replace('It rained', 'Ada: It rained'));
    acked.stop();
  });

  it('carry nothing when the new room holds them all', () => {
    const base = md.parse(NOTES).doc;
    const ours = insertAt(base, 'The tide', 'Bo: ');
    expect(carryOver(md, base, ours, insertAt(insertAt(base, 'The tide', 'Bo: '), 'It rained', 'Ada: '), SIDES)).toBeNull();
    expect(carryOver(md, base, base, insertAt(base, 'It rained', 'Ada: '), SIDES)).toBeNull();
  });
});
