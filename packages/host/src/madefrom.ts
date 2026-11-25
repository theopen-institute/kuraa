// What an output was made from (docs/decisions/0081-what-outputs-were-made-from.md).
//
// A run or a render reads files from several histories at once: the
// workspace's own branch, and each space its code may read (0066). No one
// commit says which versions of them went together, so each output records
// it: the commit of each history, and the files it could read that differed
// from them. From that the files can be put together again, as they were,
// into one tree (never kept on a ref: it holds every space it was made from).
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { MadeFrom } from '@kuraa/session/server';
import type { Git } from './git.js';

export type { MadeFrom };

/** The most files with changes not yet committed that are named; the rest are counted. */
const NAMED = 50;
const HASH = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
const SPACE = /^[0-9a-f]{32}$/;

/** A space code could read, as this device holds it: the ref it is read from, and the files of it the folder shows. */
export interface ReadableSpace {
  id: string;
  ref: string;
  files: string[];
}

/** What code reading the workspace now reads: the commits, and the files that differ from them. */
export async function madeFrom(git: Git, dir: string, spaces: ReadableSpace[]): Promise<MadeFrom> {
  const verify = async (ref: string) => (await git.run(['rev-parse', '-q', '--verify', `${ref}^{commit}`], { allowFail: true })).stdout.trim() || null;
  const commit = await verify('HEAD');
  const changed: string[] = [];
  // The workspace's own files: edited, new (untracked) or taken away. Ignored files are no one's, and spaces'
  // files are kept from plain git (spaces.ts): neither is listed. No lock taken: the host's own git goes on.
  const st = await git.run(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], { allowFail: true });
  if (st.code === 0) for (const entry of st.stdout.split('\0')) if (entry.length > 3) changed.push(entry.slice(3));
  const out: MadeFrom['spaces'] = [];
  for (const space of [...spaces].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const tip = await verify(space.ref);
    if (!tip) continue;
    out.push({ id: space.id, commit: tip });
    if (!space.files.length) continue;
    const blobs = new Map<string, string>();
    for (const line of (await git.run(['ls-tree', '-r', '-z', tip], { allowFail: true })).stdout.split('\0')) {
      const tab = line.indexOf('\t');
      if (tab > 0) blobs.set(line.slice(tab + 1), line.slice(0, tab).split(' ')[2]!);
    }
    const there = space.files.filter((f) => existsSync(join(dir, f)));
    for (const f of space.files) if (!there.includes(f)) changed.push(f);
    if (!there.length) continue;
    const hashes = (await git.run(['hash-object', '--no-filters', '--stdin-paths'], { input: `${there.join('\n')}\n`, allowFail: true })).stdout.split('\n');
    there.forEach((f, i) => {
      if (hashes[i] !== blobs.get(f)) changed.push(f);
    });
  }
  const sorted = [...new Set(changed)].sort();
  return { commit, spaces: out, uncommitted: sorted.slice(0, NAMED), ...(sorted.length > NAMED ? { more: sorted.length - NAMED } : {}) };
}

/** A record read back (from a file, or another device): its shape checked, or null. */
export function checkMadeFrom(v: unknown): MadeFrom | null {
  if (!v || typeof v !== 'object') return null;
  const m = v as Record<string, unknown>;
  if (m.commit !== null && !(typeof m.commit === 'string' && HASH.test(m.commit))) return null;
  if (!Array.isArray(m.spaces) || !Array.isArray(m.uncommitted)) return null;
  const spaces: MadeFrom['spaces'] = [];
  for (const s of m.spaces as Record<string, unknown>[]) {
    if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !SPACE.test(s.id) || typeof s.commit !== 'string' || !HASH.test(s.commit)) return null;
    spaces.push({ id: s.id, commit: s.commit });
  }
  const uncommitted = (m.uncommitted as unknown[]).filter((p): p is string => typeof p === 'string');
  if (uncommitted.length !== m.uncommitted.length || uncommitted.length > NAMED) return null;
  const more = typeof m.more === 'number' && Number.isInteger(m.more) && m.more > 0 ? m.more : undefined;
  return { commit: m.commit as string | null, spaces, uncommitted, ...(more ? { more } : {}) };
}

/** Why the files an output was made from cannot be put together again (a commit no longer here), or null. */
export async function missingFrom(git: Git, made: MadeFrom): Promise<string | null> {
  for (const c of [made.commit, ...made.spaces.map((s) => s.commit)]) {
    if (c && (await git.run(['cat-file', '-e', `${c}^{commit}`], { allowFail: true })).code !== 0) return c;
  }
  return null;
}

/**
 * The files an output was made from, put together into one tree: the workspace's at its commit, then each
 * space's at its own (a path the workspace has stays the workspace's, as the folder shows it: spaces.ts).
 * The tree is never put on a ref: it holds every space it was made from.
 */
export async function putTogether(git: Git, made: MadeFrom, tmpDir: string): Promise<string> {
  await mkdir(tmpDir, { recursive: true });
  const env = { GIT_INDEX_FILE: join(tmpDir, `made-from-${process.pid}-${randomBytes(4).toString('hex')}`) };
  try {
    await git.run(made.commit ? ['read-tree', made.commit] : ['read-tree', '--empty'], { env });
    const present = new Set((await git.run(['ls-files', '-z'], { env })).stdout.split('\0').filter(Boolean));
    for (const space of made.spaces) {
      const entries: string[] = [];
      for (const line of (await git.run(['ls-tree', '-r', '-z', space.commit])).stdout.split('\0')) {
        const tab = line.indexOf('\t');
        if (tab < 0) continue;
        const path = line.slice(tab + 1);
        if (present.has(path)) continue;
        const [mode, , blob] = line.slice(0, tab).split(' ');
        entries.push(`${mode} ${blob}\t${path}`);
        present.add(path);
      }
      if (entries.length) await git.run(['update-index', '-z', '--add', '--index-info'], { env, input: `${entries.join('\0')}\0` });
    }
    return await git.out(['write-tree'], { env });
  } finally {
    await rm(env.GIT_INDEX_FILE, { force: true });
  }
}

/** A tree as a zip, its files under one folder (`name/`). */
export async function zipOf(git: Git, tree: string, name: string): Promise<Buffer> {
  return (await git.run(['archive', '--format=zip', `--prefix=${name}/`, tree])).bytes;
}
