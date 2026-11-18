// Merging two commits without touching the working tree, the same way on every
// device (see docs/decisions/0025-merging.md).
//
// Git merges the trees (`merge-tree`); the files it cannot merge line by line
// are merged by their document type (a document by blocks, then words), which
// never fails: a conflict stays in the file with both versions. Files no type
// can merge as text (binary files) keep one version, with the other saved
// beside it. The merge commit depends only on the two commits merged: its
// parents in a fixed order, a fixed author, the later of their dates, and a
// message made from them. So two devices merging the same commits make the same
// commit, and nothing more needs merging.
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mergeLines, countMarkers, type DocumentType, type MergeSide } from '@kuraa/kernel';
import type { Git } from './git.js';

export const MERGE_AUTHOR = { name: 'Kuraa', email: 'merge@kuraa.invalid' };

export interface MergeOptions {
  /** The type that opens a file, to merge it as a document. */
  typeFor(path: string, head: string): DocumentType | undefined;
  /**
   * The text a file is to have in the merge, instead of merging it: a document
   * whose live room both sides share already holds both sides' edits.
   */
  override?(path: string): string | undefined;
  /** Somewhere to put a temporary index. */
  tmpDir: string;
}

export interface MergeOutcome {
  /** The commit to move to: one of the two if one contains the other, else the merge. */
  commit: string;
  kind: 'same' | 'fast-forward' | 'merge';
  /** Files that keep conflicts, and how many. */
  conflicts: { path: string; count: number }[];
  /** Copies saved beside files that could not be merged as text. */
  copies: string[];
}

async function isAncestor(git: Git, a: string, b: string): Promise<boolean> {
  return (await git.run(['merge-base', '--is-ancestor', a, b], { allowFail: true })).code === 0;
}

interface Stage { mode: string; oid: string }

/** Conflicted files from `merge-tree -z` output: path → stage (1 base, 2 first, 3 second). */
function parseMergeTree(out: string): { tree: string; files: Map<string, Map<number, Stage>> } {
  const fields = out.split('\0');
  const tree = fields[0]!.trim();
  const files = new Map<string, Map<number, Stage>>();
  for (const f of fields.slice(1)) {
    if (f === '') break;
    const m = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(f);
    if (!m) break;
    const stages = files.get(m[4]!) ?? new Map<number, Stage>();
    stages.set(Number(m[3]), { mode: m[1]!, oid: m[2]! });
    files.set(m[4]!, stages);
  }
  return { tree, files };
}

const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0);

/** A name beside `path` for the other version: notes.conflict-9a41d7b.pdf. */
function besideName(path: string, commit: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  const short = commit.slice(0, 7);
  return dot > slash + 1 ? `${path.slice(0, dot)}.conflict-${short}${path.slice(dot)}` : `${path}.conflict-${short}`;
}

