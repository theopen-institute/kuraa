// The languages the client can highlight, by name, and the one highlighter used
// everywhere: code blocks and chunks in documents (CodeMirror), past versions,
// and whole source files (ProseMirror decorations). Tokens get `tok-*` classes,
// coloured in style.css for light and dark themes.
import { LanguageSupport, StreamLanguage, type Language, type StreamParser } from '@codemirror/language';
import { tags as t, tagHighlighter } from '@lezer/highlight';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { c, cpp, java } from '@codemirror/legacy-modes/mode/clike';
import { css, sCSS } from '@codemirror/legacy-modes/mode/css';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { go } from '@codemirror/legacy-modes/mode/go';
import { javascript, json, typescript } from '@codemirror/legacy-modes/mode/javascript';
import { julia } from '@codemirror/legacy-modes/mode/julia';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { octave } from '@codemirror/legacy-modes/mode/octave';
import { perl } from '@codemirror/legacy-modes/mode/perl';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { r } from '@codemirror/legacy-modes/mode/r';
import { ruby } from '@codemirror/legacy-modes/mode/ruby';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { sas } from '@codemirror/legacy-modes/mode/sas';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { stex } from '@codemirror/legacy-modes/mode/stex';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { html, xml } from '@codemirror/legacy-modes/mode/xml';

export const highlighter = tagHighlighter([
  { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], class: 'tok-comment' },
  { tag: [t.keyword, t.controlKeyword, t.operatorKeyword, t.definitionKeyword, t.moduleKeyword, t.modifier], class: 'tok-keyword' },
  { tag: [t.string, t.docString, t.character, t.special(t.string)], class: 'tok-string' },
  { tag: [t.regexp, t.escape], class: 'tok-escape' },
  { tag: [t.number, t.integer, t.float], class: 'tok-number' },
  { tag: [t.bool, t.null, t.atom, t.self, t.unit], class: 'tok-atom' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], class: 'tok-function' },
  { tag: [t.definition(t.variableName), t.definition(t.propertyName), t.labelName], class: 'tok-definition' },
  { tag: [t.standard(t.variableName), t.special(t.variableName), t.macroName], class: 'tok-builtin' },
  { tag: [t.propertyName, t.attributeName], class: 'tok-property' },
  { tag: [t.typeName, t.className, t.namespace, t.tagName], class: 'tok-type' },
  { tag: [t.operator, t.derefOperator, t.arithmeticOperator, t.logicOperator, t.bitwiseOperator, t.compareOperator, t.updateOperator, t.definitionOperator, t.typeOperator, t.controlOperator], class: 'tok-operator' },
  { tag: [t.meta, t.processingInstruction, t.annotation, t.documentMeta], class: 'tok-meta' },
  { tag: t.heading, class: 'tok-heading' },
  { tag: t.emphasis, class: 'tok-emphasis' },
  { tag: t.strong, class: 'tok-strong' },
  { tag: [t.link, t.url], class: 'tok-link' },
  { tag: t.inserted, class: 'tok-inserted' },
  { tag: t.deleted, class: 'tok-deleted' },
  { tag: t.changed, class: 'tok-changed' },
  { tag: t.invalid, class: 'tok-invalid' },
]);

// BibTeX has no CodeMirror mode. Entries are `@type{key, field = {value} # "value", …}`;
// text outside entries is ignored by BibTeX, so it shows as a comment.
interface BibState { depth: number; quote: boolean; key: boolean }
const bibtex: StreamParser<BibState> = {
  name: 'bibtex',
  startState: () => ({ depth: 0, quote: false, key: false }),
  token(stream, s) {
    if (s.quote || s.depth > 1) {
      while (!stream.eol()) {
        const ch = stream.next();
        if (ch === '\\') stream.next();
        else if (ch === '{') s.depth++;
        else if (ch === '}') {
          s.depth--;
          if (s.depth <= 1 && !s.quote) {
            s.depth = Math.max(s.depth, 1);
            return 'string';
          }
        } else if (ch === '"' && s.quote && s.depth === 1) {
          s.quote = false;
          return 'string';
        }
      }
      return 'string';
    }
    if (stream.eatSpace()) return null;
    if (s.depth === 0) {
      if (stream.match(/^@[A-Za-z]+/)) return 'keyword';
      if (stream.match(/^[{(]/)) {
        s.depth = 1;
        s.key = true;
        return 'bracket';
      }
      stream.skipToEnd();
      return 'comment';
    }
    if (s.key) {
      s.key = false;
      if (stream.match(/^[^,\s})=]+(?=\s*,)/)) return 'def';
    }
    if (stream.match(/^%.*/)) return 'comment';
    if (stream.match(/^[A-Za-z][\w:.+-]*(?=\s*=)/)) return 'property';
    if (stream.match(/^\d+/)) return 'number';
    if (stream.eat('"')) {
      s.quote = true;
      return 'string';
    }
    if (stream.eat('{')) {
      s.depth = 2;
      return 'string';
    }
    if (stream.match(/^[})]/)) {
      s.depth = 0;
      return 'bracket';
    }
    if (stream.match(/^[=#,]/)) return 'operator';
    if (stream.match(/^[A-Za-z][\w-]*/)) return 'atom';
    stream.next();
    return null;
  },
};

const stream = (parser: StreamParser<unknown>) => () => new LanguageSupport(StreamLanguage.define(parser));

const LANGUAGES: Record<string, () => LanguageSupport> = {
  r: stream(r),
  python: python,
  yaml: yaml,
  markdown: markdown,
  latex: stream(stex),
  bibtex: stream(bibtex as StreamParser<unknown>),
  shell: stream(shell),
  julia: stream(julia),
  json: stream(json),
  javascript: stream(javascript),
  typescript: stream(typescript),
  toml: stream(toml),
  properties: stream(properties),
  sql: stream(standardSQL),
  xml: stream(xml),
  html: stream(html),
  css: stream(css),
  scss: stream(sCSS),
  lua: stream(lua),
  diff: stream(diff),
  dockerfile: stream(dockerFile),
  c: stream(c),
  cpp: stream(cpp),
  java: stream(java),
  go: stream(go),
  rust: stream(rust),
  ruby: stream(ruby),
  perl: stream(perl),
  octave: stream(octave),
  sas: stream(sas),
};

const ALIASES: Record<string, string> = {
  py: 'python', yml: 'yaml', md: 'markdown', tex: 'latex', bib: 'bibtex',
  bash: 'shell', sh: 'shell', zsh: 'shell', console: 'shell',
  jl: 'julia', js: 'javascript', ts: 'typescript', ini: 'properties', cfg: 'properties',
  svg: 'xml', htm: 'html', 'c++': 'cpp', matlab: 'octave', stan: 'cpp', rscript: 'r',
};

const loaded = new Map<string, LanguageSupport>();

/**
 * The language for a name: a type's language, or a code block's info string
 * (`r`, `{r setup}`, `.python`). Null if unknown.
 */
export function languageSupport(name: string | undefined): LanguageSupport | null {
  let n = (name ?? '').toLowerCase().replace(/^[{.\s]+/, '').split(/[\s,}]/)[0] ?? '';
  n = ALIASES[n] ?? n;
  const make = LANGUAGES[n];
  if (!make) return null;
  let support = loaded.get(n);
  if (!support) loaded.set(n, (support = make()));
  return support;
}

export function language(name: string | undefined): Language | null {
  return languageSupport(name)?.language ?? null;
}
