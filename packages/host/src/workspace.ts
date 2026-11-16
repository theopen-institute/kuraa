// Folder-level git work a shell needs before it starts a host: is this a
// repository, whose name goes on commits, and make it one. Shells call these
// instead of running git themselves, so the host stays the only part of the
// system that touches the working tree.
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Git } from './git.js';

export interface FolderInfo {
  /** The folder, resolved. */
  dir: string;
  /** Top of the git working tree containing the folder, or null if there is none. */
  repoRoot: string | null;
  /** Entries in the folder, not counting hidden ones. */
  entries: number;
}

export async function inspectFolder(dir: string): Promise<FolderInfo> {
  dir = resolve(dir);
  const entries = (await readdir(dir)).filter((f) => !f.startsWith('.')).length;
  const top = await new Git(dir).run(['rev-parse', '--show-toplevel'], { allowFail: true });
  return { dir, repoRoot: top.code === 0 ? top.stdout.trim() : null, entries };
}

/** The git identity configured for a folder (repository, global or system); empty when unset. */
export async function gitIdentity(dir: string): Promise<{ name: string; email: string }> {
  const git = new Git(resolve(dir));
  const get = async (key: string) => (await git.run(['config', key], { allowFail: true })).stdout.trim();
  return { name: await get('user.name'), email: await get('user.email') };
}

/** Make a folder a git repository and commit what is already in it. */
export async function initWorkspace(dir: string): Promise<void> {
  dir = resolve(dir);
  const who = await gitIdentity(dir);
  const name = who.name || 'Kuraa host';
  const email = who.email || 'host@kuraa.invalid';
  const git = new Git(dir, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
  await git.run(['init', '-q']);
  await git.run(['add', '-A']);
  await git.run(['commit', '-q', '--allow-empty', '-m', 'Initialise workspace']);
}