/** Merge commits `x` and `y`, without touching the working tree or any branch. */
export async function mergeCommits(git: Git, x: string, y: string, opts: MergeOptions): Promise<MergeOutcome> {
  const none = { conflicts: [], copies: [] };
  if (x === y) return { commit: x, kind: 'same', ...none };
  if (await isAncestor(git, y, x)) return { commit: x, kind: 'same', ...none };
  if (await isAncestor(git, x, y)) return { commit: y, kind: 'fast-forward', ...none };
  // The same order everywhere: the first side is the lower commit id.
  const [c1, c2] = [x, y].sort() as [string, string];
  const r = await git.run(['merge-tree', '--write-tree', '-z', c1, c2], { allowFail: true });
  if (r.code !== 0 && r.code !== 1) throw new Error(`git merge-tree failed: ${r.stderr}`);
  const { tree, files } = parseMergeTree(r.stdout);

  const info = async (c: string) => (await git.out(['show', '-s', '--format=%an%x00%ct', c])).split('\0');
  const [[by1, t1], [by2, t2]] = await Promise.all([info(c1), info(c2)]);
  const sides: [MergeSide, MergeSide] = [{ by: by1!, commit: c1 }, { by: by2!, commit: c2 }];
  const blob = async (s?: Stage) => (s ? (await git.run(['cat-file', 'blob', s.oid])).bytes : null);

  const entries: string[] = [];
  const conflicts: { path: string; count: number }[] = [];
  const copies: string[] = [];
  const write = (content: Buffer | string) => git.out(['hash-object', '-w', '--stdin'], { input: content });
  for (const [path, stages] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const s1 = stages.get(1);
    const s2 = stages.get(2);
    const s3 = stages.get(3);
    const mode = (s2 ?? s3)?.mode ?? '100644';
    if (!s2 && !s3) continue;
    const override = opts.override?.(path);
    if (override !== undefined) {
      entries.push(`${mode} ${await write(override)} 0\t${path}`);
      continue;
    }
    // Changed on one side, deleted on the other: keep it, changed.
    if (!s2 || !s3) {
      entries.push(`${mode} ${(s2 ?? s3)!.oid} 0\t${path}`);
      continue;
    }
    const [b1, b2, b3] = await Promise.all([blob(s1), blob(s2), blob(s3)]);
    if (mode !== '100644' && mode !== '100755') {
      // A link or submodule: keep the first.
      entries.push(`${mode} ${s2.oid} 0\t${path}`);
      continue;
    }
    if (isBinary(b2!) || isBinary(b3!) || (b1 && isBinary(b1))) {
      const beside = besideName(path, c2);
      entries.push(`${mode} ${s2.oid} 0\t${path}`, `${mode} ${s3.oid} 0\t${beside}`);
      copies.push(beside);
      continue;
    }
    const [base, a, b] = [b1?.toString('utf8') ?? '', b2!.toString('utf8'), b3!.toString('utf8')];
    const type = opts.typeFor(path, a.slice(0, 256));
    const merged = type?.merge ? type.merge(base, a, b, sides) : mergeLines(base, a, b, sides);
    if (merged.conflicts > 0) conflicts.push({ path, count: merged.conflicts });
    entries.push(`${mode} ${await write(merged.text)} 0\t${path}`);
  }

  let finalTree = tree;
  if (entries.length) {
    await mkdir(opts.tmpDir, { recursive: true });
    const index = join(opts.tmpDir, `merge-index-${process.pid}-${randomBytes(4).toString('hex')}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await git.run(['read-tree', tree], { env });
      await git.run(['update-index', '--index-info'], { env, input: `${entries.join('\n')}\n` });
      finalTree = await git.out(['write-tree'], { env });
    } finally {
      await rm(index, { force: true });
    }
  }
  const at = `@${Math.max(Number(t1), Number(t2))} +0000`;
  const lines = [`Merge ${c1.slice(0, 7)} and ${c2.slice(0, 7)}`];
  if (conflicts.length || copies.length) {
    lines.push('');
    for (const c of conflicts) lines.push(`Conflict kept in ${c.path} (${c.count})`);
    for (const c of copies) lines.push(`Other version saved as ${c}`);
  }
  const commit = await git.out(['commit-tree', '--no-gpg-sign', finalTree, '-p', c1, '-p', c2, '-m', lines.join('\n')], {
    env: {
      GIT_AUTHOR_NAME: MERGE_AUTHOR.name, GIT_AUTHOR_EMAIL: MERGE_AUTHOR.email, GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_NAME: MERGE_AUTHOR.name, GIT_COMMITTER_EMAIL: MERGE_AUTHOR.email, GIT_COMMITTER_DATE: at,
    },
  });
  return { commit, kind: 'merge', conflicts, copies };
}

/** How many conflicts a file's text keeps, as its type counts them. */
export function conflictsIn(text: string, type: DocumentType | undefined): number {
  return type?.conflicts ? type.conflicts(text) : countMarkers(text);
}
