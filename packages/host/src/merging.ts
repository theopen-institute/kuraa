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
import { isUtf8 } from 'node:buffer';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { mergeLines, countMarkers, type DocumentType, type MergeSide } from '@kuraa/kernel';
import type { Git } from './git.js';

export const MERGE_AUTHOR = { name: 'Kuraa', email: 'merge@kuraa.invalid' };

/**
 * Bumped whenever merging two commits can give another result than before:
 * here, in git's part of it, or in the kernel's line and word merges. (A
 * type's own merge is covered by its version.)
 */
export const MERGE_VERSION = 2;

/**
 * How this device merges, as a short text devices compare: the merge version,
 * and the types that merge files their own way, at their versions. Devices
 * whose signatures differ could merge the same commits differently, so between
 * them only one makes merges (see peers.ts).
 */
export function mergeSignature(types: DocumentType[]): string {
  return [`merge@${MERGE_VERSION}`, ...types.filter((t) => t.merge).map((t) => `${t.id}@${t.version}`).sort()].join(' ');
}

export interface MergeOptions {
  /** The type that opens a file, to merge it as a document. */
  typeFor(path: string, head: string): DocumentType | undefined;
  /**
   * The text a file is to have in the merge, instead of merging it: a document
   * whose live room both sides share already holds both sides' edits.
   */
  override?(path: string): string | undefined;
  /**
   * Files this device does not accept the other side's changes to
   * (peers/accept.ts): they keep the first commit's (`x`'s) version, and the merge
   * says so. The other side's history still comes in. Then even work that
   * would fast-forward is merged, so what is kept stays.
   */
  keep?(path: string): boolean;
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
  /** Files kept as they were here, the other side's changes to them declined (MergeOptions.keep). */
  kept?: string[];
}

