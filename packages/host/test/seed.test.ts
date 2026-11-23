// Why two sessions of one file never combine (0077): each starts its own Yjs
// history of the text, and two histories of one text, combined, hold it twice.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { combineStates, decodeDoc, encodeDoc, patchState } from '@kuraa/session/server';
import { blobId } from '../src/host.js';

const NOTES = '---\ntitle: Field notes\n---\n\n# Day one\n\nThe tide was out.\n\n- quadrats\n- cores\n';

describe('sessions', () => {
  it('know a file changed on the disk by its git blob', () => {
    expect(blobId(NOTES)).toBe(execFileSync('git', ['hash-object', '--stdin'], { input: NOTES, encoding: 'utf8' }).trim());
  });

  it('start each with a history of its own, even from the same text', () => {
    const doc = pandocMarkdown.parse(NOTES).doc;
    expect(Buffer.from(encodeDoc(doc))).not.toEqual(Buffer.from(encodeDoc(doc)));
  });

  it('would hold the text twice if two started apart were combined: so they meet in git instead', () => {
    const edit = (find: string, replace: string) => patchState(encodeDoc(pandocMarkdown.parse(NOTES).doc), pandocMarkdown.parse(NOTES.replace(find, replace)).doc);
    const text = pandocMarkdown.serialize(decodeDoc(combineStates(edit('The tide was out.', 'The tide was far out.'), edit('- cores', '- cores at 25 m')), pandocMarkdown.schema));
    expect(text.match(/Day one/g)!.length).toBeGreaterThan(1);
  });

  it('combine with any copy of themselves, whatever each copy was given since', () => {
    const start = encodeDoc(pandocMarkdown.parse(NOTES).doc);
    const a = patchState(start, pandocMarkdown.parse(NOTES.replace('The tide was out.', 'The tide was far out.')).doc);
    const b = patchState(start, pandocMarkdown.parse(NOTES.replace('- cores', '- cores at 25 m')).doc);
    const text = pandocMarkdown.serialize(decodeDoc(combineStates(a, b), pandocMarkdown.schema));
    expect(text).toBe(NOTES.replace('The tide was out.', 'The tide was far out.').replace('- cores', '- cores at 25 m'));
  });
});
