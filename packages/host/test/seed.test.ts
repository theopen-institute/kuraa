// Rooms seeded from a file's blob: the same state on every device, so two
// devices' rooms combine without the text appearing twice.
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { pandocMarkdown } from '@kuraa/format-pandoc';
import { rmarkdown } from '@kuraa/format-rmarkdown';
import { combineStates, decodeDoc, patchState } from '@kuraa/session/server';
import { blobId, seedState } from '../src/host.js';

const NOTES = '---\ntitle: Field notes\n---\n\n# Day one\n\nThe tide was out.\n\n- quadrats\n- cores\n';

describe('seeding rooms', () => {
  it('names a room by the git blob of its text', () => {
    expect(blobId(NOTES)).toBe(execFileSync('git', ['hash-object', '--stdin'], { input: NOTES, encoding: 'utf8' }).trim());
  });

  it('gives the same state for the same text and type version, and another for another type', () => {
    expect(Buffer.from(seedState(pandocMarkdown, NOTES))).toEqual(Buffer.from(seedState(pandocMarkdown, NOTES)));
    expect(Buffer.from(seedState(rmarkdown, NOTES))).not.toEqual(Buffer.from(seedState(pandocMarkdown, NOTES)));
  });

  it('gives the same state from a text already parsed, and parses again a parse of another text', () => {
    const parsed = pandocMarkdown.parse(NOTES);
    expect(Buffer.from(seedState(pandocMarkdown, NOTES, parsed))).toEqual(Buffer.from(seedState(pandocMarkdown, NOTES)));
    const other = pandocMarkdown.parse(NOTES.replace('The tide was out.', 'Not this text.'));
    expect(Buffer.from(seedState(pandocMarkdown, NOTES, other))).toEqual(Buffer.from(seedState(pandocMarkdown, NOTES)));
  });

  it('lets two rooms seeded apart, each edited, combine with both edits and no duplicate text', () => {
    const edit = (find: string, replace: string) => {
      const doc = pandocMarkdown.parse(NOTES.replace(find, replace)).doc;
      return patchState(seedState(pandocMarkdown, NOTES), doc);
    };
    const a = edit('The tide was out.', 'The tide was far out.');
    const b = edit('- cores', '- cores at 25 m');
    const text = pandocMarkdown.serialize(decodeDoc(combineStates(a, b), pandocMarkdown.schema));
    expect(text).toBe(NOTES.replace('The tide was out.', 'The tide was far out.').replace('- cores', '- cores at 25 m'));
  });
});
