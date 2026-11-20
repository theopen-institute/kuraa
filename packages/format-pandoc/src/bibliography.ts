// Bibliographies, read just far enough to offer and show citations: each
// entry's key, authors, year and title. Pandoc reads them in full when it
// renders; here they only have to be recognised, so the readers are small and
// forgiving: an entry they cannot read is skipped, never an error.
//
// BibTeX and BibLaTeX (.bib), CSL JSON (.json) and CSL YAML (.yaml, .yml), and
// `references:` in the document's own header.
import { parse as parseYaml } from 'yaml';

export interface BibEntry {
  key: string;
  /** Family names (or an organisation's whole name), in order. */
  authors: string[];
  /** The year, as written: '2020', '2020a', 'forthcoming'; '' if none. */
  year: string;
  title: string;
}

/** The bibliography files a document's header names (`bibliography:` one file, or a list), as written. */
export function bibliographyPaths(meta: unknown): string[] {
  const b = (meta && typeof meta === 'object' ? (meta as Record<string, unknown>).bibliography : undefined);
  const list = Array.isArray(b) ? b : b === undefined || b === null ? [] : [b];
  return list.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim());
}

/** A bibliography file's entries, read by its extension. */
export function readBibliography(text: string, file: string): BibEntry[] {
  const ext = /\.([a-z]+)$/i.exec(file)?.[1]?.toLowerCase();
  if (ext === 'json') return readCslJson(text);
  if (ext === 'yaml' || ext === 'yml') return readCslYaml(text);
  return readBibtex(text);
}

/** Entries the header holds itself (`references:`), in CSL form. */
export function headerReferences(meta: unknown): BibEntry[] {
  const refs = meta && typeof meta === 'object' ? (meta as Record<string, unknown>).references : undefined;
  return Array.isArray(refs) ? cslEntries(refs) : [];
}

// ---------------------------------------------------------------------------
// BibTeX

