// The document header (YAML metadata at the top of the file), for the Header
// dialog: read from the document, turned into fields to edit, and written back.
//
// Writing back changes only what was changed. The fields someone changed are set
// on the header as it is now (another person may have changed others meanwhile);
// the rest of the YAML, comments and order included, stays as it was.
import { Document, isMap, isScalar, parseDocument, stringify } from 'yaml';
import { DELIBERATE_EDIT, type HeaderField, type HeaderSpec } from '@kuraa/editor-kit';
import type { Node as PMNode } from 'prosemirror-model';
import type { EditorView } from 'prosemirror-view';
import { S } from './strings.js';

export type Kind = HeaderField['kind'];
export type Value = string | string[] | boolean | number | null;

export interface Entry {
  key: string;
  /** What the format knows about the field; none for one of the document's own. */
  field?: HeaderField;
  kind: Kind;
  /**
   * The value as edited: text for text, paragraph, date and yaml (its YAML),
   * lines for a list, true or false, a number or null.
   */
  value: Value;
  /** The value as it was read, as JSON; undefined if the field was added here. */
  initial?: string;
  /** A list read from a single line of text: one item is written back as text. */
  single?: boolean;
  /** Why the value cannot be written (YAML that does not parse). */
  error?: string;
}

const YAML_OPTIONS = { lineWidth: 0 } as const;

/** The header's YAML text, or null if the document has none. */
export function headerText(doc: PMNode, spec: HeaderSpec): string | null {
  const first = doc.firstChild;
  return first?.type.name === spec.node ? first.textContent : null;
}

/** Put the header in the document (null: remove it), as a deliberate edit that typing guards let through. */
export function writeHeader(view: EditorView, spec: HeaderSpec, text: string | null): void {
  const { state } = view;
  const type = state.schema.nodes[spec.node];
  if (!type) return;
  const first = state.doc.firstChild;
  const has = first?.type === type;
  const tr = state.tr;
  if (text === null) {
    if (!has) return;
    const filler = state.doc.childCount === 1 ? state.schema.topNodeType.contentMatch.defaultType?.createAndFill() : null;
    if (filler) tr.replaceWith(0, first.nodeSize, filler);
    else tr.delete(0, first.nodeSize);
  } else {
    const node = type.create(null, text ? state.schema.text(text) : null);
    if (has) tr.replaceWith(0, first.nodeSize, node);
    else tr.insert(0, node);
  }
  view.dispatch(tr.setMeta(DELIBERATE_EDIT, true));
}

const firstLine = (message: string) => message.split('\n')[0]!.trim();

function parse(text: string): { doc: Document } | { error: string } {
  const doc = parseDocument(text);
  if (doc.errors.length) return { error: firstLine(doc.errors[0]!.message) };
  if (doc.contents !== null && !isMap(doc.contents)) return { error: S.header.notFields };
  return { doc };
}

/** Whether YAML text parses; the reason if not. */
export function yamlError(text: string): string | null {
  const doc = parseDocument(text);
  return doc.errors.length ? firstLine(doc.errors[0]!.message) : null;
}

const isScalarValue = (v: unknown) => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

/** How a value is edited: as the format says if it fits, otherwise as fits it. */
export function kindFor(value: unknown, field?: HeaderField): Kind {
  const fits: Record<Kind, (v: unknown) => boolean> = {
    text: (v) => v === null || typeof v === 'string' || typeof v === 'number',
    paragraph: (v) => v === null || typeof v === 'string' || typeof v === 'number',
    date: (v) => v === null || typeof v === 'string' || typeof v === 'number',
    list: (v) => v === null || isScalarValue(v) || (Array.isArray(v) && v.every(isScalarValue)),
    boolean: (v) => typeof v === 'boolean',
    number: (v) => v === null || typeof v === 'number',
    yaml: () => true,
  };
  if (field) return fits[field.kind](value) ? field.kind : 'yaml';
  if (typeof value === 'string') return value.includes('\n') ? 'paragraph' : 'text';
  if (value === null) return 'text';
  if (typeof value === 'boolean') return 'boolean';
  if (typeof value === 'number') return 'number';
  if (Array.isArray(value) && value.length > 0 && value.every(isScalarValue)) return 'list';
  return 'yaml';
}

const asYaml = (value: unknown) => (value === undefined || value === null ? '' : stringify(value, YAML_OPTIONS).replace(/\n$/, ''));

