// Merging two versions of a document, as a document: by blocks, then by words.
//
// The three versions are read as blocks (paragraphs, headings, lists, chunks).
// A block only one side changed takes that change; blocks changed on both sides
// are merged word by word. Where both sides changed the same words differently,
// both versions stay in the document, in a conflict block: a fenced div that
// Pandoc reads like any other, and that the editor shows with a way to choose.
//
//   :::: {.conflict}
//   ::: {.version by="Ada" commit="3f2c1e0"}
//   The samples were collected in early spring.
//   :::
//
//   ::: {.version by="Bo" commit="9a41d7b"}
//   The samples were collected over two weeks in March.
//   :::
//   ::::
//
// A block one side deleted and the other changed is kept, changed. The header
// (YAML) cannot hold a div: there, the second version of a line both changed is
// kept beside the first as a comment.
import { diff3, mergeWords, type MergeResult, type MergeSide, type ParsedDocument } from '@kuraa/kernel';

interface Block {
  /** Its source, with the blank lines after it. */
  text: string;
  /** Its source, without them: what is compared. */
  key: string;
  kind: string;
}

const attr = (v: string) => v.replace(/["\\\n]/g, '');

/** A conflict block holding both versions. */
export function conflictBlock(a: string, b: string, sides: [MergeSide, MergeSide]): string {
  const version = (text: string, s: MergeSide) =>
    `::: {.version by="${attr(s.by)}"${s.commit ? ` commit="${attr(s.commit.slice(0, 7))}"` : ''}}\n${text.trimEnd()}\n:::`;
  return `:::: {.conflict}\n${version(a, sides[0])}\n\n${version(b, sides[1])}\n::::`;
}

/** Whether a fenced div's attributes (`{.conflict}`) mark a conflict block, or one of its versions. */
export const isConflictAttrs = (attrs: string) => /(^|[\s{])\.conflict(?=[\s}]|$)/.test(attrs);
export const isVersionAttrs = (attrs: string) => /(^|[\s{])\.version(?=[\s}]|$)/.test(attrs);

/** Count the conflict blocks in a document's text. */
export function countConflicts(text: string): number {
  return (text.match(/^:{3,}\s*\{[^}\n]*\.conflict(?=[\s}])[^}\n]*\}\s*$/gm) ?? []).length;
}

/** Merge the header's YAML line by line; a line both changed keeps the second version as a comment. */
function mergeYaml(base: string, a: string, b: string, sides: [MergeSide, MergeSide]): { text: string; conflicts: number } {
  const lines = (t: string) => t.split('\n');
  let conflicts = 0;
  const out: string[] = [];
  for (const chunk of diff3(lines(base), lines(a), lines(b))) {
    if ('ok' in chunk) out.push(...chunk.ok);
    else {
      conflicts++;
      out.push(...chunk.conflict.a, ...chunk.conflict.b.map((l) => `# ${attr(sides[1].by)} wrote: ${l}`));
    }
  }
  return { text: out.join('\n'), conflicts };
}

export function createMerge(parse: (text: string) => ParsedDocument) {
  const read = (text: string): { leading: string; blocks: Block[] } => {
    const p = parse(text);
    const blocks = p.blocks.map((r, i) => {
      const t = text.slice(r.from, r.to);
      return { text: t, key: t.trimEnd(), kind: i < p.doc.childCount ? p.doc.child(i).type.name : '' };
    });
    return { leading: p.blocks.length ? text.slice(0, p.blocks[0]!.from) : text, blocks };
  };

  return function merge(baseText: string, aText: string, bText: string, sides: [MergeSide, MergeSide]): MergeResult {
    if (aText === bText) return { text: aText, conflicts: countConflicts(aText) };
    if (aText === baseText) return { text: bText, conflicts: countConflicts(bText) };
    if (bText === baseText) return { text: aText, conflicts: countConflicts(aText) };
    const base = read(baseText);
    const a = read(aText);
    const b = read(bText);
    const pieces: string[] = [];
    let yamlConflicts = 0;
    const joined = (blocks: readonly Block[]) => blocks.map((x) => x.key).join('\n\n');
    for (const chunk of diff3(base.blocks, a.blocks, b.blocks, (x, y) => x.key === y.key)) {
      if ('ok' in chunk) {
        pieces.push(...chunk.ok.map((x) => x.text));
        continue;
      }
      const { base: o, a: x, b: y } = chunk.conflict;
      // Deleted on one side, changed on the other: keep it, changed.
      if (!x.length || !y.length) {
        pieces.push(...(x.length ? x : y).map((z) => z.text));
        continue;
      }
      if (x.length === 1 && y.length === 1 && x[0]!.kind === 'front_matter' && y[0]!.kind === 'front_matter') {
        const yaml = mergeYaml(o.length === 1 ? o[0]!.key : '', x[0]!.key, y[0]!.key, sides);
        yamlConflicts += yaml.conflicts;
        pieces.push(yaml.text);
        continue;
      }
      // Changed in place on both sides (no block added or removed): merge block by block,
      // so a conflict holds only the blocks that clash.
      const groups = o.length === x.length && x.length === y.length ? o.map((_, i) => [[o[i]!], [x[i]!], [y[i]!]] as const) : [[o, x, y] as const];
      for (const [go, gx, gy] of groups) {
        if (joined(gx) === joined(gy) || joined(gy) === joined(go)) {
          pieces.push(...gx.map((z) => z.text));
          continue;
        }
        if (joined(gx) === joined(go)) {
          pieces.push(...gy.map((z) => z.text));
          continue;
        }
        const words = mergeWords(joined(go), joined(gx), joined(gy));
        pieces.push(words ?? conflictBlock(joined(gx), joined(gy), sides));
      }
    }
    let out = a.leading;
    for (const p of pieces) {
      if (out && !/\n[ \t]*\n$/.test(out)) out = `${out.replace(/\s*$/, '')}\n\n`;
      out += p;
    }
    if (/\n$/.test(aText) || /\n$/.test(bText)) out = `${out.replace(/\s*$/, '')}\n`;
    return { text: out, conflicts: countConflicts(out) + yamlConflicts };
  };
}
