// Folder-level git work a shell needs before it starts a host: is this a
// repository, whose name goes on commits, and make it one. Shells call these
// instead of running git themselves, so the host stays the only part of the
// system that touches the working tree.
import { readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { readWorkspaceFile, writeWorkspaceFile } from '@kuraa/run-kit';
import { Git } from './git.js';

/**
 * Where a workspace keeps its name, the same on every device (decision 0061): a
 * file in the repository, so a rename is a commit that syncs like any other, and
 * history says who named it what. One line of JSON, so that two renames at once
 * conflict on that one line.
 */
export const NAME_FILE = '.kuraa/workspace.json';

/** The longest name a workspace may have. */
export const MAX_NAME = 100;

/** A name as it is kept: spaces at the ends gone, runs of space made one. Throws if it is empty or too long. */
export function cleanName(raw: unknown): string {
  const name = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new Error('A workspace needs a name');
  if (name.length > MAX_NAME) throw new Error(`A workspace's name is at most ${MAX_NAME} characters`);
  return name;
}

/** The name file's text for a name. */
export const nameText = (name: string): string => `${JSON.stringify({ name })}\n`;

/** Conflict markers git leaves in a line merge: <<<<<<<, |||||||, =======, >>>>>>>. */
const MARKER = /^(<{7}|\|{7}|={7}|>{7})( |$)/;

/**
 * The name in a name file's text, or null if there is none. Two renames at once
 * leave both in the file, between conflict markers: the first is taken. The
 * merge is the same commit on every device (merging.ts), so every device takes
 * the same one, until someone renames it again.
 */
export function parseName(text: string): string | null {
  for (const line of text.split('\n')) {
    if (!line.trim() || MARKER.test(line)) continue;
    try {
      const v = JSON.parse(line) as { name?: unknown };
      if (v && typeof v.name === 'string' && v.name.trim()) return v.name.replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
    } catch {
      // Not a line of the file as the app writes it: the next may be.
    }
  }
  return null;
}

/** A workspace's name, from its working tree; null where none is set (a workspace made before 0061, or a folder opened), or it is a link (0037). */
export async function readWorkspaceName(dir: string): Promise<string | null> {
  try {
    return parseName((await readWorkspaceFile(dir, NAME_FILE)).toString('utf8'));
  } catch {
    return null;
  }
}

/** Write a workspace's name file (not committed); refused if it, or .kuraa, is a link (0037). */
export async function writeWorkspaceName(dir: string, name: string): Promise<void> {
  await writeWorkspaceFile(dir, NAME_FILE, nameText(name));
}

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
  // Resolved: git gives C:/Users/… on Windows, which compares unequal to C:\Users\….
  return { dir, repoRoot: top.code === 0 ? resolve(top.stdout.trim()) : null, entries };
}

/** The git identity configured for a folder (repository, global or system); empty when unset. */
export async function gitIdentity(dir: string): Promise<{ name: string; email: string }> {
  const git = new Git(resolve(dir));
  const get = async (key: string) => (await git.run(['config', key], { allowFail: true })).stdout.trim();
  return { name: await get('user.name'), email: await get('user.email') };
}

/** Make a folder a git repository and commit what is already in it, with its name (`workspaceName`: the workspace is named by whoever makes it, 0061). */
export async function initWorkspace(dir: string, workspaceName?: string): Promise<void> {
  dir = resolve(dir);
  if (workspaceName) await writeWorkspaceName(dir, cleanName(workspaceName));
  const who = await gitIdentity(dir);
  const name = who.name || 'Kuraa host';
  const email = who.email || 'host@kuraa.invalid';
  const git = new Git(dir, { GIT_AUTHOR_NAME: name, GIT_AUTHOR_EMAIL: email, GIT_COMMITTER_NAME: name, GIT_COMMITTER_EMAIL: email });
  // The branch git is set to start with, else main (not git's own old default).
  const branch = (await git.run(['config', '--get', 'init.defaultBranch'], { allowFail: true })).stdout.trim() || 'main';
  await git.run(['init', '-q', `--initial-branch=${branch}`]);
  await git.run(['add', '-A']);
  await git.run(['commit', '-q', '--allow-empty', '-m', 'Initialise workspace']);
}
