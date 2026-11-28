// A Word document (or OpenDocument, RTF, EPUB, HTML), as pandoc's Markdown,
// made into a folder of documents (0116): split where its chapters begin
// (its level-1 headings), or its sections too (level 2, its chapters then
// folders), or kept whole. A part's heading is its document's title; the
// headings below it move up a level, as a document's own headings go below its
// title (0093). What comes before the first heading is a document of its own.
import { parse } from 'yaml';
import type { PlannedDocument, PlannedFolder } from './plan.js';

export type Split = 'chapters' | 'sections' | 'none';

const HEADER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*(?:\{[^}]*\})?[ \t]*$/;

/** Its header's fields (pandoc writes the file's title and author there), and its text. */
export function splitHeader(markdown: string): { meta: Record<string, unknown>; body: string } {
  const m = HEADER.exec(markdown);
  if (!m) return { meta: {}, body: markdown };
  let meta: unknown;
  try {
    meta = parse(m[1]!);
  } catch {
    meta = null;
  }
  return { meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {}, body: markdown.slice(m[0].length) };
}

/** A heading's words as a title: its Markdown taken away (emphasis, links, escapes, notes). */
export function plainTitle(markdown: string): string {
  return markdown
    .replace(/\[\^[^\]]*\]/g, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)(\{[^}]*\})?/g, '$1')
    .replace(/\[([^\]]*)\]\{[^}]*\}/g, '$1')
    .replace(/(\*\*|__|\*|_|~~|`)/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

const metaText = (v: unknown): string | null => {
  if (typeof v === 'string' && v.trim()) return plainTitle(v);
  if (Array.isArray(v)) return v.map(metaText).filter(Boolean).join(', ') || null;
  return null;
};

interface Part { level: number; title: string; lines: string[] }

/** The text's parts, at each heading of `levels` or above, outside fenced code. */
function parts(body: string, deepest: number): { before: string[]; parts: Part[] } {
  const before: string[] = [];
  const out: Part[] = [];
  let fence: string | null = null;
  for (const line of body.split('\n')) {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length))) fence = fence ? null : f;
    const h = fence || f ? null : HEADING.exec(line);
    if (h && h[1]!.length <= deepest) out.push({ level: h[1]!.length, title: plainTitle(h[2]!) || 'Untitled', lines: [] });
    else (out.at(-1)?.lines ?? before).push(line);
  }
  return { before, parts: out };
}

/** Headings `by` levels up (a document's own sections, under its title), outside fenced code; never above `#`. */
export function headingsUp(text: string, by: number): string {
  if (by <= 0) return text;
  let fence: string | null = null;
  return text.split('\n').map((line) => {
    const f = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (f && (!fence || (f[0] === fence[0] && f.length >= fence.length))) {
      fence = fence ? null : f;
      return line;
    }
    const m = fence ? null : /^(#{1,6})([ \t].*)$/.exec(line);
    return m ? `${'#'.repeat(Math.max(1, m[1]!.length - by))}${m[2]}` : line;
  }).join('\n');
}

const trimmed = (lines: string[]) => lines.join('\n').replace(/^\s+|\s+$/g, '');

/**
 * The folder an imported file makes: named by its title (its own, or `name`),
 * its title and author kept for Compile; its documents as `split` says.
 */
export function planWord(markdown: string, name: string, split: Split, media: { name: string; bytes: Uint8Array }[]): PlannedFolder {
  const { meta, body } = splitHeader(markdown);
  const title = metaText(meta.title) ?? name;
  const author = metaText(meta.author);
  const folder: PlannedFolder = { kind: 'folder', title, items: [], compile: { title, ...(author ? { author } : {}) } };
  const doc = (t: string | null, text: string, fallback?: string): PlannedDocument => ({ kind: 'document', title: t, ...(fallback ? { name: fallback } : {}), body: text, media });
  if (split === 'none') {
    folder.items.push(doc(title, body.trim()));
    return folder;
  }
  const { before, parts: found } = parts(body, split === 'chapters' ? 1 : 2);
  // No headings to split at: one document.
  if (!found.length) {
    folder.items.push(doc(title, trimmed(before)));
    return folder;
  }
  // What comes before the first heading: a document of its own, untitled where the book's title stands for it.
  if (trimmed(before)) folder.items.push(doc(null, trimmed(before), title));
  let chapter: PlannedFolder | null = null;
  for (const p of found) {
    if (split === 'sections' && p.level === 1) {
      // A chapter: a folder (its name its heading), what it says before its first section a document without a title of its own.
      chapter = { kind: 'folder', title: p.title, items: [] };
      folder.items.push(chapter);
      if (trimmed(p.lines)) chapter.items.push(doc(null, headingsUp(trimmed(p.lines), 2), p.title));
      continue;
    }
    const d = doc(p.title, headingsUp(trimmed(p.lines), p.level));
    (chapter ?? folder).items.push(d);
  }
  return folder;
}
