// The Header dialog's model: fields read from the YAML header, and changes
// written back without disturbing the rest of it.
import { describe, expect, it } from 'vitest';
import { EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { pandocMarkdown as md } from '@kuraa/format-pandoc';
import { pandocEditor } from '@kuraa/format-pandoc/editor';
import { entryFor, headerText, mergeHeader, readEntries, writeHeader, type Entry } from '../src/header.js';

const spec = pandocEditor.header!;
const field = (key: string) => spec.fields.find((f) => f.key === key);
const entries = (text: string) => {
  const r = readEntries(text, spec);
  if ('error' in r) throw new Error(r.error);
  return r.entries;
};
const find = (list: Entry[], key: string) => list.find((e) => e.key === key)!;

describe('reading the header', () => {
  it('gives each field in order, edited as the format says', () => {
    const list = entries('title: A study\nauthor:\n  - Ada\n  - Grace\ntoc: true\ntoc-depth: 2\nabstract: |\n  One.\n  Two.\n');
    expect(list.map((e) => [e.key, e.kind])).toEqual([['title', 'text'], ['author', 'list'], ['toc', 'boolean'], ['toc-depth', 'number'], ['abstract', 'paragraph']]);
    expect(find(list, 'author').value).toEqual(['Ada', 'Grace']);
    expect(find(list, 'abstract').value).toBe('One.\nTwo.\n');
  });

  it('edits a value that does not fit the field as YAML', () => {
    const list = entries('author:\n  - name: Ada\n    affiliation: Analytical\n');
    expect(find(list, 'author').kind).toBe('yaml');
    expect(find(list, 'author').value).toBe('- name: Ada\n  affiliation: Analytical');
  });

  it('works out how to edit fields of the document’s own', () => {
    const list = entries('draft: true\nversion: 3\ntags: [a, b]\nextra: {x: 1}\nnote: hello\n');
    expect(list.map((e) => e.kind)).toEqual(['boolean', 'number', 'list', 'yaml', 'text']);
    expect(list.every((e) => !e.field)).toBe(true);
  });

  it('cannot show YAML that does not parse, or is not fields, as fields', () => {
    expect(readEntries('title: [unclosed', spec)).toHaveProperty('error');
    expect(readEntries('- a\n- b', spec)).toHaveProperty('error');
    expect(readEntries(null, spec)).toEqual({ entries: [] });
  });
});

describe('writing the header back', () => {
  it('changes only what was changed, keeping comments and order', () => {
    const text = '# Set by the journal\ntitle: Old\ndate: "`r Sys.Date()`"\nauthor: Ada';
    const list = entries(text);
    find(list, 'title').value = 'New: improved';
    expect(mergeHeader(text, list, [])).toBe('# Set by the journal\ntitle: "New: improved"\ndate: "`r Sys.Date()`"\nauthor: Ada');
  });

  it('leaves the text alone when nothing changed', () => {
    const text = 'title:   Spaced   # a comment';
    expect(mergeHeader(text, entries(text), [])).toBe(text);
  });

  it('applies the changes to the header as it is now, keeping someone else’s', () => {
    const opened = 'title: A\nauthor: Ada';
    const list = entries(opened);
    find(list, 'title').value = 'B';
    expect(mergeHeader('title: A\nauthor: Grace\nlang: fr', list, [])).toBe('title: B\nauthor: Grace\nlang: fr');
  });

  it('adds fields at the end, and leaves out empty ones', () => {
    const list = entries('title: A');
    list.push(entryFor('bibliography', undefined, field('bibliography')));
    list.push(entryFor('subtitle', undefined, field('subtitle')));
    list.push(entryFor('link-citations', undefined, field('link-citations')));
    (list[1]!.value as string[])[0] = 'refs.bib';
    expect(mergeHeader('title: A', list, [])).toBe('title: A\nbibliography:\n  - refs.bib\nlink-citations: true');
  });

  it('keeps a single author as a line of text', () => {
    const list = entries('author: Ada');
    expect(find(list, 'author').value).toEqual(['Ada']);
    find(list, 'author').value = ['Grace'];
    expect(mergeHeader('author: Ada', list, [])).toBe('author: Grace');
    find(list, 'author').value = ['Grace', 'Ada'];
    expect(mergeHeader('author: Ada', list, [])).toBe('author:\n  - Grace\n  - Ada');
  });

  it('removes fields, and the whole header when none is left', () => {
    expect(mergeHeader('title: A\ntoc: true', entries('title: A\ntoc: true').slice(0, 1), ['toc'])).toBe('title: A');
    expect(mergeHeader('title: A', [], ['title'])).toBe(null);
    const cleared = entries('title: A');
    cleared[0]!.value = '';
    expect(mergeHeader('title: A', cleared, [])).toBe(null);
  });

  it('writes a value edited as YAML, and refuses one that does not parse', () => {
    const list = [entryFor('params', undefined, { key: 'params', label: 'Parameters', group: 'R Markdown', kind: 'yaml' })];
    list[0]!.value = 'n: 10\nregion: west';
    expect(mergeHeader(null, list, [])).toBe('params:\n  n: 10\n  region: west');
    list[0]!.value = 'n: [';
    expect(() => mergeHeader(null, list, [])).toThrow();
  });

  it('starts a header for a document that has none', () => {
    const list = [entryFor('title', undefined, field('title'))];
    list[0]!.value = 'Fresh';
    expect(mergeHeader(null, list, [])).toBe('title: Fresh');
  });
});

describe('the header in the document', () => {
  function viewOf(src: string) {
    let state = EditorState.create({ doc: md.parse(src).doc });
    const view = {
      get state() { return state; },
      dispatch(tr: Parameters<EditorState['apply']>[0]) { state = state.apply(tr); },
    } as unknown as EditorView;
    return { view, text: () => md.serialize(state.doc) };
  }

  it('reads the header block', () => {
    expect(headerText(md.parse('---\ntitle: A\n---\n\nText.\n').doc, spec)).toBe('title: A');
    expect(headerText(md.parse('Text.\n').doc, spec)).toBe(null);
  });

  it('adds, replaces and removes it', () => {
    const { view, text } = viewOf('Text.\n');
    writeHeader(view, spec, 'title: A');
    expect(text()).toBe('---\ntitle: A\n---\n\nText.\n');
    writeHeader(view, spec, 'title: B\nlang: fr');
    expect(text()).toBe('---\ntitle: B\nlang: fr\n---\n\nText.\n');
    writeHeader(view, spec, null);
    expect(text()).toBe('Text.\n');
  });

  it('leaves an empty paragraph when a document that was only a header loses it', () => {
    const { view } = viewOf('---\ntitle: A\n---\n');
    writeHeader(view, spec, null);
    expect(view.state.doc.childCount).toBe(1);
    expect(view.state.doc.firstChild!.type.name).toBe('paragraph');
  });
});
