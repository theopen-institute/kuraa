import type { Mark, Node as PMNode } from 'prosemirror-model';
import type { ParsedDocument } from '@kuraa/kernel';

export interface SerializeContext {
  /** Canonical markdown for a block, without a trailing newline. */
  block(node: PMNode): string;
  /** Canonical markdown for a list of blocks, separated by blank lines. */
  blocks(nodes: PMNode[]): string;
  inlines(node: PMNode, opts?: { table?: boolean }): string;
}

export interface SerializeHooks {
  block?(node: PMNode, ctx: SerializeContext): string | undefined;
  /** Inline code with its mark, e.g. R Markdown's `r expr`. */
  code?(text: string, mark: Mark): string | undefined;
}

export function createSerializer(hooks: SerializeHooks[] = []) {
  const ctx: SerializeContext = {
    block: (node) => blockToMd(node),
    blocks: (nodes) => nodes.map((b) => blockToMd(b)).filter((t, i, all) => t !== '' || all.length === 1).join('\n\n'),
    inlines: (node, opts) => inlinesToMd(node, opts?.table ?? false),
  };

  function blockToMd(node: PMNode): string {
    for (const h of hooks) {
      const r = h.block?.(node, ctx);
      if (r !== undefined) return r;
    }
    const a = node.attrs;
    switch (node.type.name) {
      case 'paragraph':
        return escapeLineStarts(inlinesToMd(node, false));
      case 'heading': {
        // Headings are one line: hard breaks become spaces.
        const content = inlinesToMd(node, false, true)
          .replace(/\n/g, ' ')
          .replace(/#(\s*)$/, '\\#$1')
          .replace(/\{([^{}]*\}\s*)$/, '\\{$1');
        return `${'#'.repeat(a.level as number)} ${content}${a.attrs ? ` ${a.attrs}` : ''}`.trimEnd();
      }
      case 'horizontal_rule':
        return '* * *';
      case 'blockquote':
        return prefixLines(ctx.blocks(children(node)), '> ', '> ', '>');
      case 'code_block': {
        const fence = fenceFor(node.textContent, String(a.fence || '```'));
        return `${fence}${a.info ? String(a.info) : ''}\n${withNewline(node.textContent)}${fence}`;
      }
      case 'front_matter':
        return `---\n${withNewline(node.textContent)}---`;
      case 'raw_block':
        return node.textContent;
      case 'math_display':
        return `$$\n${withNewline(node.textContent)}$$`;
      case 'bullet_list':
      case 'ordered_list':
        return list(node);
      case 'footnote_def': {
        const body = ctx.blocks(children(node));
        return prefixLines(body, `[^${a.label}]: `, '    ', '');
      }
      case 'fenced_div': {
        const fence = ':'.repeat(Math.max(3, Number(a.fence) || 3));
        const attrs = String(a.attrs || '{}');
        return `${fence} ${attrs}\n${ctx.blocks(children(node))}\n${fence}`;
      }
      case 'definition_list': {
        const parts: string[] = [];
        let current = '';
        node.forEach((child) => {
          if (child.type.name === 'dl_term') {
            if (current) parts.push(current);
            current = escapeLineStarts(inlinesToMd(child, false).replace(/\n/g, ' '));
          } else {
            current += (child.attrs.loose ? '\n\n' : '\n') + prefixLines(ctx.blocks(children(child)), ':   ', '    ', '');
          }
        });
        if (current) parts.push(current);
        return parts.join('\n\n');
      }
      case 'table':
        return table(node);
      default:
        // An unknown block from an extension that supplied no serializer.
        return node.textContent;
    }
  }

  function list(node: PMNode): string {
    const ordered = node.type.name === 'ordered_list';
    const tight = Boolean(node.attrs.tight);
    const items: string[] = [];
    let n = Number(node.attrs.order ?? 1);
    node.forEach((item) => {
      const marker = ordered ? `${n++}${node.attrs.delim || '.'} ` : `${node.attrs.bullet || '-'} `;
      const task = item.attrs.checked === null ? '' : item.attrs.checked ? '[x] ' : '[ ] ';
      // Empty paragraphs have no markdown form; a blank first line would end the item.
      let kids = children(item);
      const nonEmpty = kids.filter((b) => !(b.type.name === 'paragraph' && b.childCount === 0));
      if (nonEmpty.length) kids = nonEmpty;
      const body = kids
        .map((b, i) => (i === 0 ? '' : tight && !(b.type.name === 'paragraph' && kids[i - 1]!.isTextblock) ? '\n' : '\n\n') + blockToMd(b))
        .join('');
      items.push(prefixLines(task + body, marker, ' '.repeat(marker.length), ''));
    });
    return items.join(tight ? '\n' : '\n\n');
  }

  function table(node: PMNode): string {
    const rows: string[][] = [];
    node.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => cells.push(inlinesToMd(cell, true).replace(/\n/g, ' ').trim()));
      rows.push(cells);
    });
    const cols = Math.max(...rows.map((r) => r.length), 1);
    const align = String(node.attrs.align ?? '');
    const sep = Array.from({ length: cols }, (_, i) => {
      const c = align[i];
      return c === 'l' ? ':---' : c === 'c' ? ':---:' : c === 'r' ? '---:' : '---';
    });
    const line = (cells: string[]) => `| ${Array.from({ length: cols }, (_, i) => cells[i] ?? '').join(' | ')} |`;
    const [head = [], ...body] = rows;
    const grid = [line(head), `|${sep.join('|')}|`, ...body.map(line)].join('\n');
    const caption = String(node.attrs.caption ?? '').replace(/\n+/g, ' ');
    if (!caption) return grid;
    return node.attrs.captionBefore ? `${caption}\n\n${grid}` : `${grid}\n\n${caption}`;
  }

  // -------------------------------------------------------------------------
  // Inline content

  function inlinesToMd(parent: PMNode, inTable: boolean, oneLine = false): string {
    let out = '';
    let active: Mark[] = [];
    const nodes: PMNode[] = [];
    parent.forEach((c) => nodes.push(c));

    const closeTo = (keep: number) => {
      // Whitespace never sits just inside a closing delimiter.
      const trailing = /[ \t]+$/.exec(out)?.[0] ?? '';
      if (active.length > keep && trailing) out = out.slice(0, out.length - trailing.length);
      for (let i = active.length - 1; i >= keep; i--) out += markClose(active[i]!, isAuto(active[i]!));
      if (active.length > keep) out += trailing;
      active = active.slice(0, keep);
    };

    // An autolink is written as <href> only while its text still equals the href.
    const autoOk = new Set<Mark>();
    nodes.forEach((node, idx) => {
      for (const m of node.marks) {
        if (m.type.name !== 'link' || !m.attrs.auto || (idx > 0 && m.isInSet(nodes[idx - 1]!.marks))) continue;
        let t = '';
        for (let k = idx; k < nodes.length && m.isInSet(nodes[k]!.marks); k++) t += nodes[k]!.isText && nodes[k]!.marks.length === 1 ? nodes[k]!.text : '\u0000';
        const href = String(m.attrs.href);
        if (t === href || `mailto:${t}` === href) autoOk.add(m);
      }
    });
    const isAuto = (m: Mark) => [...autoOk].some((a) => a.eq(m));

    for (const node of nodes) {
      const code = node.marks.find((m) => m.type.spec.code);
      const marks = node.marks.filter((m) => !m.type.spec.code);
      let keep = 0;
      while (keep < active.length && keep < marks.length && active[keep]!.eq(marks[keep]!)) keep++;
      closeTo(keep);
      let content = oneLine && node.type.name === 'hard_break' ? ' ' : inlineContent(node, code, inTable);
      if (marks.length > keep) {
        const leading = /^[ \t]+/.exec(content)?.[0] ?? '';
        out += leading;
        content = content.slice(leading.length);
        for (let i = keep; i < marks.length; i++) out += markOpen(marks[i]!, isAuto(marks[i]!));
        active = [...marks];
      }
      out += content;
    }
    closeTo(0);
    return out;
  }

  function inlineContent(node: PMNode, code: Mark | undefined, inTable: boolean): string {
    const a = node.attrs;
    switch (node.type.name) {
      case 'text': {
        const t = node.text ?? '';
        if (code) {
          for (const h of hooks) {
            const r = h.code?.(t, code);
            if (r !== undefined) return r;
          }
          return codeSpan(t);
        }
        return escapeText(t, inTable);
      }
      case 'hard_break':
        return '\\\n';
      case 'image': {
        const title = a.title ? ` "${String(a.title).replace(/"/g, '\\"')}"` : '';
        return `![${escapeText(String(a.alt), inTable)}](${destination(String(a.src))}${title})${a.attrs ?? ''}`;
      }
      case 'raw_inline':
      case 'citation':
        return String(a.text);
      case 'math_inline':
        return a.display ? `$$${a.tex}$$` : `$${a.tex}$`;
      case 'footnote_ref':
        return `[^${a.label}]`;
      case 'inline_note':
        return `^[${a.text}]`;
      default:
        return node.textContent;
    }
  }

  return function serialize(doc: PMNode, previous?: ParsedDocument): string {
    const nodes = children(doc);
    if (!previous) {
      const parts = nodes.map((b) => blockToMd(b)).filter((t) => t !== '');
      return parts.length ? parts.join('\n\n') + '\n' : '';
    }
    return preserve(nodes, previous, (b) => blockToMd(b));
  };
}

