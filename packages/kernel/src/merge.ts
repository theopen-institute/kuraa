// Three-way merging, for any sequence: lines, words, a document's blocks.
//
// Given a common base and two versions made from it, a merge takes every change
// that only one side made, takes a change both sides made alike once, and
// reports a conflict where both changed the same part differently. Which side
// is "a" and which "b" matters only for the order of a conflict's two versions:
// callers that need the same result everywhere put the sides in a fixed order.

/** A stretch of the merged sequence: settled, or the two versions of a conflict (and their base). */
export type MergeChunk<T> = { ok: T[] } | { conflict: { base: T[]; a: T[]; b: T[] } };

/**
 * Above this many cells, the table of common subsequences (four bytes a cell)
 * would take too much memory and time: the middle is matched by Myers' method
 * instead, which needs time and memory in proportion to the edits.
 */
const TABLE_LIMIT = 4_000_000;
/** Beyond this many edits in a middle too large for the table, it is left unmatched (wholly changed). */
const MAX_EDITS = 2_000;

/** For each item of `base`, the index of the item it is matched with in `other` (a longest common subsequence), or -1. */
export function matches<T>(base: readonly T[], other: readonly T[], eq: (x: T, y: T) => boolean): number[] {
  const out = new Array<number>(base.length).fill(-1);
  // Equal ends need no table.
  let pre = 0;
  while (pre < base.length && pre < other.length && eq(base[pre]!, other[pre]!)) out[pre] = pre++;
  let suf = 0;
  while (suf < base.length - pre && suf < other.length - pre && eq(base[base.length - 1 - suf]!, other[other.length - 1 - suf]!)) {
    out[base.length - 1 - suf] = other.length - 1 - suf;
    suf++;
  }
  const n = base.length - pre - suf;
  const m = other.length - pre - suf;
  if (n === 0 || m === 0) return out;
  const same = (i: number, j: number) => eq(base[pre + i]!, other[pre + j]!);
  if (n * m > TABLE_LIMIT) {
    myers(n, m, same, (i, j) => (out[pre + i] = pre + j));
    return out;
  }
  // Lengths of common subsequences of the suffixes, row by row.
  const w = m + 1;
  const table = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * w + j] = same(i, j) ? table[(i + 1) * w + j + 1]! + 1 : Math.max(table[(i + 1) * w + j]!, table[i * w + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (same(i, j)) {
      out[pre + i] = pre + j;
      i++;
      j++;
    } else if (table[(i + 1) * w + j]! >= table[i * w + j + 1]!) i++;
    else j++;
  }
  return out;
}

/**
 * A longest common subsequence of two sequences of lengths `n` and `m`, by
 * Myers' O((n+m)·D) method: `match` is called for each matched pair, from the
 * end. With more than MAX_EDITS edits, nothing is matched.
 */
function myers(n: number, m: number, eq: (i: number, j: number) => boolean, match: (i: number, j: number) => void): void {
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  // v[off + k]: the furthest x reached on diagonal k = x - y.
  const v = new Int32Array(2 * max + 3);
  // The diagonals before each round d, from -d to d: to walk back along.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1]! < v[off + k + 1]!) ? v[off + k + 1]! : v[off + k - 1]! + 1;
      let y = x - k;
      while (x < n && y < m && eq(x, y)) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x < n || y < m) continue;
      for (let e = d; e > 0; e--) {
        const at = (kk: number) => trace[e]![kk + e]!;
        const kk = x - y;
        const prev = kk === -e || (kk !== e && at(kk - 1) < at(kk + 1)) ? kk + 1 : kk - 1;
        const px = at(prev);
        const py = px - prev;
        while (x > px && y > py) match(--x, --y);
        x = px;
        y = py;
      }
      while (x > 0 && y > 0) match(--x, --y);
      return;
    }
  }
}

const same = <T>(x: readonly T[], y: readonly T[], eq: (x: T, y: T) => boolean) => x.length === y.length && x.every((v, i) => eq(v, y[i]!));