export async function isAncestor(git: Git, a: string, b: string): Promise<boolean> {
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

/** Not text the host can merge: a NUL early on, or not UTF-8 (a Latin-1 .bib would be corrupted as text). */
const isBinary = (b: Buffer) => b.subarray(0, 8000).includes(0) || !isUtf8(b);

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
  // Files the other side changed that this device keeps as they are here.
  const declined = opts.keep ? await changedSince(git, x, y).then((paths) => paths.filter((p) => opts.keep!(p))) : [];
  if (await isAncestor(git, x, y)) {
    if (!declined.length) return { commit: y, kind: 'fast-forward', ...none };
    return keepMerge(git, x, y, declined, opts);
  }
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
  // By code unit, never by locale: the order reaches the commit message, which must be the same on every device.
  for (const [path, stages] of [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
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

  // Declined: this side's version, whatever the merge made of it (or none, if this side has none).
  for (const path of declined) {
    const own = await treeEntry(git, x, path);
    entries.push(own ? `${own.mode} ${own.oid} 0\t${path}` : `0 ${'0'.repeat(x.length)}\t${path}`);
    const c = conflicts.findIndex((k) => k.path === path);
    if (c >= 0) conflicts.splice(c, 1);
  }
  let finalTree = tree;
  if (entries.length) {
    await mkdir(opts.tmpDir, { recursive: true });
    const index = join(opts.tmpDir, `merge-index-${process.pid}-${randomBytes(4).toString('hex')}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      await git.run(['read-tree', tree], { env });
      // NUL-separated: a path may hold a newline.
      await git.run(['update-index', '-z', '--index-info'], { env, input: `${entries.join('\0')}\0` });
      finalTree = await git.out(['write-tree'], { env });
    } finally {
      await rm(index, { force: true });
    }
  }
  const at = `@${Math.max(Number(t1), Number(t2))} +0000`;
  const lines = [`Merge ${c1.slice(0, 7)} and ${c2.slice(0, 7)}`];
  if (conflicts.length || copies.length || declined.length) {
    lines.push('');
    for (const c of conflicts) lines.push(`Conflict kept in ${c.path} (${c.count})`);
    for (const c of copies) lines.push(`Other version saved as ${c}`);
    for (const p of declined) lines.push(`Kept this version of ${p}`);
  }
  const commit = await git.out(['commit-tree', '--no-gpg-sign', finalTree, '-p', c1, '-p', c2, '-m', lines.join('\n')], {
    env: {
      GIT_AUTHOR_NAME: MERGE_AUTHOR.name, GIT_AUTHOR_EMAIL: MERGE_AUTHOR.email, GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_NAME: MERGE_AUTHOR.name, GIT_COMMITTER_EMAIL: MERGE_AUTHOR.email, GIT_COMMITTER_DATE: at,
    },
  });
  return { commit, kind: 'merge', conflicts, copies, ...(declined.length ? { kept: declined } : {}) };
}

/** Files changed from where `x` and `y` meet to `y`: the other side's changes. */
async function changedSince(git: Git, x: string, y: string): Promise<string[]> {
  const base = (await git.run(['merge-base', x, y], { allowFail: true })).stdout.trim();
  const r = await git.run(['diff', '--name-only', '--no-renames', '-z', ...(base ? [base] : ['--root']), y], { allowFail: true });
  return r.stdout.split('\0').filter(Boolean);
}

/** A file's entry in a commit's tree, or null if it has none there. */
async function treeEntry(git: Git, commit: string, path: string): Promise<{ mode: string; oid: string } | null> {
  const r = await git.run(['ls-tree', '-z', commit, '--', path], { allowFail: true });
  const m = /^(\d+) \w+ ([0-9a-f]+)\t/.exec(r.stdout);
  return m ? { mode: m[1]!, oid: m[2]! } : null;
}

/**
 * The other side's work came on top of this side's, but some of it is declined:
 * a merge of the two that has their tree, with this side's version of those files.
 */
async function keepMerge(git: Git, x: string, y: string, declined: string[], opts: MergeOptions): Promise<MergeOutcome> {
  const entries: string[] = [];
  for (const path of declined) {
    const own = await treeEntry(git, x, path);
    entries.push(own ? `${own.mode} ${own.oid} 0\t${path}` : `0 ${'0'.repeat(x.length)}\t${path}`);
  }
  await mkdir(opts.tmpDir, { recursive: true });
  const index = join(opts.tmpDir, `merge-index-${process.pid}-${randomBytes(4).toString('hex')}`);
  const env = { GIT_INDEX_FILE: index };
  let tree: string;
  try {
    await git.run(['read-tree', `${y}^{tree}`], { env });
    await git.run(['update-index', '-z', '--index-info'], { env, input: `${entries.join('\0')}\0` });
    tree = await git.out(['write-tree'], { env });
  } finally {
    await rm(index, { force: true });
  }
  const [c1, c2] = [x, y].sort() as [string, string];
  const time = await git.out(['show', '-s', '--format=%ct', y]);
  const at = `@${time} +0000`;
  const message = [`Merge ${c1.slice(0, 7)} and ${c2.slice(0, 7)}`, '', ...declined.map((p) => `Kept this version of ${p}`)].join('\n');
  const commit = await git.out(['commit-tree', '--no-gpg-sign', tree, '-p', c1, '-p', c2, '-m', message], {
    env: {
      GIT_AUTHOR_NAME: MERGE_AUTHOR.name, GIT_AUTHOR_EMAIL: MERGE_AUTHOR.email, GIT_AUTHOR_DATE: at,
      GIT_COMMITTER_NAME: MERGE_AUTHOR.name, GIT_COMMITTER_EMAIL: MERGE_AUTHOR.email, GIT_COMMITTER_DATE: at,
    },
  });
  return { commit, kind: 'merge', conflicts: [], copies: [], kept: declined };
}

/** How many conflicts a file's text keeps, as its type counts them. */
export function conflictsIn(text: string, type: DocumentType | undefined): number {
  return type?.conflicts ? type.conflicts(text) : countMarkers(text);
}
