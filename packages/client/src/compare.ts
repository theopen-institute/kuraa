// Comparing a past version of a document with the document now, as people read
// it: block by block (paragraphs, headings, chunks), as merges see documents
// (the kernel's matching), then word by word inside a block that changed.
// Unchanged stretches are folded, leaving a block of context on each side.
import { matches, wordTokens } from '@kuraa/kernel';

export interface Piece {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

export type CompareBlock =
  | { kind: 'same' | 'added' | 'removed'; text: string }
  /** A block that changed: its words, kept, added and removed. */
  | { kind: 'changed'; words: Piece[] }
  /** Unchanged blocks folded away. */
  | { kind: 'folded'; count: number };

export interface Comparison {
  blocks: CompareBlock[];
  /** How many blocks were added, removed or changed. */
  changes: number;
}

/** Below this share of words in common, two blocks are shown as one removed and one added, not as one changed. */
const SIMILAR = 0.3;
/** Unchanged blocks shown on each side of a change. */
const CONTEXT = 1;

/** The words of two versions of a block, as pieces. */
export function compareWords(before: string, after: string): Piece[] {
  const a = wordTokens(before);
  const b = wordTokens(after);
  const m = matches(a, b, (x, y) => x === y);
  const out: Piece[] = [];
  const push = (kind: Piece['kind'], text: string) => {
    const last = out[out.length - 1];
    if (last?.kind === kind) last.text += text;
    else out.push({ kind, text });
  };
  let j = 0;
  for (let i = 0; i < a.length; i++) {
    const at = m[i]!;
    if (at < 0) {
      push('removed', a[i]!);
      continue;
    }
    while (j < at) push('added', b[j++]!);
    push('same', a[i]!);
    j = at + 1;
  }
  while (j < b.length) push('added', b[j++]!);
  return out;
}

/** The share of two blocks' words they have in common (0 to 1). */
function similarity(before: string, after: string): number {
  const a = wordTokens(before);
  const b = wordTokens(after);
  if (!a.length && !b.length) return 1;
  const common = matches(a, b, (x, y) => x.trim() === y.trim()).filter((x) => x >= 0).length;
  return (2 * common) / (a.length + b.length);
}

/**
 * Compare two versions of a text, given how to split one into blocks (a
 * document type's top-level blocks; paragraphs if none is given).
 */
export function compareTexts(before: string, after: string, blocksOf: (text: string) => string[] = paragraphs): Comparison {
  const a = blocksOf(before);
  const b = blocksOf(after);
  const m = matches(a, b, (x, y) => x === y);
  const all: CompareBlock[] = [];
  let changes = 0;
  const gap = (removed: string[], added: string[]) => {
    for (let k = 0; k < Math.max(removed.length, added.length); k++) {
      const r = removed[k];
      const n = added[k];
      changes++;
      if (r !== undefined && n !== undefined && similarity(r, n) >= SIMILAR) all.push({ kind: 'changed', words: compareWords(r, n) });
      else {
        if (r !== undefined) all.push({ kind: 'removed', text: r });
        if (n !== undefined) all.push({ kind: 'added', text: n });
        if (r !== undefined && n !== undefined) changes++;
      }
    }
  };
  let j = 0;
  let removed: string[] = [];
  for (let i = 0; i < a.length; i++) {
    const at = m[i]!;
    if (at < 0) {
      removed.push(a[i]!);
      continue;
    }
    gap(removed, b.slice(j, at));
    removed = [];
    all.push({ kind: 'same', text: a[i]! });
    j = at + 1;
  }
  gap(removed, b.slice(j));
  return { blocks: fold(all), changes };
}

/** Fold runs of unchanged blocks, keeping CONTEXT blocks next to each change. */
function fold(blocks: CompareBlock[]): CompareBlock[] {
  const near = blocks.map((_, i) => blocks.slice(Math.max(0, i - CONTEXT), i + CONTEXT + 1).some((x) => x.kind !== 'same'));
  const out: CompareBlock[] = [];
  blocks.forEach((x, i) => {
    if (x.kind !== 'same' || near[i]) return void out.push(x);
    const last = out[out.length - 1];
    if (last?.kind === 'folded') last.count++;
    else out.push({ kind: 'folded', count: 1 });
  });
  return out;
}

/** Paragraphs: text between blank lines. */
export function paragraphs(text: string): string[] {
  return text.split(/\n[ \t]*\n+/).map((p) => p.trim()).filter(Boolean);
}

/** A document type's top-level blocks, as text, without the blank lines after them. */
export function blocksFrom(parse: (text: string) => { text: string; blocks: { from: number; to: number }[] }): (text: string) => string[] {
  return (text) => {
    const parsed = parse(text);
    if (!parsed.blocks.length) return paragraphs(text);
    return parsed.blocks.map((b) => parsed.text.slice(b.from, b.to).replace(/\s+$/, '')).filter(Boolean);
  };
}