/** Merge two versions of `base`, chunk by chunk (diff3). */
export function diff3<T>(base: readonly T[], a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = Object.is): MergeChunk<T>[] {
  const ma = matches(base, a, eq);
  const mb = matches(base, b, eq);
  const out: MergeChunk<T>[] = [];
  const push = (items: T[]) => {
    if (!items.length) return;
    const last = out[out.length - 1];
    // Item by item: spreading a long run as arguments would overflow the stack.
    if (last && 'ok' in last) for (const x of items) last.ok.push(x);
    else out.push({ ok: items });
  };
  const settle = (o: T[], x: T[], y: T[]) => {
    if (same(x, o, eq)) push(y);
    else if (same(y, o, eq)) push(x);
    else if (same(x, y, eq)) push(x);
    else out.push({ conflict: { base: o, a: x, b: y } });
  };
  let io = 0;
  let ia = 0;
  let ib = 0;
  for (;;) {
    let i = io;
    while (i < base.length && !(ma[i]! >= ia && mb[i]! >= ib)) i++;
    if (i === base.length) {
      settle(base.slice(io), a.slice(ia), b.slice(ib));
      break;
    }
    if (i > io || ma[i]! > ia || mb[i]! > ib) settle(base.slice(io, i), a.slice(ia, ma[i]), b.slice(ib, mb[i]));
    let j = i;
    while (j < base.length && ma[j] === ma[i]! + (j - i) && mb[j] === mb[i]! + (j - i)) j++;
    push(base.slice(i, j));
    ia = ma[i]! + (j - i);
    ib = mb[i]! + (j - i);
    io = j;
  }
  return out;
}

/** Who made a version, to label it in a conflict. */
export interface MergeSide {
  /** A name: a person, or a device. */
  by: string;
  /** The commit it came from, if any. */
  commit?: string;
}

export interface MergeResult {
  text: string;
  /** How many conflicts the text keeps (each with both versions). */
  conflicts: number;
}

const splitLines = (text: string) => text.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const label = (s: MergeSide) => (s.commit ? `${s.by} (${s.commit.slice(0, 7)})` : s.by);

/**
 * Merge text line by line, as git does: a conflict keeps both versions between
 * markers (<<<<<<< ======= >>>>>>>), for files people read as code.
 */
export function mergeLines(base: string, a: string, b: string, sides: [MergeSide, MergeSide]): MergeResult {
  let conflicts = 0;
  let text = '';
  const ensureEol = (s: string) => (s && !s.endsWith('\n') ? `${s}\n` : s);
  for (const chunk of diff3(splitLines(base), splitLines(a), splitLines(b))) {
    if ('ok' in chunk) text += chunk.ok.join('');
    else {
      conflicts++;
      text += `${text && !text.endsWith('\n') ? '\n' : ''}<<<<<<< ${label(sides[0])}\n${ensureEol(chunk.conflict.a.join(''))}=======\n${ensureEol(chunk.conflict.b.join(''))}>>>>>>> ${label(sides[1])}\n`;
    }
  }
  return { text, conflicts };
}

/** How many conflicts git-style markers mark in a text. */
export const countMarkers = (text: string): number => (text.match(/^<<<<<<< /gm) ?? []).length;

/**
 * Words and single other characters, each with the space after it: what prose
 * is merged by. Keeping the space with the word puts two insertions at the same
 * place in the same gap, so they meet as a conflict instead of interleaving.
 */
export const wordTokens = (text: string): string[] => text.match(/^\s+|[\p{L}\p{N}_'’-]+\s*|[^\s]\s*/gu) ?? [];

/** Merge text word by word; null if both sides changed the same words differently. */
export function mergeWords(base: string, a: string, b: string): string | null {
  let out = '';
  for (const chunk of diff3(wordTokens(base), wordTokens(a), wordTokens(b))) {
    if ('conflict' in chunk) return null;
    out += chunk.ok.join('');
  }
  return out;
}
