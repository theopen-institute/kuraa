// A document's title: read from its header, and written into it.
import { describe, expect, it } from 'vitest';
import { pandocTitle as t, pandocMarkdown as md } from '../src/index.js';

describe('reading the title', () => {
  it('reads the header’s title field', () => {
    expect(t.read('---\ntitle: A study\nauthor: Ada\n---\n\nText.\n')).toBe('A study');
    expect(t.read('---\ntitle: "Quoted: yes"\n---\n')).toBe('Quoted: yes');
    expect(t.read('---\r\ntitle: Windows\r\n---\r\n')).toBe('Windows');
    expect(t.read('---\ntitle: >\n  Folded\n  over lines\n...\n')).toBe('Folded over lines');
    expect(t.read('---\ntitle: 1984\n---\n')).toBe('1984');
  });

  it('finds none without a header, a title, or valid YAML', () => {
    expect(t.read('# Heading\n')).toBe(null);
    expect(t.read('---\nauthor: Ada\n---\n')).toBe(null);
    expect(t.read('---\ntitle: [unclosed\n---\n')).toBe(null);
    expect(t.read('---\n---\n')).toBe(null);
    expect(t.read('Text\n\n---\ntitle: Not a header\n---\n')).toBe(null);
    expect(t.read('---\ntitle:\n  - a list\n---\n')).toBe(null);
  });
});

describe('writing the title', () => {
  it('changes the title, keeping the rest of the header and the text', () => {
    expect(t.write('---\n# The journal’s\ntitle: Old\nauthor: Ada\n---\n\nText.\n', 'New: better'))
      .toBe('---\n# The journal’s\ntitle: "New: better"\nauthor: Ada\n---\n\nText.\n');
  });

  it('puts a missing title first in the header', () => {
    expect(t.write('---\nauthor: Ada\n---\n\nText.\n', 'Fresh')).toBe('---\ntitle: Fresh\nauthor: Ada\n---\n\nText.\n');
    expect(t.write('---\n---\nText.\n', 'Fresh')).toBe('---\ntitle: Fresh\n---\nText.\n');
  });

  it('adds a header to a document without one', () => {
    expect(t.write('', 'Field notes')).toBe('---\ntitle: Field notes\n---\n');
    expect(t.write('# Heading\n', 'Field notes')).toBe('---\ntitle: Field notes\n---\n\n# Heading\n');
  });

  it('writes what the format reads back', () => {
    const text = t.write('Text.\n', 'Round trip');
    expect(md.serialize(md.parse(text).doc)).toBe(text);
    expect(t.read(text)).toBe('Round trip');
  });

  it('refuses an empty title, or a header it cannot edit', () => {
    expect(() => t.write('Text.\n', '  ')).toThrow();
    expect(() => t.write('---\ntitle: [unclosed\n---\n', 'X')).toThrow();
  });
});
