import type { Mark, Node as PMNode, Schema } from 'prosemirror-model';
import type { ParsedDocument } from '@kuraa/kernel';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmTable } from 'micromark-extension-gfm-table';
import { gfmTableFromMarkdown } from 'mdast-util-gfm-table';
import { gfmStrikethrough } from 'micromark-extension-gfm-strikethrough';
import { gfmStrikethroughFromMarkdown } from 'mdast-util-gfm-strikethrough';
import { gfmTaskListItem } from 'micromark-extension-gfm-task-list-item';
import { gfmTaskListItemFromMarkdown } from 'mdast-util-gfm-task-list-item';
import { gfmFootnote } from 'micromark-extension-gfm-footnote';
import { gfmFootnoteFromMarkdown } from 'mdast-util-gfm-footnote';
import { math } from 'micromark-extension-math';
import { mathFromMarkdown } from 'mdast-util-math';
import { frontmatter } from 'micromark-extension-frontmatter';
import { frontmatterFromMarkdown } from 'mdast-util-frontmatter';
import { CITATION_KEY } from './citations.js';

/** A loose view of an mdast node with absolute source offsets. */
export interface MdNode {
  type: string;
  children?: MdNode[];
  value?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
  [key: string]: unknown;
}

export interface ParseContext {
  schema: Schema;
  /** The whole source text. */
  source: string;
  /** Source text of an mdast node. */
  slice(node: MdNode): string;
  start(node: MdNode): number;
  end(node: MdNode): number;
  blocks(children: MdNode[]): PMNode[];
  inlines(parent: MdNode, marks?: readonly Mark[]): PMNode[];
  raw(node: MdNode): PMNode;
}

export interface ParseHooks {
  /** Return a node to replace the default conversion, or undefined to fall through. */
  block?(node: MdNode, ctx: ParseContext): PMNode | undefined;
  inline?(node: MdNode, ctx: ParseContext, marks: readonly Mark[]): PMNode[] | undefined;
}

/** Bracketed text that holds a citation: a key after the start, a space or a semicolon. */
const CITES = new RegExp(String.raw`(^|[\s;])-?@${CITATION_KEY}`, 'u');
/** An in-text citation and a space, just before a bracket: `@smith2020 [p. 3]` is one citation with a locator. */
const IN_TEXT_BEFORE = new RegExp(String.raw`(?<![\p{L}\p{N}_@\\-])@${CITATION_KEY} $`, 'u');

const micromarkExts = [gfmTable(), gfmStrikethrough({ singleTilde: false }), gfmTaskListItem(), gfmFootnote(), math()];
const mdastExts = [gfmTableFromMarkdown(), gfmStrikethroughFromMarkdown(), gfmTaskListItemFromMarkdown(), gfmFootnoteFromMarkdown(), mathFromMarkdown()];
const body = { extensions: micromarkExts, mdastExtensions: mdastExts };
const withHeader = { extensions: [...micromarkExts, frontmatter(['yaml'])], mdastExtensions: [...mdastExts, frontmatterFromMarkdown(['yaml'])] };

/** Parse a fragment of the source, shifting every offset by `offset`. */
export function parseFragment(text: string, offset: number, withFrontMatter = false): MdNode {
  const root = fromMarkdown(text, withFrontMatter ? withHeader : body) as unknown as MdNode;
  if (offset) shift(root, offset);
  return root;
}

function shift(node: MdNode, by: number): void {
  const p = node.position;
  if (p) {
    if (p.start.offset !== undefined) p.start.offset += by;
    if (p.end.offset !== undefined) p.end.offset += by;
  }
  for (const c of node.children ?? []) shift(c, by);
}

// ---------------------------------------------------------------------------
// Fenced divs: Pandoc's `::: {.class}` blocks. micromark has no extension for
// them, so the top level is pre-scanned and each div's body parsed recursively.

