// Plain text and source files: R scripts, Python, YAML, BibTeX, LaTeX and so on.
//
// The general text format, as format-pandoc is the general markdown format:
// `createTextType` is the extension point, and the types below are built on it.
// Each line of the file is one `line` node, holding the line's text and, in its
// `eol` attribute, the terminator that ended it ('\n', '\r\n', '\r', or '' for
// the last line). So a round trip is exact for any input, an edit touches only
// the lines it changes, and collaborators' cursors and outside merges work line
// by line. Highlighting is the client's job: the type names a language.
import { Schema, type Node } from 'prosemirror-model';
import type { DocumentType, ParsedDocument } from '@kuraa/kernel';

export const textSchema = new Schema({
  nodes: {
    doc: { content: 'line+' },
    line: {
      content: 'text*',
      marks: '',
      code: true,
      whitespace: 'pre',
      attrs: { eol: { default: '' } },
      parseDOM: [{ tag: 'div.line', preserveWhitespace: 'full', getAttrs: (dom) => ({ eol: (dom as HTMLElement).dataset.eol ?? '' }) }],
      toDOM: () => ['div', { class: 'line' }, 0],
    },
    text: {},
  },
});

const EOL = /\r\n|\r|\n/g;

export function parseText(text: string, schema: Schema = textSchema): ParsedDocument {
  const line = (content: string, eol: string) => schema.nodes.line!.create({ eol }, content ? schema.text(content) : null);
  const lines: Node[] = [];
  const blocks: { from: number; to: number }[] = [];
  let start = 0;
  for (const m of text.matchAll(EOL)) {
    lines.push(line(text.slice(start, m.index), m[0]));
    blocks.push({ from: start, to: m.index + m[0].length });
    start = m.index + m[0].length;
  }
  lines.push(line(text.slice(start), ''));
  blocks.push({ from: start, to: text.length });
  return { text, doc: schema.nodes.doc!.create(null, lines), blocks };
}

/** The terminator most lines use; '\n' if none do. New lines get it. */
export function dominantEol(doc: Node): string {
  const counts = new Map<string, number>();
  doc.forEach((line, _, i) => {
    const eol = String(line.attrs.eol ?? '');
    if (eol && i < doc.childCount - 1) counts.set(eol, (counts.get(eol) ?? 0) + 1);
  });
  let best = '\n';
  let most = 0;
  for (const [eol, n] of counts) if (n > most) [best, most] = [eol, n];
  return best;
}

/**
 * Every line but the last is followed by its terminator (the document's usual
 * one if it has none, as after a split); the last line by nothing. `previous`
 * is not needed: lines are written from their own text and terminator, so
 * untouched lines come out byte for byte.
 */
export function serializeText(doc: Node): string {
  const fallback = dominantEol(doc);
  let out = '';
  doc.forEach((line, _, i) => {
    out += line.textContent;
    if (i < doc.childCount - 1) out += String(line.attrs.eol || fallback);
  });
  return out;
}

export interface TextTypeOptions {
  /** Part of the room key, so stable: 'text', 'text-r'. */
  id: string;
  label: string;
  /** File extensions, with the dot, the usual one first: ['.R']. Matched case-insensitively. */
  extensions?: string[];
  /** Whole file names, matched exactly: ['Dockerfile', '.Rprofile']. */
  names?: string[];
  /** Matched against the first line of files with no extension, e.g. /^#!.*\bRscript\b/. */
  shebang?: RegExp;
  /** For the client's highlighter: 'r', 'python', 'yaml', … */
  language?: string;
  priority?: number;
  /** Bump with any schema change. */
  version?: number;
}

export function createTextType(opts: TextTypeOptions): DocumentType {
  const extensions = (opts.extensions ?? []).map((e) => e.toLowerCase());
  const names = new Set(opts.names ?? []);
  return {
    id: opts.id,
    version: opts.version ?? 1,
    label: opts.label,
    priority: opts.priority ?? 0,
    extensions: opts.extensions ?? [],
    match(path, head) {
      const name = path.slice(path.lastIndexOf('/') + 1);
      if (names.has(name)) return true;
      const lower = name.toLowerCase();
      if (extensions.some((e) => lower.endsWith(e) && lower.length > e.length)) return true;
      if (!opts.shebang || name.includes('.') || !head.startsWith('#!') || head.includes('\0')) return false;
      return opts.shebang.test(head.slice(0, head.search(/\r|\n|$/)));
    },
    schema: textSchema,
    parse: (text) => parseText(text),
    serialize: (doc) => serializeText(doc),
    editor: { layout: { kind: 'lines', line: 'line', eolAttr: 'eol', language: opts.language } },
  };
}