// ---------------------------------------------------------------------------
// Block-level preservation

/**
 * Align the new top-level blocks with the previous ones. Blocks that are
 * structurally equal are written back from the previous source byte for byte.
 * Changed blocks are generated, and keep the trailing blank lines of the block
 * they replace.
 */
export function preserve(nodes: PMNode[], previous: ParsedDocument, generate: (node: PMNode) => string): string {
  const prev = children(previous.doc);
  const match = align(nodes, prev);
  // Pair unmatched blocks positionally inside gaps of equal size: replacements.
  const replaces = new Map<number, number>();
  let i = 0;
  let j = 0;
  while (i <= nodes.length) {
    let i2 = i;
    while (i2 < nodes.length && match[i2] === undefined) i2++;
    const j2 = i2 < nodes.length ? match[i2]! : prev.length;
    if (i2 - i === j2 - j) for (let k = 0; k < i2 - i; k++) replaces.set(i + k, j + k);
    i = i2 + 1;
    j = j2 + 1;
  }

  const sliceOf = (k: number) => {
    const b = previous.blocks[k];
    return b ? previous.text.slice(b.from, b.to) : '';
  };

  let out = '';
  let lastPrev = -2;
  const separate = () => {
    if (!out || out.endsWith('\n\n')) return;
    out += out.endsWith('\n') ? '\n' : '\n\n';
  };
  nodes.forEach((node, idx) => {
    const m = match[idx];
    if (m !== undefined) {
      if (m !== lastPrev + 1) separate();
      out += sliceOf(m);
      lastPrev = m;
      return;
    }
    const body = generate(node);
    // An empty paragraph has no markdown form; writing nothing keeps output stable.
    if (body === '') return;
    const r = replaces.get(idx);
    if (r === undefined || r !== lastPrev + 1) separate();
    if (r !== undefined) {
      const old = sliceOf(r);
      const isLast = r === prev.length - 1;
      const trailing = /\n\s*$/.exec(old)?.[0];
      if (isLast && !old.endsWith('\n')) {
        out += body;
        lastPrev = r;
        return;
      }
      if (trailing && (isLast || (trailing.match(/\n/g)?.length ?? 0) >= 2)) {
        out += body + trailing.replace(/[ \t]+(?=\n)/g, '');
        lastPrev = r;
        return;
      }
    }
    out += body + '\n';
    lastPrev = -2;
  });
  if (lastPrev !== prev.length - 1) out = out.replace(/\n+$/, '\n');
  return out;
}

