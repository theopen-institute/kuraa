// A document's details (0094), as Scrivener's inspector has them: a synopsis,
// a label, a status and keywords, kept in the document's own header, where
// pandoc and other tools read them as they are (keywords is pandoc's own):
//
//   ---
//   title: The harbour
//   synopsis: They arrive at night; nobody meets them.
//   label: Chapter
//   status: First draft
//   keywords: [harbour, night]
//   ---
//
// A document's type reads its header (DocumentType.header, 0119): YAML front
// matter, for Pandoc's Markdown and R Markdown.
import type { DocumentType } from '@kuraa/kernel';

export interface Details {
  synopsis: string | null;
  label: string | null;
  status: string | null;
  keywords: string[];
}

export const DETAIL_KEYS = ['synopsis', 'label', 'status', 'keywords'] as const;

/** The statuses offered where the workspace names none, as Scrivener's are. */
export const DEFAULT_STATUSES = ['To do', 'First draft', 'Revised draft', 'Final draft', 'Done'];

/** The documents that have details: those whose type has header fields (0119). */
export const hasDetails = (type: { header?: unknown } | undefined): boolean => !!type?.header;

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null);

/** A list of keywords, however the header writes them: a list, or words with commas between. */
export function keywordsOf(v: unknown): string[] {
  const all = Array.isArray(v) ? v.map(text) : typeof v === 'string' ? v.split(',').map(text) : [];
  return [...new Set(all.filter((k): k is string => !!k))];
}

/** A document's details from its header's fields. */
export function detailsOf(fields: (key: string) => unknown): Details {
  return { synopsis: text(fields('synopsis')), label: text(fields('label')), status: text(fields('status')), keywords: keywordsOf(fields('keywords')) };
}

/** A document's details from its file's text, as its type reads its header (none where it has none, or it cannot be read). */
export function detailsOfText(type: DocumentType | undefined, source: string): Details {
  const fields = type?.header?.read(source) ?? {};
  return detailsOf((k) => fields[k]);
}

export const isEmpty = (d: Details): boolean => !d.synopsis && !d.label && !d.status && !d.keywords.length;

/** Labels' colours: from a name, always the same one, among colours that read on light and dark alike. */
const COLOURS = ['#d9534f', '#e67e22', '#d4ac0d', '#27ae60', '#16a085', '#2e86de', '#8e44ad', '#c0398b'];
export function labelColour(label: string): string {
  let h = 0;
  for (const ch of label.toLowerCase()) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return COLOURS[h % COLOURS.length]!;
}
