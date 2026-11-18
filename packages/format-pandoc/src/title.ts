// A Pandoc document's title: the `title` field of its YAML header. Read from
// the file's text without parsing the whole document (the host lists titles
// for every file), and written by changing that one field.
import { isMap, parseDocument, Document } from 'yaml';
import type { DocumentTitle } from '@kuraa/kernel';

/** The header at the very top: `---`, YAML, then `---` (or `...`) on a line of its own. */
const HEADER = /^(\uFEFF?)---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?=\r?\n|$)/;
const YAML_OPTIONS = { lineWidth: 0 } as const;

export const pandocTitle: DocumentTitle = {
  read(text) {
    const m = HEADER.exec(text);
    if (!m?.[2]) return null;
    try {
      const doc = parseDocument(m[2]);
      if (doc.errors.length || !isMap(doc.contents)) return null;
      const title = doc.get('title');
      if (typeof title !== 'string' && typeof title !== 'number') return null;
      const shown = String(title).replace(/\s+/g, ' ').trim();
      return shown || null;
    } catch {
      return null;
    }
  },

  write(text, title) {
    title = title.replace(/\s+/g, ' ').trim();
    if (!title) throw new Error('A document needs a title');
    const m = HEADER.exec(text);
    if (!m) {
      const header = new Document({ title }).toString(YAML_OPTIONS);
      return `---\n${header}---\n${text ? `\n${text.replace(/^\n+/, '')}` : ''}`;
    }
    const doc = parseDocument(m[2] ?? '');
    if (doc.errors.length) throw new Error('The header is not valid YAML, so the title cannot be set');
    if (doc.contents === null) doc.contents = doc.createNode({}) as never;
    const map = doc.contents;
    if (!isMap(map)) throw new Error('The header is not a list of fields, so the title cannot be set');
    // A new title goes first, where people look for it.
    if (doc.has('title')) doc.set('title', title);
    else map.items.unshift(doc.createPair('title', title) as (typeof map.items)[number]);
    const yaml = doc.toString(YAML_OPTIONS).replace(/\n$/, '');
    return `${m[1]}---\n${yaml}\n---${text.slice(m[0].length)}`;
  },
};