/** The entries of a BibTeX or BibLaTeX file: @type{key, field = {value}, …}. */
export function readBibtex(text: string): BibEntry[] {
  const out: BibEntry[] = [];
  const strings = new Map<string, string>();
  let i = 0;
  while ((i = text.indexOf('@', i)) >= 0) {
    const head = /^@\s*([A-Za-z]+)\s*([{(])/.exec(text.slice(i, i + 64));
    if (!head) {
      i++;
      continue;
    }
    const type = head[1]!.toLowerCase();
    const open = i + head[0].length - 1;
    const end = closing(text, open);
    if (end < 0) break;
    const body = text.slice(open + 1, end);
    i = end + 1;
    if (type === 'comment' || type === 'preamble') continue;
    if (type === 'string') {
      for (const [name, value] of fields(body, strings)) strings.set(name, value);
      continue;
    }
    const comma = body.indexOf(',');
    const key = (comma < 0 ? body : body.slice(0, comma)).trim();
    if (!key || /\s/.test(key)) continue;
    const f = new Map(fields(comma < 0 ? '' : body.slice(comma + 1), strings));
    const date = f.get('year') ?? f.get('date') ?? '';
    out.push({
      key,
      authors: bibtexNames(f.get('author') ?? f.get('editor') ?? ''),
      year: /\d{4}[a-z]?/.exec(date)?.[0] ?? plain(date),
      title: plain(f.get('title') ?? f.get('booktitle') ?? ''),
    });
  }
  return out;
}

/** Where the bracket or brace opened at `open` closes, or -1. */
function closing(text: string, open: number): number {
  const paren = text[open] === '(';
  let braces = 0;
  let parens = 0;
  for (let j = open; j < text.length; j++) {
    const c = text[j];
    if (c === '\\') j++;
    else if (c === '{') braces++;
    else if (c === '}') {
      braces--;
      if (!paren && braces === 0) return j;
    } else if (paren && braces === 0) {
      if (c === '(') parens++;
      else if (c === ')' && --parens === 0) return j;
    }
  }
  return -1;
}

/** The fields of an entry's body: name = {value} | "value" | number | macro, joined with #. */
function fields(body: string, strings: Map<string, string>): [string, string][] {
  const out: [string, string][] = [];
  let i = 0;
  while (i < body.length) {
    const m = /^[\s,]*([A-Za-z][\w:.+-]*)\s*=\s*/.exec(body.slice(i));
    if (!m) break;
    i += m[0].length;
    let value = '';
    for (;;) {
      while (/\s/.test(body[i] ?? '')) i++;
      const c = body[i];
      if (c === '{') {
        const end = closing(body, i);
        if (end < 0) return out;
        value += body.slice(i + 1, end);
        i = end + 1;
      } else if (c === '"') {
        let j = i + 1;
        let depth = 0;
        for (; j < body.length; j++) {
          if (body[j] === '\\') j++;
          else if (body[j] === '{') depth++;
          else if (body[j] === '}') depth--;
          else if (body[j] === '"' && depth <= 0) break;
        }
        value += body.slice(i + 1, j);
        i = j + 1;
      } else {
        const word = /^[\w:.+-]+/.exec(body.slice(i))?.[0] ?? '';
        if (!word) break;
        value += strings.get(word.toLowerCase()) ?? word;
        i += word.length;
      }
      const hash = /^\s*#/.exec(body.slice(i));
      if (!hash) break;
      i += hash[0].length;
    }
    out.push([m[1]!.toLowerCase(), value]);
    // Anything up to the next comma is not part of a field: skip it.
    const next = body.indexOf(',', i);
    i = next < 0 ? body.length : next + 1;
  }
  return out;
}

/** BibTeX's family names from "Smith, John and {World Health Organization} and Jane Doe". */
function bibtexNames(value: string): string[] {
  // Split on " and " outside braces: words at the top level, regrouped.
  const names: string[] = [];
  let cur: string[] = [];
  for (const word of topLevelWords(value.replace(/\s+/g, ' ').trim())) {
    if (word.toLowerCase() === 'and') {
      if (cur.length) names.push(cur.join(' '));
      cur = [];
    } else cur.push(word);
  }
  if (cur.length) names.push(cur.join(' '));
  return names.filter((n) => n.toLowerCase() !== 'others').map(familyName).filter(Boolean);
}

function familyName(name: string): string {
  // A name in braces is kept whole: an organisation.
  if (/^\{.*\}$/.test(name)) return plain(name);
  const comma = topLevelIndex(name, ',');
  if (comma >= 0) return plain(name.slice(0, comma));
  // "Jane van der Berg": from the first lowercase word, else the last word.
  const words = topLevelWords(name);
  const particle = words.findIndex((w, k) => k > 0 && k < words.length - 1 && /^[a-z]/.test(w));
  return plain((particle >= 0 ? words.slice(particle) : words.slice(-1)).join(' '));
}

function topLevelIndex(s: string, ch: string): number {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') depth++;
    else if (s[i] === '}') depth--;
    else if (s[i] === ch && depth === 0) return i;
  }
  return -1;
}

function topLevelWords(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (c === ' ' && depth === 0) {
      if (cur) out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

const ACCENTS: Record<string, string> = { '"': '̈', "'": '́', '`': '̀', '^': '̂', '~': '̃', '=': '̄', '.': '̇', c: '̧', v: '̌', u: '̆', H: '̋' };

/** TeX markup taken out of a field's value: braces, common accents and commands, -- and ~. */
export function plain(value: string): string {
  return value
    .replace(/\\([`'"^~=.])\s*\{?\\?([A-Za-z])\}?/g, (_m, a: string, ch: string) => (ch + ACCENTS[a]!).normalize('NFC'))
    .replace(/\\([cvuH])\s*\{([A-Za-z])\}/g, (_m, a: string, ch: string) => (ch + ACCENTS[a]!).normalize('NFC'))
    .replace(/\\(ss|ae|AE|oe|OE|o|O|l|L|aa|AA)\b\s*/g, (_m, c: string) => ({ ss: 'ß', ae: 'æ', AE: 'Æ', oe: 'œ', OE: 'Œ', o: 'ø', O: 'Ø', l: 'ł', L: 'Ł', aa: 'å', AA: 'Å' })[c]!)
    .replace(/\\(?:emph|textit|textbf|textsc|textrm|texttt|mkbibquote|enquote|url)\s*\{/g, '{')
    .replace(/\\&/g, '&')
    .replace(/\\%/g, '%')
    .replace(/\\_/g, '_')
    .replace(/---/g, '—')
    .replace(/--/g, '–')
    .replace(/~/g, ' ')
    .replace(/\\[A-Za-z]+\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---------------------------------------------------------------------------
// CSL JSON and YAML

export function readCslJson(text: string): BibEntry[] {
  try {
    const data = JSON.parse(text) as unknown;
    return cslEntries(Array.isArray(data) ? data : data && typeof data === 'object' && Array.isArray((data as { items?: unknown }).items) ? (data as { items: unknown[] }).items : []);
  } catch {
    return [];
  }
}

export function readCslYaml(text: string): BibEntry[] {
  try {
    const data = parseYaml(text) as unknown;
    if (Array.isArray(data)) return cslEntries(data);
    return headerReferences(data);
  } catch {
    // A file of several YAML documents, or a header with its fences.
    try {
      const body = text.replace(/^---\s*\n/, '').replace(/\n(?:---|\.\.\.)\s*$/, '\n');
      return headerReferences(parseYaml(body));
    } catch {
      return [];
    }
  }
}

function cslEntries(items: unknown[]): BibEntry[] {
  const out: BibEntry[] = [];
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue;
    const it = raw as Record<string, unknown>;
    const key = typeof it.id === 'string' || typeof it.id === 'number' ? String(it.id) : '';
    if (!key) continue;
    const people = (Array.isArray(it.author) ? it.author : Array.isArray(it.editor) ? it.editor : []) as unknown[];
    const authors = people.map((p) => {
      if (!p || typeof p !== 'object') return typeof p === 'string' ? p : '';
      const o = p as Record<string, unknown>;
      return String(o.family ?? o.literal ?? o.given ?? '');
    }).filter(Boolean);
    out.push({ key, authors, year: cslYear(it.issued), title: typeof it.title === 'string' ? it.title : '' });
  }
  return out;
}

function cslYear(issued: unknown): string {
  if (!issued) return '';
  if (typeof issued === 'string' || typeof issued === 'number') return /\d{4}/.exec(String(issued))?.[0] ?? String(issued);
  if (Array.isArray(issued)) return cslYear(issued[0]);
  const o = issued as Record<string, unknown>;
  const parts = o['date-parts'];
  if (Array.isArray(parts) && Array.isArray(parts[0]) && parts[0][0] !== undefined) return String(parts[0][0]);
  if (typeof o.year === 'string' || typeof o.year === 'number') return String(o.year);
  if (typeof o.literal === 'string') return o.literal;
  if (typeof o.raw === 'string') return /\d{4}/.exec(o.raw)?.[0] ?? o.raw;
  return '';
}

// ---------------------------------------------------------------------------
// Showing entries

/** "Smith", "Smith & Jones", "Smith et al.", or '' with no authors. */
export function authorsShort(e: BibEntry): string {
  const a = e.authors;
  if (a.length === 0) return '';
  if (a.length === 1) return a[0]!;
  if (a.length === 2) return `${a[0]} & ${a[1]}`;
  return `${a[0]} et al.`;
}

/** How an entry is named in a citation: "Smith 2020", or its title when it has no authors. */
export function entryLabel(e: BibEntry): string {
  const who = authorsShort(e) || (e.title.length > 30 ? `${e.title.slice(0, 29)}…` : e.title) || e.key;
  return e.year ? `${who} ${e.year}` : who;
}
