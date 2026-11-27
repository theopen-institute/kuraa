// Helpers for the format tests: corpus loading, the Pandoc oracle, a PRNG and random edits.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { Transform } from 'prosemirror-transform';
import type { Node as PMNode } from 'prosemirror-model';

export const CORPUS = join(import.meta.dirname, '..', 'fixtures', 'corpus');

export function corpusFiles(ext: RegExp): { name: string; text: string }[] {
  if (!existsSync(CORPUS)) return [];
  return readdirSync(CORPUS)
    .filter((f) => ext.test(f) && f !== 'README.md')
    .sort()
    .map((name) => ({ name, text: readFileSync(join(CORPUS, name), 'utf8') }));
}

export const hasPandoc = spawnSync('pandoc', ['--version']).status === 0;

/** Pandoc's syntax tree for a markdown text, as normalised JSON. */
export function pandocAst(text: string): unknown {
  const json = execFileSync('pandoc', ['-f', 'markdown', '-t', 'json'], { input: text, maxBuffer: 64 * 1024 * 1024 }).toString();
  return JSON.parse(json);
}

/** Deterministic PRNG so failures can be replayed. */
export function rng(seed: number) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)]! };
}

interface TextblockPos { pos: number; node: PMNode; top: number }

export function textblocks(doc: PMNode, opts: { code?: boolean } = {}): TextblockPos[] {
  const out: TextblockPos[] = [];
  doc.forEach((_child, offset, index) => {
    doc.child(index).descendants((node, pos) => {
      if (node.isTextblock && (opts.code || !node.type.spec.code)) out.push({ pos: offset + 1 + pos, node, top: index });
      return true;
    });
    const child = doc.child(index);
    if (child.isTextblock && (opts.code || !child.type.spec.code)) out.push({ pos: offset, node: child, top: index });
  });
  return out;
}

const WORDS = ['alpha', 'beta', 'gamma', 'data', 'field', 'note', 'Smith', 'x', 'résumé', '42'];
const PUNCT = ['*', '_', '`', '[', ']', '#', '$', '@', '^', '~', '<', '>', '|', '\\', '&', '-', '1.', ':'];

/**
 * Normalise what markdown cannot express: edge whitespace, empty paragraphs,
 * and list tightness (two paragraphs in one item always make a list loose);
 * and a grid table's columns' widths, which are as written (a column widened
 * for its text reads back wider: 0102).
 */
export function normalise(doc: PMNode): unknown {
  const walk = (json: Record<string, unknown>, textblock: boolean): Record<string, unknown> => {
    const content = json.content as Record<string, unknown>[] | undefined;
    if (!content) return json;
    let kids = content.map((c) => walk(c, false));
    if (textblock) {
      kids = kids.map((k) => ({ ...k, text: typeof k.text === 'string' ? k.text.replace(/[ \t]*\n[ \t]*/g, '\n') : k.text }));
      const first = kids[0];
      if (first && typeof first.text === 'string') first.text = first.text.replace(/^\s+/, '');
      const last = kids[kids.length - 1];
      if (last && typeof last.text === 'string') last.text = last.text.replace(/\s+$/, '');
      // Whitespace next to a hard break has no markdown form.
      kids = kids.map((k, i) => {
        if (typeof k.text !== 'string') return k;
        let t = k.text;
        if (kids[i + 1]?.type === 'hard_break') t = t.replace(/\s+$/, '');
        if (kids[i - 1]?.type === 'hard_break') t = t.replace(/^\s+/, '');
        return { ...k, text: t };
      });
      kids = kids.filter((k) => k.text !== '');
      // A bare citation glued to a word reads back as text; compare by its source.
      kids = kids.map((k) => (k.type === 'citation' ? { type: 'text', text: (k.attrs as { text: string }).text, ...(k.marks ? { marks: k.marks } : {}) } : k));
      // Marks on whitespace (outside code) have no markdown form: drop them.
      kids = kids.flatMap((k) => {
        if (typeof k.text !== 'string' || !k.marks) return [k];
        const marks = k.marks as { type: string }[];
        if (marks.some((m) => m.type === 'code')) return [k];
        return (k.text.match(/\s+|\S+/g) ?? []).map((part) => (/^\s+$/.test(part) ? { type: 'text', text: part } : { ...k, text: part }));
      });
      // Merge adjacent text with equal marks.
      const merged: Record<string, unknown>[] = [];
      for (const k of kids) {
        const prev = merged[merged.length - 1];
        if (prev && typeof prev.text === 'string' && typeof k.text === 'string' && JSON.stringify(prev.marks) === JSON.stringify(k.marks)) prev.text += k.text;
        else merged.push({ ...k });
      }
      kids = merged;
    } else {
      kids = kids.filter((k) => !(k.type === 'paragraph' && !k.content));
    }
    return { ...json, content: kids.length ? kids : undefined };
  };
  const stripTight = (j: unknown): unknown => {
    if (Array.isArray(j)) return j.map(stripTight);
    if (!j || typeof j !== 'object') return j;
    const o: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(j)) o[k] = k === 'attrs' && v && typeof v === 'object' ? { ...(v as object), tight: undefined, auto: undefined, widths: undefined } : stripTight(v);
    return o;
  };
  return stripTight(walkTyped(doc.toJSON() as Record<string, unknown>, doc));

  function walkTyped(j: Record<string, unknown>, node: PMNode): Record<string, unknown> {
    if (node.isTextblock && !node.type.spec.code) return walk(j, true);
    const content = (j.content as Record<string, unknown>[] | undefined) ?? [];
    const kids: Record<string, unknown>[] = [];
    node.forEach((child, _o, i) => {
      const k = walkTyped(content[i]!, child);
      if (!(k.type === 'paragraph' && !k.content)) kids.push(k);
    });
    return { ...j, content: kids.length ? kids : undefined };
  }
}