const DIV_OPEN = /^ {0,3}(:{3,})[ \t]*(\{[^}\n]*\}|[^\s:{][^\s]*)[ \t]*:*[ \t]*$/;
const DIV_CLOSE = /^ {0,3}(:{3,})[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

/** Grid tables and simple/multiline tables, which remark reads as paragraphs. */
const TABLE_LIKE = /^\+[-=:]+\+|(^|\n)[ \t]*-{3,}[ \t]+-{3,}/;

const DEF_MARKER = /^ {0,2}[:~](?:[ \t]+|$)/;

interface Region { kind: 'md' | 'div' | 'dl' | 'raw'; from: number; to: number; open?: RegExpMatchArray; innerFrom?: number; innerTo?: number }

interface Line { from: number; to: number; text: string }

function splitLines(text: string, from: number, to: number): Line[] {
  const lines: Line[] = [];
  let pos = from;
  while (pos < to) {
    const nl = text.indexOf('\n', pos);
    const lineEnd = nl === -1 || nl >= to ? to : nl;
    lines.push({ from: pos, to: lineEnd, text: text.slice(pos, lineEnd) });
    pos = lineEnd + 1;
  }
  return lines;
}

const blank = (l: Line | undefined) => !l || l.text.trim() === '';
const indented = (l: Line) => /^( {4}|\t)/.test(l.text);

/** If a definition list starts at line i, return the index of its last line. */
function definitionListEnd(lines: Line[], i: number): number {
  const isTermAt = (k: number) => {
    const l = lines[k];
    if (!l || blank(l) || indented(l) || DEF_MARKER.test(l.text) || /^ {0,3}(:{3,}|`{3,}|~{3,}|[-*+] |\d+[.)] |#|>)/.test(l.text)) return false;
    if (k > 0 && !blank(lines[k - 1])) return false;
    let j = k + 1;
    if (blank(lines[j])) j++;
    return Boolean(lines[j] && DEF_MARKER.test(lines[j]!.text));
  };
  if (!isTermAt(i)) return -1;
  let last = i;
  let k = i + 1;
  let inDef = false;
  while (k < lines.length) {
    const l = lines[k]!;
    if (blank(l)) { k++; continue; }
    if (DEF_MARKER.test(l.text)) { inDef = true; last = k; k++; continue; }
    if (inDef && (indented(l) || !blank(lines[k - 1]))) { last = k; k++; continue; }
    if (isTermAt(k)) { inDef = false; last = k; k++; continue; }
    break;
  }
  return last;
}

const DASHES = /^ {0,3}-{3,}[ \t]*$/;
const DASH_GROUPS = /^[ \t]*-{2,}([ \t]+-{2,})+[ \t]*$/;

/** Pandoc multiline tables: a dashed rule, rows, a dashed rule, an optional caption. */
function multilineTableEnd(lines: Line[], i: number): number {
  if (!DASHES.test(lines[i]?.text ?? '') || (i > 0 && !blank(lines[i - 1]))) return -1;
  let sawGroups = false;
  for (let k = i + 1; k < lines.length; k++) {
    const t = lines[k]!.text;
    if (blank(lines[k]) && blank(lines[k + 1])) return -1;
    if (DASH_GROUPS.test(t)) sawGroups = true;
    else if (DASHES.test(t) && sawGroups && blank(lines[k + 1])) {
      // Include a following caption paragraph.
      let end = k;
      if (lines[k + 2] && /^(Table)?:[ \t]+\S/.test(lines[k + 2]!.text)) {
        end = k + 2;
        while (lines[end + 1] && !blank(lines[end + 1])) end++;
      }
      return end;
    }
  }
  return -1;
}

/** Pandoc simple tables: a header line, a rule of dash groups, rows, a blank line. */
function simpleTableEnd(lines: Line[], i: number): number {
  if (blank(lines[i]) || (i > 0 && !blank(lines[i - 1])) || !DASH_GROUPS.test(lines[i + 1]?.text ?? '')) return -1;
  let end = i + 1;
  while (lines[end + 1] && !blank(lines[end + 1])) end++;
  if (lines[end + 2] && /^(Table)?:[ \t]+\S/.test(lines[end + 2]!.text)) {
    end += 2;
    while (lines[end + 1] && !blank(lines[end + 1])) end++;
  }
  return end;
}

function scanRegions(text: string, from: number, to: number): Region[] {
  const regions: Region[] = [];
  const lines = splitLines(text, from, to);
  let mdStart = from;
  let codeFence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = FENCE.exec(line.text);
    if (codeFence) {
      if (fence?.[1] && fence[1][0] === codeFence[0] && fence[1].length >= codeFence.length && line.text.trim() === fence[1].trim()) codeFence = null;
      continue;
    }
    if (fence?.[1]) { codeFence = fence[1]; continue; }
    const open = DIV_OPEN.exec(line.text);
    if (open) {
      let depth = 1;
      let inner: string | null = null;
      let k = i + 1;
      for (; k < lines.length; k++) {
        const t = lines[k]!.text;
        const f = FENCE.exec(t);
        if (inner) {
          if (f?.[1] && f[1][0] === inner[0] && f[1].length >= inner.length && t.trim() === f[1].trim()) inner = null;
          continue;
        }
        if (f?.[1]) { inner = f[1]; continue; }
        if (DIV_OPEN.test(t)) depth++;
        else if (DIV_CLOSE.test(t) && --depth === 0) break;
      }
      if (k >= lines.length) continue; // Unclosed: Pandoc reads the fence as text.
      if (line.from > mdStart) regions.push({ kind: 'md', from: mdStart, to: line.from });
      const close = lines[k]!;
      regions.push({ kind: 'div', from: line.from, to: close.to, open, innerFrom: Math.min(line.to + 1, close.from), innerTo: close.from });
      mdStart = close.to;
      i = k;
      continue;
    }
    const mtEnd = Math.max(multilineTableEnd(lines, i), simpleTableEnd(lines, i));
    if (mtEnd >= 0) {
      if (line.from > mdStart) regions.push({ kind: 'md', from: mdStart, to: line.from });
      regions.push({ kind: 'raw', from: line.from, to: lines[mtEnd]!.to });
      mdStart = lines[mtEnd]!.to;
      i = mtEnd;
      continue;
    }
    const dlEnd = definitionListEnd(lines, i);
    if (dlEnd >= 0) {
      if (line.from > mdStart) regions.push({ kind: 'md', from: mdStart, to: line.from });
      regions.push({ kind: 'dl', from: line.from, to: lines[dlEnd]!.to });
      mdStart = lines[dlEnd]!.to;
      i = dlEnd;
    }
  }
  if (mdStart < to) regions.push({ kind: 'md', from: mdStart, to });
  return regions;
}

// ---------------------------------------------------------------------------

export function createParser(schema: Schema, hooks: ParseHooks[] = []) {
  return function parse(text: string): ParsedDocument {
    try {
      return parseUnsafe(schema, hooks, text);
    } catch (err) {
      // Totality: never throw. The whole file becomes one raw block.
      console.warn('[format-pandoc] parse failed, keeping file as raw text', err);
      const node = text
        ? schema.nodes.raw_block!.create(null, schema.text(text.replace(/\n+$/, '')))
        : schema.nodes.paragraph!.create();
      return { text, doc: schema.topNodeType.create(null, [node]), blocks: [{ from: 0, to: text.length }] };
    }
  };
}

function parseUnsafe(schema: Schema, hooks: ParseHooks[], source: string): ParsedDocument {
  const n = schema.nodes;
  const start = (node: MdNode) => node.position?.start.offset ?? 0;
  const end = (node: MdNode) => node.position?.end.offset ?? 0;
  const slice = (node: MdNode) => source.slice(start(node), end(node));
  const text = (s: string, marks?: readonly Mark[]) => (s ? [schema.text(s, marks)] : []);

  /** Source of a node with its container prefixes (`> `, list indentation) removed. */
  const dedented = (node: MdNode): string => {
    const col = ((node.position?.start as { column?: number } | undefined)?.column ?? 1) - 1;
    if (col <= 0) return slice(node);
    const re = new RegExp(`\n[ \t>]{0,${col}}`, 'g');
    return slice(node).replace(re, '\n');
  };
  const raw = (node: MdNode): PMNode => n.raw_block!.create(null, text(dedented(node).replace(/\n+$/, '')));
  const rawInline = (s: string, marks: readonly Mark[] = []): PMNode => n.raw_inline!.create({ text: s }, null, marks);

  const ctx: ParseContext = {
    schema, source, slice, start, end,
    blocks: (children) => convertBlocks(children),
    inlines: (parent, marks = []) => convertInlines(parent, marks),
    raw,
  };

  function convertBlocks(children: MdNode[]): PMNode[] {
    const out: PMNode[] = [];
    for (const c of children) {
      const node = safeBlock(c);
      if (node) out.push(node);
    }
    return out;
  }

  function safeBlock(node: MdNode): PMNode | null {
    try {
      for (const h of hooks) {
        const r = h.block?.(node, ctx);
        if (r) return r;
      }
      const r = convertBlock(node);
      if (r) r.check();
      return r;
    } catch {
      return raw(node);
    }
  }

  function containerContent(children: MdNode[] | undefined): PMNode[] {
    const blocks = convertBlocks(children ?? []);
    return blocks.length ? blocks : [n.paragraph!.create()];
  }

  function convertBlock(node: MdNode): PMNode | null {
    switch (node.type) {
      case 'paragraph': {
        const src = slice(node);
        // Tier 3: line blocks, grid and simple tables, LaTeX environments.
        if (/^\|( |$)/.test(src) || TABLE_LIKE.test(src) || /^\\begin\{/.test(src)) return raw(node);
        return definitionList(node) ?? n.paragraph!.create(null, convertInlines(node, []));
      }
      case 'heading': {
        const { children, attrs } = headingAttrs(node);
        return n.heading!.create({ level: node.depth as number, attrs }, convertInlines({ ...node, children }, []));
      }
      case 'thematicBreak':
        return n.horizontal_rule!.create();
      case 'blockquote':
        return n.blockquote!.create(null, containerContent(node.children));
      case 'list': {
        const tight = !isLoose(node);
        const items = (node.children ?? []).map((item) =>
          n.list_item!.create({ checked: (item.checked as boolean | null | undefined) ?? null }, containerContent(item.children)),
        );
        if (node.ordered) {
          const m = /^\s*\d+([.)])/.exec(slice(node));
          return n.ordered_list!.create({ order: (node.start as number | null) ?? 1, tight, delim: m?.[1] ?? '.' }, items);
        }
        const bullet = slice(node).trimStart()[0] ?? '-';
        return n.bullet_list!.create({ tight, bullet: '-*+'.includes(bullet) ? bullet : '-' }, items);
      }
      case 'code': {
        const src = slice(node);
        const fm = /^ {0,3}(`{3,}|~{3,})([^\n]*)/.exec(src);
        const info = fm ? (fm[2] ?? '').trim() : '';
        const fence = fm?.[1] ?? '```';
        return n.code_block!.create({ info, fence }, text(String(node.value ?? '')));
      }
      case 'math':
        return n.math_display!.create(null, text(String(node.value ?? '')));
      case 'yaml':
        return n.front_matter!.create(null, text(String(node.value ?? '')));
      case 'footnoteDefinition':
        return n.footnote_def!.create(
          { label: String(node.label ?? node.identifier ?? '1') },
          containerContent(node.children),
        );
      case 'table':
        return table(node);
      default:
        // html, definition (reference links) and anything unknown: tier 3.
        return raw(node);
    }
  }

  /** Pandoc's rule: a list is loose if blank lines separate items or an item's blocks. */
  function isLoose(list: MdNode): boolean {
    const gaps: [number, number][] = [];
    const items = list.children ?? [];
    items.forEach((item, i) => {
      const next = items[i + 1];
      if (next) gaps.push([end(item), start(next)]);
      const kids = item.children ?? [];
      kids.forEach((k, j) => {
        const after = kids[j + 1];
        if (after) gaps.push([end(k), start(after)]);
      });
    });
    return gaps.some(([a, b]) => /\n[ \t>]*\n/.test(source.slice(a, b)));
  }

  function table(node: MdNode): PMNode {
    const align = ((node.align as (string | null)[] | undefined) ?? []).map((a) => (a ? a[0] : '-')).join('');
    const rows = (node.children ?? []).map((row, ri) =>
      n.table_row!.create(null, (row.children ?? []).map((cell) =>
        n.table_cell!.create({ header: ri === 0 }, convertInlines(cell, [])),
      )),
    );
    return n.table!.create({ align }, rows);
  }

  function headingAttrs(node: MdNode): { children: MdNode[]; attrs: string } {
    const children = [...(node.children ?? [])];
    const last = children[children.length - 1];
    if (last?.type === 'text' && typeof last.value === 'string' && slice(last) === last.value) {
      const m = /[ \t]+(\{[^{}\n]*\})[ \t]*$/.exec(last.value);
      if (m?.[1]) {
        const value = last.value.slice(0, m.index);
        children[children.length - 1] = withRange(last, value, start(last), start(last) + value.length);
        if (!value) children.pop();
        return { children, attrs: m[1] };
      }
    }
    return { children, attrs: '' };
  }

  /** Tight Pandoc definition list: `Term` on one line, then `:   definition` lines. */
  function definitionList(node: MdNode): PMNode | null {
    const src = slice(node);
    const lines = src.split('\n');
    if (lines.length < 2 || /^[:~]/.test(lines[0] ?? '') || !/^ {0,2}[:~][ \t]+\S/.test(lines[1] ?? '')) return null;
    const base = start(node);
    const termText = lines[0] ?? '';
    const term = parseFragment(termText, base).children?.[0];
    if (term?.type !== 'paragraph') return null;
    const items: PMNode[] = [n.dl_term!.create(null, convertInlines(term, []))];
    let offset = termText.length + 1;
    let current: { from: number; to: number } | null = null;
    const defs: { from: number; to: number }[] = [];
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? '';
      const m = /^ {0,2}[:~][ \t]+/.exec(line);
      if (m) {
        current = { from: offset + m[0].length, to: offset + line.length };
        defs.push(current);
      } else if (current) {
        current.to = offset + line.length;
      }
      offset += line.length + 1;
    }
    for (const d of defs) {
      const frag = parseFragment(src.slice(d.from, d.to), base + d.from);
      const para = frag.children?.[0];
      if (frag.children?.length !== 1 || para?.type !== 'paragraph') return null;
      items.push(n.dl_def!.create(null, [n.paragraph!.create(null, convertInlines(para, []))]));
    }
    return n.definition_list!.create(null, items);
  }

  // -------------------------------------------------------------------------
  // Inline conversion

  interface Special { from: number; to: number; make: (marks: readonly Mark[]) => PMNode[]; done?: boolean }

  function convertInlines(parent: MdNode, marks: readonly Mark[]): PMNode[] {
    const specials = findSpecials(parent);
    const out: PMNode[] = [];
    walk(preprocess(parent.children ?? []), marks, specials, out);
    return out;
  }

  /** Attach `{...}` attribute text that follows an image to the image. */
  function preprocess(children: MdNode[]): MdNode[] {
    const result: MdNode[] = [];
    for (let i = 0; i < children.length; i++) {
      const c = children[i]!;
      const next = children[i + 1];
      if (c.type === 'image' && next?.type === 'text' && typeof next.value === 'string' && slice(next) === next.value) {
        const m = /^\{[^{}\n]*\}/.exec(next.value);
        if (m) {
          result.push({ ...c, attrs: m[0], position: { start: c.position!.start, end: { offset: end(c) + m[0].length } } });
          const rest = next.value.slice(m[0].length);
          if (rest) result.push(withRange(next, rest, start(next) + m[0].length, end(next)));
          i++;
          continue;
        }
      }
      result.push(c);
    }
    return result;
  }

  function walk(children: MdNode[], marks: readonly Mark[], specials: Special[], out: PMNode[]): void {
    for (const c of children) {
      const s = start(c);
      const e = end(c);
      const inside = containing(specials, s, e);
      if (inside && c.type !== 'text') {
        emitSpecial(inside, marks, out);
        continue;
      }
      if (c.type === 'text') {
        textWithSpecials(c, marks, specials, out);
        continue;
      }
      const converted = convertInline(c, marks, specials);
      out.push(...converted);
    }
  }

  function emitSpecial(sp: Special, marks: readonly Mark[], out: PMNode[]): void {
    if (sp.done) return;
    sp.done = true;
    out.push(...sp.make(marks));
  }

  /** Map each character of a text node's value to its source offset, or null. */
  const alignments = new Map<MdNode, number[] | null>();
  function alignText(node: MdNode): number[] | null {
    let map = alignments.get(node);
    if (map === undefined) alignments.set(node, (map = alignUncached(node)));
    return map;
  }

  function alignUncached(node: MdNode): number[] | null {
    const value = String(node.value ?? '');
    const e = end(node);
    const map: number[] = new Array(value.length);
    let p = start(node);
    for (let i = 0; i < value.length; i++) {
      // A backslash escape maps to the escaped character, not the backslash.
      if (source[p] === '\\' && source[p + 1] === value[i] && /[!-/:-@[-`{-~]/.test(value[i]!)) p++;
      while (p < e && source[p] !== value[i]) p++;
      if (p >= e) return null;
      map[i] = p++;
    }
    return map;
  }

  function textWithSpecials(node: MdNode, marks: readonly Mark[], specials: Special[], out: PMNode[]): void {
    const value = String(node.value ?? '');
    const map = alignText(node);
    if (!map) {
      out.push(...text(value, marks));
      return;
    }
    const escaped = (i: number) => source[(map[i] ?? 0) - 1] === '\\';
    const s = start(node);
    const e = end(node);
    // The first value index at or after a source offset (the map only grows).
    const indexOf = (pos: number) => {
      let lo = 0;
      let hi = map.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (map[mid]! < pos) lo = mid + 1;
        else hi = mid;
      }
      return lo;
    };
    let v = 0;
    for (let h = firstEndingAfter(specials, s); h < specials.length && specials[h]!.from < e; h++) {
      const sp = specials[h]!;
      const v1 = indexOf(sp.from);
      if (v1 > v) out.push(...patterns(value.slice(v, v1), v, escaped, marks));
      emitSpecial(sp, marks, out);
      v = Math.max(v, indexOf(sp.to));
    }
    if (v < value.length) out.push(...patterns(value.slice(v), v, escaped, marks));
  }

  /** Bare citations, superscript and subscript inside plain text. */
  function patterns(value: string, base: number, escaped: (i: number) => boolean, marks: readonly Mark[]): PMNode[] {
    const out: PMNode[] = [];
    const re = new RegExp(String.raw`(?<![\p{L}\p{N}_@])(-?@${CITATION_KEY})|\^([^\s^]+?)\^|~([^\s~]+?)~|(\\[A-Za-z]+(?:\{[^{}\n]*\}|\[[^\]\n]*\])*)`, 'gu');
    let last = 0;
    for (let m = re.exec(value); m; m = re.exec(value)) {
      const at = m.index + (m[1]?.startsWith('-') ? 1 : 0);
      // A TeX command's backslash must itself be literal source, not an escape.
      if (m[4] && escaped(base + m.index)) continue;
      const closeAt = m.index + m[0].length - 1;
      if (escaped(base + at) || (!m[1] && escaped(base + closeAt))) continue;
      if (m.index > last) out.push(...text(value.slice(last, m.index), marks));
      if (m[4]) out.push(rawInline(m[4], marks));
      else if (m[1]) out.push(n.citation!.create({ text: m[1] }, null, marks));
      else if (m[2]) out.push(...text(m[2], schema.marks.superscript!.create().addToSet(marks)));
      else if (m[3]) out.push(...text(m[3], schema.marks.subscript!.create().addToSet(marks)));
      last = m.index + m[0].length;
    }
    if (last < value.length) out.push(...text(value.slice(last), marks));
    return out;
  }

  function convertInline(node: MdNode, marks: readonly Mark[], specials: Special[]): PMNode[] {
    for (const h of hooks) {
      const r = h.inline?.(node, ctx, marks);
      if (r) return r;
    }
    const m = schema.marks;
    const sub = (mark: Mark) => {
      const out: PMNode[] = [];
      walk(node.children ?? [], mark.addToSet(marks), specials, out);
      return out;
    };
    switch (node.type) {
      case 'emphasis': return sub(m.em!.create());
      case 'strong': return sub(m.strong!.create());
      case 'delete': return sub(m.strike!.create());
      case 'link': {
        const src = slice(node);
        return sub(m.link!.create({ href: node.url, title: node.title ?? null, auto: src.startsWith('<') }));
      }
      case 'inlineCode':
        return text(String(node.value ?? ''), m.code!.create().addToSet(marks));
      case 'inlineMath': {
        const src = slice(node);
        const display = src.startsWith('$$');
        const d = display ? 2 : 1;
        const after = source[end(node)] ?? '';
        const valid = src.length > 2 * d && !/\s/.test(src[d] ?? '') && !/\s/.test(src[src.length - d - 1] ?? '') && !/\d/.test(after);
        if (!valid) return text(src, marks);
        return [n.math_inline!.create({ tex: String(node.value ?? ''), display }, null, marks)];
      }
      case 'break':
        return [n.hard_break!.create(null, null, marks)];
      case 'image':
        return [n.image!.create({ src: node.url, alt: node.alt ?? '', title: node.title ?? null, attrs: node.attrs ?? '' }, null, marks)];
      case 'footnoteReference':
        return [n.footnote_ref!.create({ label: String(node.label ?? node.identifier ?? '') }, null, marks)];
      default:
        // html, linkReference, imageReference and unknown: tier 3.
        return [rawInline(slice(node), marks)];
    }
  }

  /** Constructs remark cannot see: inline notes, bracketed citations and spans. */
  function findSpecials(parent: MdNode): Special[] {
    const from = start(parent);
    const src = slice(parent);
    const found: Special[] = [];
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (ch !== '[' || src[i - 1] === '\\') continue;
      const close = matchBracket(src, i);
      if (close < 0) continue;
      const abs = from + i;
      const inner = src.slice(i + 1, close);
      const isNote = src[i - 1] === '^' && src[i - 2] !== '\\';
      const isImage = src[i - 1] === '!' && src[i - 2] !== '\\';
      const after = src[close + 1] ?? '';
      let sp: Special | null = null;
      if (isNote) {
        const s = clean(inner);
        sp = { from: abs - 1, to: from + close + 1, make: (marks) => [n.inline_note!.create({ text: s }, null, marks)] };
      } else if (after === '{' && !isImage) {
        const attrEnd = src.indexOf('}', close + 1);
        if (attrEnd > 0 && !src.slice(close + 1, attrEnd).includes('\n')) {
          const attrs = src.slice(close + 1, attrEnd + 1);
          const s = clean(src.slice(i, attrEnd + 1));
          const plain = /^[^\\`*_[\]<>$^~@&\n]*$/.test(inner);
          sp = {
            from: abs, to: from + attrEnd + 1,
            make: (marks) => plain && inner
              ? text(inner, schema.marks.span!.create({ attrs }).addToSet(marks))
              : [rawInline(s, marks)],
          };
        }
      } else if (!isImage && after !== '(' && after !== '[' && CITES.test(inner)) {
        const s = clean(src.slice(i, close + 1));
        sp = { from: abs, to: from + close + 1, make: (marks) => [n.citation!.create({ text: s }, null, marks)] };
      } else if (!isImage && after !== '(' && after !== '[' && !inner.includes('\n') && IN_TEXT_BEFORE.test(src.slice(Math.max(0, i - 200), i))) {
        // `@key [p. 3]`: one in-text citation with its locator, from the @.
        const at = src.lastIndexOf('@', i);
        const s = src.slice(at, close + 1);
        sp = { from: from + at, to: from + close + 1, make: (marks) => [n.citation!.create({ text: s }, null, marks)] };
      } else {
        // Brackets remark left as text: implicit header references, unresolved
        // reference links, "[sic]". Kept verbatim so Pandoc reads them unchanged.
        let to = close + 1;
        if (after === '[') {
          const c2 = matchBracket(src, close + 1);
          if (c2 > 0) to = c2 + 1;
        } else if (after === '(') {
          const c2 = matchParen(src, close + 1);
          if (c2 > 0) to = c2 + 1;
        }
        const f = isImage ? i - 1 : i;
        const s = clean(src.slice(f, to));
        sp = { from: from + f, to: from + to, make: (marks) => [rawInline(s, marks)] };
      }
      if (!sp) continue;
      const cand = sp;
      // Another construct that only partly overlaps it, or encloses it and is
      // not emphasis, wins; text nodes that overlap must be alignable with the source.
      const ok = everyOverlapping(parent, cand.from, cand.to, (b) => {
        if (b.type === 'text') return alignText(b) !== null;
        const bs = start(b);
        const be = end(b);
        const contained = bs >= cand.from && be <= cand.to;
        const encloses = bs <= cand.from && be >= cand.to;
        return encloses ? b.type === 'emphasis' || b.type === 'strong' || b.type === 'delete' : contained;
      });
      if (!ok) continue;
      found.push(cand);
      i = cand.to - from - 1;
    }
    return found;
  }

  /**
   * Whether `test` holds for every descendant of `node` whose source overlaps
   * [from, to). Children lie in order and apart, inside their parent, so each
   * level is searched by halves and only overlapping nodes are descended into.
   */
  function everyOverlapping(node: MdNode, from: number, to: number, test: (n: MdNode) => boolean): boolean {
    const kids = node.children ?? [];
    let lo = 0;
    let hi = kids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (end(kids[mid]!) <= from) lo = mid + 1;
      else hi = mid;
    }
    for (let k = lo; k < kids.length && start(kids[k]!) < to; k++) {
      if (!test(kids[k]!) || !everyOverlapping(kids[k]!, from, to, test)) return false;
    }
    return true;
  }

  /** Source text with container prefixes (`> `, list indentation) removed after line breaks. */
  function clean(s: string): string {
    return s.replace(/\n[ \t>]*/g, '\n');
  }

  /** Parse a separate text (e.g. dedented definition content) into blocks. */
  function standalone(sub: string): PMNode[] {
    const doc = parseUnsafe(schema, hooks, sub).doc;
    const out: PMNode[] = [];
    doc.forEach((c) => out.push(c));
    return out;
  }

  /** A definition list region found by the scanner; tight or loose. */
  function looseDefinitionList(regionText: string): PMNode {
    const lines = regionText.split('\n');
    const items: PMNode[] = [];
    let def: string[] | null = null;
    let loose = false;
    // Continuation lines are dedented to the column where the definition's text starts.
    let width = 4;
    const flush = () => {
      if (!def) return;
      const content = standalone(def.join('\n').replace(/\n+$/, ''));
      items.push(n.dl_def!.create({ loose }, content.length ? content : [n.paragraph!.create()]));
      def = null;
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const marker = /^ {0,2}[:~](?:[ \t]+|$)/.exec(line);
      if (marker) {
        flush();
        loose = i > 0 && lines[i - 1]!.trim() === '';
        width = Math.min(4, marker[0].replace(/\t/g, '    ').length);
        def = [line.slice(marker[0].length)];
        continue;
      }
      const isBlank = line.trim() === '';
      const prevBlank = i === 0 || lines[i - 1]!.trim() === '';
      const startsTerm = !isBlank && prevBlank && !/^( {4}|\t)/.test(line);
      if (startsTerm) {
        flush();
        const termDoc = standalone(line)[0];
        items.push(n.dl_term!.create(null, termDoc && termDoc.type === n.paragraph ? termDoc.content : null));
        continue;
      }
      if (def) (def as string[]).push(line.startsWith('\t') ? line.slice(1) : line.replace(new RegExp(`^ {0,${width}}`), ''));
    }
    flush();
    return n.definition_list!.create(null, items);
  }

  // -------------------------------------------------------------------------
  // Top level: regions, blocks and their source ranges.

  const items: { node: PMNode; start: number }[] = [];

  function topLevel(from: number, to: number, out: { node: PMNode; start: number }[], allowFrontMatter: boolean): void {
    for (const region of scanRegions(source, from, to)) {
      if (region.kind === 'md') {
        const root = parseFragment(source.slice(region.from, region.to), region.from, allowFrontMatter && region.from === 0);
        const kids = root.children ?? [];
        const CAPTION = /^(Table)?:[ \t]+\S/;
        for (let k = 0; k < kids.length; k++) {
          const c = kids[k]!;
          const next = kids[k + 1];
          const prev = kids[k - 1];
          // Pandoc table captions: a `Table: ...` or `: ...` paragraph next to a table.
          if (c.type === 'table') {
            const node = safeBlock(c);
            if (node && node.type === n.table && next?.type === 'paragraph' && CAPTION.test(slice(next))) {
              out.push({ node: n.table!.create({ ...node.attrs, caption: slice(next).trim() }, node.content), start: start(c) });
              k++;
              continue;
            }
          }
          // A raw grid or simple table keeps its caption with it, verbatim.
          if (c.type === 'paragraph' && next?.type === 'paragraph' && CAPTION.test(slice(next)) && TABLE_LIKE.test(slice(c))) {
            const span: MdNode = { type: 'html', position: { start: c.position!.start, end: next.position!.end } };
            out.push({ node: raw(span), start: start(c) });
            k++;
            continue;
          }
          if (c.type === 'paragraph' && next?.type === 'table' && prev?.type !== 'table' && CAPTION.test(slice(c))) {
            const node = safeBlock(next);
            if (node && node.type === n.table) {
              out.push({ node: n.table!.create({ ...node.attrs, caption: slice(c).trim(), captionBefore: true }, node.content), start: start(c) });
              k++;
              continue;
            }
          }
          const node = safeBlock(c);
          if (node) out.push({ node, start: start(c) });
        }
      } else if (region.kind === 'raw') {
        out.push({ node: n.raw_block!.create(null, text(source.slice(region.from, region.to))), start: region.from });
      } else if (region.kind === 'dl') {
        out.push({ node: looseDefinitionList(source.slice(region.from, region.to)), start: region.from });
      } else {
        const inner: { node: PMNode; start: number }[] = [];
        topLevel(region.innerFrom!, region.innerTo!, inner, false);
        const content = inner.length ? inner.map((x) => x.node) : [n.paragraph!.create()];
        const attrs = (region.open?.[2] ?? '').trim();
        out.push({ node: n.fenced_div!.create({ attrs, fence: region.open?.[1]?.length ?? 3 }, content), start: region.from });
      }
    }
  }

  topLevel(0, source.length, items, true);
  const firstBlock = n.paragraph!.create();
  if (!items.length) items.push({ node: firstBlock, start: 0 });

  // Starts must not go backwards, even if the parser reports overlapping nodes.
  for (let i = 1; i < items.length; i++) items[i]!.start = Math.max(items[i]!.start, items[i - 1]!.start);
  // Contiguous partition of the text: each block runs to the next block's start.
  const blocks = items.map((item, i) => ({
    from: i === 0 ? 0 : item.start,
    to: i + 1 < items.length ? items[i + 1]!.start : source.length,
  }));
  const doc = schema.topNodeType.create(null, items.map((x) => x.node));
  return { text: source, doc, blocks };
}

/** The index of the first special that ends after `pos`; specials lie in order and apart. */
function firstEndingAfter(specials: readonly { to: number }[], pos: number): number {
  let lo = 0;
  let hi = specials.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (specials[mid]!.to <= pos) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first special that contains [from, to), if any. */
function containing<S extends { from: number; to: number }>(specials: readonly S[], from: number, to: number): S | undefined {
  const sp = specials[firstEndingAfter(specials, to - 1)];
  return sp && from >= sp.from && to <= sp.to ? sp : undefined;
}

function withRange(node: MdNode, value: string, from: number, to: number): MdNode {
  return { ...node, value, position: { start: { offset: from }, end: { offset: to } } };
}

function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') { depth--; if (depth === 0) return i; }
    else if (ch === '\n' && src[i + 1] === '\n') return -1;
  }
  return -1;
}

function matchBracket(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '`') {
      // Skip code spans.
      let run = 1;
      while (src[i + run] === '`') run++;
      const close = src.indexOf('`'.repeat(run), i + run);
      if (close < 0) return -1;
      i = close + run - 1;
      continue;
    }
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) return i;
    } else if (ch === '\n' && src[i + 1] === '\n') return -1;
  }
  return -1;
}
