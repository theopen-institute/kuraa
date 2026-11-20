// The Markdown and shortcuts sheet lists what is bound: every key with a
// modifier that a Pandoc document binds is named in the editor's help, and
// the help names no key that is not bound.
import { describe, expect, it } from 'vitest';
import type { EditorContext } from '@kuraa/editor-kit';
import { pandocMarkdown as md } from '../src/index.js';
import { pandocEditor, pandocKeys } from '../src/editor/index.js';

const ctx: EditorContext = {
  schema: md.schema,
  readOnly: false,
  history: { undo: () => false, redo: () => false },
  isRemote: () => false,
  ui: { askText: async () => null, askConfirm: async () => false },
};

/** Keys someone has to be told about: with ⌘/Ctrl or ⌥/Alt, or a function key. */
const taught = (key: string) => /(^|-)(Mod|Alt|Ctrl)-|F\d+$/.test(key);

describe('the shortcuts sheet', () => {
  it('names every key with a modifier that a Pandoc document binds', () => {
    const helped = new Set((pandocEditor.help ?? []).flatMap((h) => h.keys ?? []));
    const bound = Object.keys(pandocKeys(md.schema, ctx)).filter(taught);
    expect(bound.length).toBeGreaterThan(10);
    expect(bound.filter((k) => !helped.has(k))).toEqual([]);
  });

  it('names no key that is not bound', () => {
    const bound = new Set(Object.keys(pandocKeys(md.schema, ctx)));
    const helped = (pandocEditor.help ?? []).flatMap((h) => h.keys ?? []);
    expect(helped.filter((k) => !bound.has(k))).toEqual([]);
  });

  it('says what each line does, and is either typed or pressed', () => {
    for (const h of pandocEditor.help ?? []) {
      expect(h.does).toBeTruthy();
      expect(!!h.type !== !!h.keys?.length).toBe(true);
    }
  });
});