/** Apply a random edit; returns null if the edit did not apply. */
export function randomEdit(doc: PMNode, r: ReturnType<typeof rng>): PMNode | null {
  const tr = new Transform(doc);
  const blocks = textblocks(doc);
  if (!blocks.length) return null;
  const b = r.pick(blocks);
  const start = b.pos + 1;
  const len = b.node.content.size;
  const schema = doc.type.schema;
  try {
    switch (r.int(5)) {
      case 0: {
        // Insert words, sometimes with markup characters.
        const at = start + (len ? r.int(len + 1) : 0);
        const $at = tr.doc.resolve(at);
        if ($at.parent.inlineContent === false) return null;
        const word = r.next() < 0.3 ? `${r.pick(WORDS)}${r.pick(PUNCT)}${r.pick(WORDS)}` : ` ${r.pick(WORDS)} `;
        tr.insert(at, schema.text(word));
        break;
      }
      case 1: {
        if (len < 2) return null;
        const a = start + r.int(len);
        const z = Math.min(start + len, a + 1 + r.int(5));
        tr.delete(a, z);
        break;
      }
      case 2: {
        // Toggle a mark over whole words.
        const text = b.node.textContent;
        const words = [...text.matchAll(/[A-Za-z]+/g)];
        if (!words.length || b.node.childCount !== 1) return null;
        const w = r.pick(words);
        const mark = r.pick(['em', 'strong', 'code', 'strike'].filter((m) => schema.marks[m]))!;
        const from = start + w.index!;
        const to = from + w[0].length;
        if (doc.rangeHasMark(from, to, schema.marks[mark]!)) tr.removeMark(from, to, schema.marks[mark]!);
        else tr.addMark(from, to, schema.marks[mark]!.create());
        break;
      }
      case 3: {
        // Split a top-level paragraph between words.
        if (b.node.type.name !== 'paragraph' || b.node.childCount !== 1) return null;
        const text = b.node.textContent;
        const spaces = [...text.matchAll(/ (?=\w)/g)];
        if (!spaces.length) return null;
        const sp = r.pick(spaces);
        tr.delete(start + sp.index!, start + sp.index! + 1);
        tr.split(start + sp.index!);
        break;
      }
      default: {
        if (b.node.type.name === 'heading') tr.setNodeMarkup(b.pos, undefined, { ...b.node.attrs, level: 1 + r.int(6) });
        else if (b.node.type.name === 'paragraph' && tr.doc.resolve(b.pos).depth === 0 && b.node.childCount === 1 && b.node.firstChild!.isText && !b.node.firstChild!.marks.length && b.node.textContent.trim() && !b.node.textContent.includes('\n'))
          tr.setNodeMarkup(b.pos, schema.nodes.heading, { level: 2 });
        else return null;
      }
    }
    tr.doc.check();
    return tr.doc;
  } catch {
    return null;
  }
}