/** Longest common subsequence of equal blocks. Returns new index -> previous index. */
function align(a: PMNode[], b: PMNode[]): (number | undefined)[] {
  const result: (number | undefined)[] = new Array(a.length).fill(undefined);
  // Trim the common prefix and suffix first; most edits touch few blocks.
  let lo = 0;
  while (lo < a.length && lo < b.length && a[lo]!.eq(b[lo]!)) { result[lo] = lo; lo++; }
  let ha = a.length;
  let hb = b.length;
  while (ha > lo && hb > lo && a[ha - 1]!.eq(b[hb - 1]!)) { ha--; hb--; result[ha] = hb; }
  const n = ha - lo;
  const m = hb - lo;
  if (n === 0 || m === 0) return result;
  if (n * m > 4_000_000) return result; // Pathological: regenerate the middle.
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let x = n - 1; x >= 0; x--) {
    for (let y = m - 1; y >= 0; y--) {
      dp[x]![y] = a[lo + x]!.eq(b[lo + y]!) ? dp[x + 1]![y + 1]! + 1 : Math.max(dp[x + 1]![y]!, dp[x]![y + 1]!);
    }
  }
  let x = 0;
  let y = 0;
  while (x < n && y < m) {
    if (a[lo + x]!.eq(b[lo + y]!)) { result[lo + x] = lo + y; x++; y++; }
    else if (dp[x + 1]![y]! >= dp[x]![y + 1]!) x++;
    else y++;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers

function children(node: PMNode): PMNode[] {
  const out: PMNode[] = [];
  node.forEach((c) => out.push(c));
  return out;
}

function withNewline(s: string): string {
  return s === '' || s.endsWith('\n') ? s : s + '\n';
}

function fenceFor(content: string, preferred: string): string {
  const ch = preferred[0] === '~' ? '~' : '`';
  let len = Math.max(3, preferred.length);
  const re = new RegExp(`^ {0,3}(\\${ch}{3,})`, 'gm');
  for (let m = re.exec(content); m; m = re.exec(content)) len = Math.max(len, (m[1]?.length ?? 0) + 1);
  return ch.repeat(len);
}

/** Prefix the first line with `first`, later lines with `rest`, blank lines with `blank`. */
export function prefixLines(text: string, first: string, rest: string, blank: string): string {
  return text
    .split('\n')
    .map((line, i) => (i === 0 ? first + line : line === '' ? blank : rest + line))
    .join('\n');
}

function codeSpan(text: string): string {
  let longest = 0;
  for (const m of text.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  const fence = '`'.repeat(longest + 1);
  const pad = text.startsWith('`') || text.endsWith('`') || /^ .* $/.test(text) ? ' ' : '';
  return `${fence}${pad}${text}${pad}${fence}`;
}

function destination(url: string): string {
  return /[\s()<>]/.test(url) ? `<${url.replace(/>/g, '%3E')}>` : url;
}

function markOpen(mark: Mark, auto: boolean): string {
  switch (mark.type.name) {
    case 'em': return '*';
    case 'strong': return '**';
    case 'strike': return '~~';
    case 'superscript': return '^';
    case 'subscript': return '~';
    case 'link': return auto ? '<' : '[';
    case 'span': return '[';
    default: return '';
  }
}

function markClose(mark: Mark, auto: boolean): string {
  switch (mark.type.name) {
    case 'em': return '*';
    case 'strong': return '**';
    case 'strike': return '~~';
    case 'superscript': return '^';
    case 'subscript': return '~';
    case 'link': {
      if (auto) return '>';
      const title = mark.attrs.title ? ` "${String(mark.attrs.title).replace(/"/g, '\\"')}"` : '';
      return `](${destination(String(mark.attrs.href))}${title})`;
    }
    case 'span': return `]${mark.attrs.attrs}`;
    default: return '';
  }
}

/** Escape characters that would otherwise be read as markup. */
export function escapeText(text: string, inTable: boolean): string {
  let s = text
    .replace(/[\\`*[\]<$^~]/g, '\\$&')
    .replace(/(^|[^\w])_|_(?=[^\w]|$)/g, (m) => m.replace('_', '\\_'))
    .replace(/(^|[^\w])@(?=\w)/g, '$1\\@')
    .replace(/&(?=#?\w+;)/g, '\\&')
    // Two trailing spaces before a newline would become a hard break.
    .replace(/ +\n/g, '\n');
  if (inTable) s = s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
  return s;
}

/** Escape what would start a different block at the beginning of a line. */
export function escapeLineStarts(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      const ws = /^\s*/.exec(line)?.[0] ?? '';
      const rest = line.slice(ws.length);
      if (/^[#>]/.test(rest) || /^\|( |$)/.test(rest)) return `${ws}\\${rest}`;
      if (/^[-+:][ \t]/.test(rest) || /^[-+]$/.test(rest)) return `${ws}\\${rest}`;
      if (/^[=-]+[ \t]*$/.test(rest) || /^:{3,}/.test(rest)) return `${ws}\\${rest}`;
      const num = /^(\d+)([.)])(?=[ \t]|$)/.exec(rest);
      if (num) return `${ws}${num[1]}\\${rest.slice(num[1]!.length)}`;
      return line;
    })
    .join('\n');
}
