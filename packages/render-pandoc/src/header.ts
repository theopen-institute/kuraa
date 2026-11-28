// What a document's header asks of its render, read as the R engine's render
// script reads it (packages/engine-r/src/render-script.ts), so a document comes
// out the same wherever it is rendered: R Markdown's `output:` (the first entry
// for the format, and its options), a Quarto-style `format:` (by format), and
// those keys at the header's top level for every format (0106).
import { parse } from 'yaml';
import type { RenderFormat } from '@kuraa/run-kit';

/** LaTeX engines a header may ask for, for a PDF. */
export const LATEX = ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic'];

export interface HeaderOptions {
  toc: boolean;
  numbered: boolean;
  /** Files it names, as written (relative to the document). */
  referenceDoc: string | null;
  cover: string | null;
  bibliography: string[];
  csl: string | null;
  css: string[];
  /** A LaTeX engine it asks for, for a PDF. */
  latex: string | null;
  /** Whether it has a title (or a page title) of its own. */
  titled: boolean;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter((s): s is string => !!s) : str(v) ? [str(v)!] : []);

const HEADER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;

/** A document's header as data; {} where it has none, or none that reads. */
export function headerOf(text: string): Obj {
  const yaml = HEADER.exec(text)?.[1];
  if (!yaml) return {};
  try {
    const v: unknown = parse(yaml);
    return isObj(v) ? v : {};
  } catch {
    return {};
  }
}

const PICK: Record<RenderFormat, RegExp> = { html: /html/, docx: /word|docx/, pdf: /pdf/, epub: /epub/ };

export function headerOptions(header: Obj, format: RenderFormat): HeaderOptions {
  // R Markdown's output: a name, a list of names, or names with options.
  const output = header.output;
  const entries: Obj = typeof output === 'string' ? { [output]: {} }
    : Array.isArray(output) ? Object.fromEntries(output.filter((x): x is string => typeof x === 'string').map((n) => [n, {}]))
      : isObj(output) ? output : {};
  const chosen = Object.keys(entries).find((n) => PICK[format].test(n));
  const opts: Obj = chosen && isObj(entries[chosen]) ? (entries[chosen] as Obj) : {};
  // Quarto-style: format: { html: { toc: true } }; and the same keys at the top level.
  const quarto: Obj = isObj(header.format) && isObj((header.format as Obj)[format]) ? ((header.format as Obj)[format] as Obj) : {};
  const top = (key: string) => quarto[key] ?? header[key];
  const wanted = str(opts.latex_engine) ?? str(top('pdf-engine'));
  return {
    toc: (opts.toc ?? top('toc')) === true,
    numbered: (opts.number_sections ?? top('number-sections')) === true,
    referenceDoc: str(opts.reference_docx) ?? str(top('reference-doc')),
    cover: str(top('cover-image')),
    bibliography: strs(header.bibliography),
    csl: str(header.csl),
    css: [...strs(opts.css), ...strs(top('css'))],
    latex: format === 'pdf' && wanted && LATEX.includes(wanted) ? wanted : null,
    titled: !!str(header.title) || !!str(header.pagetitle),
  };
}
