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
import type { DocumentType, FileIcon, ParsedDocument } from '@kuraa/kernel';

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
  /** The files' icon; the type's own if not given. */
  icon?: FileIcon;
}

/** Icons for text files, by what they hold. Strokes in a 16×16 box (see FileIcon). */
export const textIcons = {
  /** Lines of text. */
  text: { paths: ['M3 4h10', 'M3 7h10', 'M3 10h10', 'M3 13h6'] },
  /** Braces: a script or program. */
  code: {
    paths: [
      'M6 2.5c-1.5 0-2 .5-2 2v1.5c0 1-.5 1.5-1.5 1.5 1 0 1.5.5 1.5 1.5v1.5c0 1.5.5 2 2 2',
      'M10 2.5c1.5 0 2 .5 2 2v1.5c0 1 .5 1.5 1.5 1.5-1 0-1.5.5-1.5 1.5v1.5c0 1.5-.5 2-2 2',
    ],
  },
  /** A prompt: a shell script. */
  shell: { paths: ['M3 4.5 6.5 8 3 11.5', 'M8 12h5'] },
  /** Angle brackets: markup (HTML, XML, CSS). */
  markup: { paths: ['M5.5 4.5 2 8l3.5 3.5', 'M10.5 4.5 14 8l-3.5 3.5', 'M9 3 7 13'] },
  /** Sliders: settings. */
  settings: { paths: ['M2.5 5h3', 'M8.5 5h5', 'M5.5 5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0', 'M2.5 11h6.5', 'M12 11h1.5', 'M9 11a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0-3 0'] },
  /** A table: data. */
  data: { paths: ['M2.5 3.5h11v9h-11z', 'M2.5 6.5h11', 'M2.5 9.5h11', 'M6.5 3.5v9'] },
  /** An open book: a bibliography or citation style. */
  references: { paths: ['M8 4.5C6.8 3.5 5 3 2.5 3v9.5c2.5 0 4.3.5 5.5 1.5', 'M8 4.5c1.2-1 3-1.5 5.5-1.5v9.5c-2.5 0-4.3.5-5.5 1.5z'] },
  /** A sigma: LaTeX. */
  latex: { paths: ['M11.5 3.5h-7l4 4.5-4 4.5h7'] },
  /** A page with a folded corner and lines: markdown, shown as text when its own format is off. */
  document: { paths: ['M4 1.5h5.5l3 3v10H4z', 'M9.5 1.5v3h3', 'M6 7.5h4.5', 'M6 9.5h4.5', 'M6 11.5h3'] },
} satisfies Record<string, FileIcon>;

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
  /** The icon for files whose rule names none. */
  icon?: FileIcon;
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
    icon: (path) => ruleFor(opts.files, path, '')?.icon ?? opts.icon,
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
  { language: 'r', icon: textIcons.code, extensions: ['.R'], names: ['.Rprofile', 'NAMESPACE'], shebang: /\bRscript\b/ },
  { language: 'python', icon: textIcons.code, extensions: ['.py', '.pyw'], shebang: /\bpython[\d.]*\b/ },
  { language: 'julia', icon: textIcons.code, extensions: ['.jl'], shebang: /\bjulia\b/ },
  { language: 'shell', icon: textIcons.shell, extensions: ['.sh', '.bash', '.zsh'], names: ['.bashrc', '.bash_profile', '.zshrc', '.profile'], shebang: /\b(ba|z|da|k)?sh\b/ },
  { language: 'yaml', icon: textIcons.settings, extensions: ['.yml', '.yaml', '.cff'] },
  // Markdown documents have their own types, which win; these apply when they are turned off.
  { language: 'markdown', icon: textIcons.document, extensions: ['.md', '.markdown', '.Rmd', '.qmd'] },
  { language: 'json', icon: textIcons.data, extensions: ['.json', '.jsonc', '.geojson', '.code-workspace'] },
  { language: 'toml', icon: textIcons.settings, extensions: ['.toml'] },
  { language: 'properties', icon: textIcons.settings, extensions: ['.ini', '.cfg', '.conf', '.properties', '.env'], names: ['.Renviron', '.editorconfig', '.npmrc', 'DESCRIPTION'] },
  { language: 'latex', icon: textIcons.latex, extensions: ['.tex', '.sty', '.cls', '.ltx', '.bbx', '.cbx'] },
  { language: 'bibtex', icon: textIcons.references, extensions: ['.bib'] },
  { language: 'xml', icon: textIcons.references, extensions: ['.csl'] },
  { language: 'xml', icon: textIcons.markup, extensions: ['.xml', '.svg', '.xsl', '.opf'] },
  { language: 'html', icon: textIcons.markup, extensions: ['.html', '.htm'] },
  { language: 'css', icon: textIcons.markup, extensions: ['.css'] },
  { language: 'scss', icon: textIcons.markup, extensions: ['.scss'] },
  { language: 'javascript', icon: textIcons.code, extensions: ['.js', '.mjs', '.cjs', '.jsx'], shebang: /\bnode\b/ },
  { language: 'typescript', icon: textIcons.code, extensions: ['.ts', '.mts', '.cts', '.tsx'] },
  { language: 'lua', icon: textIcons.code, extensions: ['.lua'], shebang: /\blua\b/ },
  { language: 'sql', icon: textIcons.code, extensions: ['.sql'] },
  { language: 'stan', icon: textIcons.code, extensions: ['.stan'] },
  { language: 'diff', icon: textIcons.text, extensions: ['.diff', '.patch'] },
  { language: 'dockerfile', icon: textIcons.settings, extensions: ['.dockerfile'], names: ['Dockerfile', 'Containerfile'] },
  { icon: textIcons.data, extensions: ['.csv', '.tsv'] },
  { icon: textIcons.settings, names: ['Makefile', 'makefile', 'GNUmakefile', '.gitignore', '.gitattributes', '.gitmodules', '.Rbuildignore', '.dockerignore', '.nojekyll'], extensions: ['.mk'] },
  {
    extensions: ['.txt', '.text', '.log'],
    names: ['LICENSE', 'LICENCE', 'COPYING', 'AUTHORS', 'NOTICE', 'CITATION'],
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
  icon: textIcons.text,
});

/** Every text type this package defines. */
export const textTypes: DocumentType[] = [textFile];
