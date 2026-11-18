import { Schema, type MarkSpec, type NodeSpec } from 'prosemirror-model';
import type { DocumentType, FileIcon, NodeViewHint } from '@kuraa/kernel';
import { pandocMarks, pandocNodes } from './schema.js';
import { createParser, type ParseHooks } from './parse.js';
import { createSerializer, type SerializeHooks } from './serialize.js';
import { pandocTitle } from './title.js';
import { countConflicts, createMerge } from './merge.js';

export { pandocMarks, pandocNodes, safeUrl } from './schema.js';
export { parseFragment, type MdNode, type ParseContext, type ParseHooks } from './parse.js';
export { pandocTitle } from './title.js';
export { conflictBlock, countConflicts, createMerge, isConflictAttrs, isVersionAttrs } from './merge.js';
export { escapeText, escapeLineStarts, prefixLines, preserve, type SerializeContext, type SerializeHooks } from './serialize.js';

/**
 * The extension point other markdown-family types build on. Every field is
 * general: nothing here knows about any particular dialect built on top.
 */
export interface PandocExtension {
  id: string;
  version: number;
  label: string;
  priority?: number;
  match(path: string, head: string): boolean;
  /** Extensions for new files, the usual one first. */
  extensions?: string[];
  /** Added after the Pandoc nodes. A spec with an existing name replaces it. */
  nodes?: Record<string, NodeSpec>;
  marks?: Record<string, MarkSpec>;
  parse?: ParseHooks;
  serialize?: SerializeHooks;
  nodeViews?: Record<string, NodeViewHint>;
  /** Its files' icon; a document page if not given. */
  icon?: FileIcon;
}

/** A page with a folded corner and lines of text. */
export const DOCUMENT_ICON: FileIcon = {
  paths: ['M4 1.5h5.5l3 3v10H4z', 'M9.5 1.5v3h3', 'M6 7.5h4.5', 'M6 9.5h4.5', 'M6 11.5h3'],
};

export const PANDOC_VERSION = 2;

export const pandocNodeViews: Record<string, NodeViewHint> = {
  code_block: { kind: 'code', languageAttr: 'info' },
  front_matter: { kind: 'code', language: 'yaml', header: { attr: '', prefix: 'front matter' } },
  raw_block: { kind: 'code', language: 'markdown', header: { attr: '', prefix: 'raw' } },
  math_display: { kind: 'code', language: 'latex', header: { attr: '', prefix: 'math' } },
  raw_inline: { kind: 'atom', attr: 'text', className: 'raw-inline' },
  citation: { kind: 'atom', attr: 'text', className: 'citation' },
  math_inline: { kind: 'atom', attr: 'tex', className: 'math-inline', prefix: '$', suffix: '$' },
  // Footnotes, inline notes and their references are drawn by the editor module (./editor/notes.ts).
};

export function createPandocType(ext?: PandocExtension): DocumentType {
  const nodes: Record<string, NodeSpec> = { ...pandocNodes };
  // Keep `text` and the inline nodes after the block nodes, as ProseMirror prefers.
  for (const [name, spec] of Object.entries(ext?.nodes ?? {})) nodes[name] = spec;
  const marks: Record<string, MarkSpec> = { ...pandocMarks, ...(ext?.marks ?? {}) };
  const schema = new Schema({ nodes, marks });
  const parse = createParser(schema, ext?.parse ? [ext.parse] : []);
  const serialize = createSerializer(ext?.serialize ? [ext.serialize] : []);
  return {
    id: ext?.id ?? 'pandoc-markdown',
    version: ext ? ext.version : PANDOC_VERSION,
    label: ext?.label ?? 'Pandoc markdown',
    priority: ext?.priority ?? 0,
    match: ext?.match ?? ((path) => /\.(md|markdown)$/i.test(path)),
    extensions: ext?.extensions ?? (ext ? [] : ['.md', '.markdown']),
    schema,
    parse,
    serialize,
    title: pandocTitle,
    merge: createMerge(parse),
    conflicts: countConflicts,
    icon: () => ext?.icon ?? DOCUMENT_ICON,
    editor: { nodeViews: { ...pandocNodeViews, ...(ext?.nodeViews ?? {}) } },
  };
}

export const pandocMarkdown: DocumentType = createPandocType();