// The general type, below any more specific one.
export const plainText = createTextType({
  id: 'text',
  label: 'Plain text',
  extensions: ['.txt', '.text', '.log', '.csv', '.tsv', '.mk'],
  names: ['LICENSE', 'LICENCE', 'COPYING', 'AUTHORS', 'NOTICE', 'CITATION', 'Makefile', 'makefile', 'GNUmakefile',
    '.gitignore', '.gitattributes', '.gitmodules', '.Rbuildignore', '.dockerignore', '.nojekyll'],
  priority: -10,
});

export const rScript = createTextType({
  id: 'text-r', label: 'R script', language: 'r',
  extensions: ['.R'], names: ['.Rprofile', 'NAMESPACE'], shebang: /\bRscript\b/,
});
export const python = createTextType({
  id: 'text-python', label: 'Python', language: 'python',
  extensions: ['.py', '.pyw'], shebang: /\bpython[\d.]*\b/,
});
export const julia = createTextType({ id: 'text-julia', label: 'Julia', language: 'julia', extensions: ['.jl'], shebang: /\bjulia\b/ });
export const shell = createTextType({
  id: 'text-shell', label: 'Shell script', language: 'shell',
  extensions: ['.sh', '.bash', '.zsh'], names: ['.bashrc', '.bash_profile', '.zshrc', '.profile'], shebang: /\b(ba|z|da|k)?sh\b/,
});
export const yaml = createTextType({ id: 'text-yaml', label: 'YAML', language: 'yaml', extensions: ['.yml', '.yaml', '.cff'] });
export const json = createTextType({ id: 'text-json', label: 'JSON', language: 'json', extensions: ['.json', '.jsonc', '.geojson', '.code-workspace'] });
export const toml = createTextType({ id: 'text-toml', label: 'TOML', language: 'toml', extensions: ['.toml'] });
export const ini = createTextType({
  id: 'text-ini', label: 'Settings file', language: 'properties',
  extensions: ['.ini', '.cfg', '.conf', '.properties', '.env'], names: ['.Renviron', '.editorconfig', '.npmrc', 'DESCRIPTION'],
});
export const latex = createTextType({ id: 'text-latex', label: 'LaTeX', language: 'latex', extensions: ['.tex', '.sty', '.cls', '.ltx', '.bbx', '.cbx'] });
export const bibtex = createTextType({ id: 'text-bibtex', label: 'BibTeX', language: 'bibtex', extensions: ['.bib'] });
export const xml = createTextType({ id: 'text-xml', label: 'XML', language: 'xml', extensions: ['.xml', '.csl', '.svg', '.xsl', '.opf'] });
export const html = createTextType({ id: 'text-html', label: 'HTML', language: 'html', extensions: ['.html', '.htm'] });
export const css = createTextType({ id: 'text-css', label: 'CSS', language: 'css', extensions: ['.css'] });
export const scss = createTextType({ id: 'text-scss', label: 'SCSS', language: 'scss', extensions: ['.scss'] });
export const javascript = createTextType({
  id: 'text-javascript', label: 'JavaScript', language: 'javascript',
  extensions: ['.js', '.mjs', '.cjs', '.jsx'], shebang: /\bnode\b/,
});
export const typescript = createTextType({ id: 'text-typescript', label: 'TypeScript', language: 'typescript', extensions: ['.ts', '.mts', '.cts', '.tsx'] });
export const lua = createTextType({ id: 'text-lua', label: 'Lua', language: 'lua', extensions: ['.lua'], shebang: /\blua\b/ });
export const sql = createTextType({ id: 'text-sql', label: 'SQL', language: 'sql', extensions: ['.sql'] });
export const stan = createTextType({ id: 'text-stan', label: 'Stan', language: 'stan', extensions: ['.stan'] });
export const diff = createTextType({ id: 'text-diff', label: 'Diff', language: 'diff', extensions: ['.diff', '.patch'] });
export const dockerfile = createTextType({ id: 'text-dockerfile', label: 'Dockerfile', language: 'dockerfile', names: ['Dockerfile', 'Containerfile'], extensions: ['.dockerfile'] });

/** Every text type this package defines. */
export const textTypes: DocumentType[] = [
  plainText, rScript, python, julia, shell, yaml, json, toml, ini, latex, bibtex,
  xml, html, css, scss, javascript, typescript, lua, sql, stan, diff, dockerfile,
];