/** A field as it is edited, from its value in the header (undefined: a new field). */
export function entryFor(key: string, value: unknown, field?: HeaderField): Entry {
  const isNew = value === undefined;
  if (isNew) value = field?.initial ?? (field?.kind === 'boolean' ? true : null);
  const kind = kindFor(value, field);
  let edited: Value;
  let single = false;
  switch (kind) {
    case 'list':
      single = !Array.isArray(value) && value !== null;
      edited = Array.isArray(value) ? value.map(String) : value === null ? [] : [String(value)];
      if (isNew && !edited.length) edited = [''];
      break;
    case 'boolean':
      edited = value as boolean;
      break;
    case 'number':
      edited = value as number | null;
      break;
    case 'yaml':
      edited = asYaml(value);
      break;
    default:
      edited = value === null ? '' : String(value);
  }
  return { key, field, kind, value: edited, initial: isNew ? undefined : JSON.stringify(edited), single };
}

/** The header's fields, in the document's order, or why it cannot be shown as fields. */
export function readEntries(text: string | null, spec: HeaderSpec): { entries: Entry[] } | { error: string } {
  const parsed = parse(text ?? '');
  if ('error' in parsed) return parsed;
  const map = parsed.doc.contents;
  if (!map || !isMap(map)) return { entries: [] };
  const values = (parsed.doc.toJS() ?? {}) as Record<string, unknown>;
  const fields = new Map(spec.fields.map((f) => [f.key, f]));
  return {
    entries: map.items.map((pair) => {
      const key = String(isScalar(pair.key) ? pair.key.value : pair.key);
      return entryFor(key, values[key] ?? null, fields.get(key));
    }),
  };
}

/** The required fields (a title) missing from these entries, added first, empty. */
export function withRequired(entries: Entry[], spec: HeaderSpec): Entry[] {
  const fields = new Map(spec.fields.map((f) => [f.key, f]));
  const missing = (spec.required ?? []).filter((k) => !entries.some((e) => e.key === k));
  return [...missing.map((k) => entryFor(k, undefined, fields.get(k))), ...entries];
}

/** The required fields left empty, by label. */
export function emptyRequired(entries: Entry[], spec: HeaderSpec): string[] {
  return (spec.required ?? []).filter((k) => {
    const e = entries.find((x) => x.key === k);
    return !e || empty(e);
  });
}

export const changed = (e: Entry) => e.initial === undefined || JSON.stringify(e.value) !== e.initial;

/** Whether a value is empty, and so the field left out. */
const empty = (e: Entry) => {
  const v = e.value;
  return v === null || (typeof v === 'string' && v.trim() === '') || (Array.isArray(v) && v.every((x) => x.trim() === ''));
};

/** What an entry writes: a value for YAML, or a parsed YAML node. Throws for YAML that does not parse. */
function output(doc: Document, e: Entry): unknown {
  switch (e.kind) {
    case 'list': {
      const items = (e.value as string[]).map((x) => x.trim()).filter(Boolean);
      return e.single && items.length === 1 ? items[0] : items;
    }
    case 'yaml': {
      const parsed = parseDocument(e.value as string);
      if (parsed.errors.length) throw new Error(firstLine(parsed.errors[0]!.message));
      return parsed.contents ?? doc.createNode(null);
    }
    case 'paragraph':
    case 'text':
    case 'date':
      return (e.value as string).replace(/\s+$/, '');
    default:
      return e.value;
  }
}

/**
 * The header with these edits made: fields removed, then fields changed or added
 * (empty ones left out). Null if no field is left. The text itself if nothing changed.
 */
export function mergeHeader(text: string | null, entries: Entry[], removed: string[]): string | null {
  const edits = entries.filter(changed);
  if (!edits.length && !removed.length) return text;
  let doc: Document;
  const parsed = parse(text ?? '');
  if ('error' in parsed || !parsed.doc.contents) {
    // Nothing to merge into (no header, or one that no longer parses): start afresh.
    doc = new Document({});
    if ('error' in parsed) for (const e of entries) if (!changed(e)) edits.push(e);
  } else doc = parsed.doc;
  for (const key of removed) doc.delete(key);
  for (const e of edits) {
    if (empty(e)) doc.delete(e.key);
    else if (!doc.has(e.key) && e === entries[0] && isMap(doc.contents)) {
      // A field added first (a missing title) goes first.
      doc.contents.items.unshift(doc.createPair(e.key, output(doc, e)) as (typeof doc.contents.items)[number]);
    } else doc.set(e.key, output(doc, e));
  }
  const map = doc.contents;
  if (!map || (isMap(map) && map.items.length === 0)) return null;
  return doc.toString(YAML_OPTIONS).replace(/\n$/, '');
}

/** Today's date as Pandoc documents usually write it: 2026-11-18. */
export function today(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
