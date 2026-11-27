// A document's header (its YAML front matter) changed by its fields (0096): a
// corkboard's or an outline's edit to a document that may not be open. Only
// the fields named change; the rest of the header (comments, order, how each
// is written) and the document after it stay as they were.
import { Document, isMap, parseDocument } from 'yaml';

const HEADER = /^(\uFEFF?)---[ \t]*\r?\n([\s\S]*?)(\r?\n)(---|\.\.\.)([ \t]*)(?:\r?\n|$)/;

/**
 * A document's text with header fields set: undefined, null, '' or [] takes
 * one away. A header is made where there is none (and it gains a field); one
 * left with no fields goes. Throws where the header there does not parse, as
 * YAML fields, rather than write over it.
 */
export function withHeaderFields(text: string, fields: Record<string, unknown>): string {
  const m = HEADER.exec(text);
  const yaml = m ? m[2]! : '';
  const parsed = parseDocument(yaml);
  if (parsed.errors.length) throw new Error(`The document's header is not valid YAML: ${parsed.errors[0]!.message.split('\n')[0]}`);
  if (parsed.contents !== null && !isMap(parsed.contents)) throw new Error('The document’s header is not a set of fields');
  const doc = parsed.contents ? parsed : new Document({});
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '' || (Array.isArray(value) && !value.length)) doc.delete(key);
    else doc.set(key, value);
  }
  const map = doc.contents;
  const empty = !map || (isMap(map) && map.items.length === 0);
  const body = m ? text.slice(m[0].length) : text;
  if (empty) return m ? body.replace(/^\r?\n/, '') : text;
  const eol = m?.[3] ?? '\n';
  const head = doc.toString({ lineWidth: 0 }).replace(/\n$/, '').replace(/\n/g, eol);
  return `${m?.[1] ?? ''}---${eol}${head}${eol}${m?.[4] ?? '---'}${m?.[5] ?? ''}${eol}${m ? body : `${eol}${body}`}`;
}
