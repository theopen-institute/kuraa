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

/**
 * Which files a text type claims, and how to colour them. Rules are tried in
 * order; the first that claims a file gives its language.
 */
export interface FileRule {
  /** File extensions, with the dot: ['.R']. Matched case-insensitively. */
  extensions?: string[];
  /** Whole file names, matched exactly: ['Dockerfile', '.Rprofile']. */
  names?: string[];
  /** Matched against the first line of files with no extension, e.g. /\bRscript\b/. */
  shebang?: RegExp;
  /** For the client's highlighter: 'r', 'python', 'yaml', …; none for plain text. */
  language?: string;
}

export interface TextTypeOptions {
  /** Part of the room key, so stable. */
  id: string;
  label: string;
  description?: string;
  files: FileRule[];
  /** Extensions offered for new files, the usual one first. */
  newFileExtensions?: string[];
  priority?: number;
  /** Bump with any schema change. */
  version?: number;
}

function ruleFor(rules: FileRule[], path: string, head: string): FileRule | undefined {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const lower = name.toLowerCase();
  const firstLine = !name.includes('.') && head.startsWith('#!') && !head.includes('\0') ? head.slice(0, head.search(/\r|\n|$/)) : '';
  return rules.find((r) =>
    r.names?.includes(name) ||
    r.extensions?.some((e) => lower.endsWith(e.toLowerCase()) && lower.length > e.length) ||
    (firstLine && r.shebang?.test(firstLine)));
}

export function createTextType(opts: TextTypeOptions): DocumentType {
  return {
    id: opts.id,
    version: opts.version ?? 1,
    label: opts.label,
    ...(opts.description ? { description: opts.description } : {}),
    priority: opts.priority ?? 0,
    extensions: opts.newFileExtensions ?? [],
    match: (path, head) => ruleFor(opts.files, path, head) !== undefined,
    schema: textSchema,
    parse: (text) => parseText(text),
    serialize: (doc) => serializeText(doc),
    editor: {
      layout: {
        kind: 'lines', line: 'line', eolAttr: 'eol',
        languageOf: (path, head) => ruleFor(opts.files, path, head)?.language,
      },
    },
  };
}

/** The files the text type opens, and the language each is highlighted as. */
export const textFiles: FileRule[] = [
  { language: 'r', extensions: ['.R'], names: ['.Rprofile', 'NAMESPACE'], shebang: /\bRscript\b/ },
  { language: 'python', extensions: ['.py', '.pyw'], shebang: /\bpython[\d.]*\b/ },
  { language: 'julia', extensions: ['.jl'], shebang: /\bjulia\b/ },
  { language: 'shell', extensions: ['.sh', '.bash', '.zsh'], names: ['.bashrc', '.bash_profile', '.zshrc', '.profile'], shebang: /\b(ba|z|da|k)?sh\b/ },
  { language: 'yaml', extensions: ['.yml', '.yaml', '.cff'] },
  // Markdown documents have their own types, which win; these apply when they are turned off.
  { language: 'markdown', extensions: ['.md', '.markdown', '.Rmd', '.qmd'] },
  { language: 'json', extensions: ['.json', '.jsonc', '.geojson', '.code-workspace'] },
  { language: 'toml', extensions: ['.toml'] },
  { language: 'properties', extensions: ['.ini', '.cfg', '.conf', '.properties', '.env'], names: ['.Renviron', '.editorconfig', '.npmrc', 'DESCRIPTION'] },
  { language: 'latex', extensions: ['.tex', '.sty', '.cls', '.ltx', '.bbx', '.cbx'] },
  { language: 'bibtex', extensions: ['.bib'] },
  { language: 'xml', extensions: ['.xml', '.csl', '.svg', '.xsl', '.opf'] },
  { language: 'html', extensions: ['.html', '.htm'] },
  { language: 'css', extensions: ['.css'] },
  { language: 'scss', extensions: ['.scss'] },
  { language: 'javascript', extensions: ['.js', '.mjs', '.cjs', '.jsx'], shebang: /\bnode\b/ },
  { language: 'typescript', extensions: ['.ts', '.mts', '.cts', '.tsx'] },
  { language: 'lua', extensions: ['.lua'], shebang: /\blua\b/ },
  { language: 'sql', extensions: ['.sql'] },
  { language: 'stan', extensions: ['.stan'] },
  { language: 'diff', extensions: ['.diff', '.patch'] },
  { language: 'dockerfile', extensions: ['.dockerfile'], names: ['Dockerfile', 'Containerfile'] },
  {
    extensions: ['.txt', '.text', '.log', '.csv', '.tsv', '.mk'],
    names: ['LICENSE', 'LICENCE', 'COPYING', 'AUTHORS', 'NOTICE', 'CITATION', 'Makefile', 'makefile', 'GNUmakefile',
      '.gitignore', '.gitattributes', '.gitmodules', '.Rbuildignore', '.dockerignore', '.nojekyll'],
  },
];

/**
 * Text files: scripts, data and configuration around the documents, one type
 * for all of them, below the markdown types. The language each file is
 * highlighted as comes from its name (see `textFiles`).
 */
export const textFile = createTextType({
  id: 'text',
  label: 'Text file',
  description: 'Scripts, data and settings files (.R, .py, .csv, .yml, .bib, .tex, …), highlighted by name',
  files: textFiles,
  newFileExtensions: ['.txt'],
  priority: -10,
});

/** Every text type this package defines. */
export const textTypes: DocumentType[] = [textFile];
