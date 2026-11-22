// Spaces: files read only by an audience (docs/decisions/0066-permissions-without-a-centre.md, step 5).
//
// A space is a history of its own in this repository, on refs of its own
// (`refs/spaces/<id>/heads/<branch>`), sharing no commit with the workspace's
// branches or with another space. Its files are at their full workspace paths,
// and lie in the one working folder beside the workspace's own: the folder is
// what the spaces this device holds put together. A device holds only the
// spaces its person may read: devices serve a space's refs only to devices
// whose person may read it (peers/node.ts), so git never sends the rest.
//
// The files of the spaces are listed in this repository's own exclude file
// (.git/info/exclude, never committed or synced), so plain git sees the
// workspace's own files alone and never commits a space's file to a branch.
// Branches span spaces by name: a space without the branch checked out is read
// at its `main`.
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Git } from './git.js';

export const SPACES = 'refs/spaces/';
export const spaceRef = (id: string, branch: string) => `${SPACES}${id}/heads/${branch}`;
const BEGIN = '# kuraa: the files of spaces this device holds (written by kuraa; do not edit)';
const END = '# kuraa: end of spaces';

/** A path as an exclude line that matches it alone: anchored, with gitignore's special characters escaped. */
const excludeLine = (path: string) => `/${path.replace(/[\\*?[\]!#]/g, (c) => `\\${c}`).replace(/ $/, '\\ ')}`;

export interface SpaceChange {
  path: string;
  /** The file's bytes; null: taken away; undefined: as the working tree has it now (absent: taken away). */
  content?: Buffer | null;
}

export class Spaces {
  /** File → the space it is in, for the branch checked out. */
  private index = new Map<string, string>();
  /** Space → the ref read for the branch checked out. */
  private readFrom = new Map<string, string>();

  constructor(private readonly git: Git, private readonly dir: string, private readonly tmpDir: string) {}

  /** The space a file is in (for the branch checked out); null: the workspace's own. */
  spaceOf(path: string): string | null {
    return this.index.get(path) ?? null;
  }

  /** Every file in a space, with its space. */
  entries(): [string, string][] {
    return [...this.index];
  }

  /** The spaces this device holds. */
  ids(): string[] {
    return [...this.readFrom.keys()];
  }

  /** The ref a space is read from, for the branch checked out. */
  refOf(id: string): string | null {
    return this.readFrom.get(id) ?? null;
  }

  /** Read the spaces again (after their refs or the branch changed), and keep plain git off their files. */
  async refresh(branch: string | null): Promise<void> {
    const out = await this.git.run(['for-each-ref', '--format=%(refname)', SPACES], { allowFail: true });
    const byId = new Map<string, Set<string>>();
    for (const ref of out.stdout.split('\n').filter(Boolean)) {
      const m = /^refs\/spaces\/([0-9a-f]{32})\/heads\/(.+)$/.exec(ref);
      if (m) byId.set(m[1]!, (byId.get(m[1]!) ?? new Set()).add(m[2]!));
    }
    // A path the workspace's own branch has stays the workspace's (two with one path: the wider one shows).
    const own = new Set((await this.git.run(['ls-tree', '-r', '--name-only', '-z', 'HEAD'], { allowFail: true })).stdout.split('\0').filter(Boolean));
    const index = new Map<string, string>();
    const readFrom = new Map<string, string>();
    for (const [id, branches] of [...byId].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const b = branch && branches.has(branch) ? branch : branches.has('main') ? 'main' : [...branches].sort()[0]!;
      const ref = spaceRef(id, b);
      readFrom.set(id, ref);
      const files = (await this.git.run(['ls-tree', '-r', '--name-only', '-z', ref], { allowFail: true })).stdout.split('\0').filter(Boolean);
      for (const f of files) if (!own.has(f) && !index.has(f)) index.set(f, id);
    }
    this.index = index;
    this.readFrom = readFrom;
    await this.writeExclude();
  }

  private async writeExclude(): Promise<void> {
    const file = join(await this.git.gitDir(), 'info', 'exclude');
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch { /* none yet */ }
    const start = text.indexOf(BEGIN);
    const end = text.indexOf(END);
    const rest = start >= 0 && end > start ? text.slice(0, start) + text.slice(end + END.length).replace(/^\n/, '') : text;
    const lines = [...this.index.keys()].sort().map(excludeLine);
    const block = lines.length ? `${BEGIN}\n${lines.join('\n')}\n${END}\n` : '';
    const next = `${rest}${rest && !rest.endsWith('\n') ? '\n' : ''}${block}`;
    if (next === text) return;
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, next);
  }

  /** The tree with nothing in it. */
  private async emptyTree(): Promise<string> {
    return this.git.out(['mktree'], { input: '' });
  }

  /**
   * Commit changes to a space on a branch: a commit of its own history (the
   * first a root), signed by `sign`, its ref moved only if it is still where it
   * was. A space without the branch starts it from the one it is read from.
   * Null if nothing changed.
   */
  async commit(id: string, branch: string, changes: SpaceChange[], message: string, sign: (raw: Buffer) => Promise<Buffer>): Promise<string | null> {
    const ref = spaceRef(id, branch);
    const own = (await this.git.run(['rev-parse', '-q', '--verify', `${ref}^{commit}`], { allowFail: true })).stdout.trim();
    const from = this.readFrom.get(id);
    const tip = own || (from ? (await this.git.run(['rev-parse', '-q', '--verify', `${from}^{commit}`], { allowFail: true })).stdout.trim() : '');
    await mkdir(this.tmpDir, { recursive: true });
    const env = { GIT_INDEX_FILE: join(this.tmpDir, `space-index-${process.pid}-${randomBytes(4).toString('hex')}`) };
    let tree: string;
    try {
      await this.git.run(tip ? ['read-tree', tip] : ['read-tree', '--empty'], { env });
      const entries: string[] = [];
      for (const c of changes) {
        let bytes = c.content;
        if (bytes === undefined) bytes = await readFile(join(this.dir, c.path)).catch(() => null);
        if (bytes === null) {
          entries.push(`0 ${'0'.repeat(40)}\t${c.path}`);
          continue;
        }
        const blob = await this.git.out(['hash-object', '-w', '--stdin'], { input: bytes });
        entries.push(`100644 ${blob}\t${c.path}`);
      }
      if (entries.length) await this.git.run(['update-index', '-z', '--index-info'], { env, input: `${entries.join('\0')}\0` });
      tree = await this.git.out(['write-tree'], { env });
    } finally {
      await rm(env.GIT_INDEX_FILE, { force: true });
    }
    if (tip && tree === (await this.git.out(['rev-parse', `${tip}^{tree}`]))) return null;
    if (!tip && tree === (await this.emptyTree())) return null;
    const unsigned = await this.git.out(['commit-tree', tree, ...(tip ? ['-p', tip] : []), '-F', '-'], { input: `${message.trimEnd()}\n` });
    const raw = (await this.git.run(['cat-file', 'commit', unsigned])).bytes;
    const commit = await this.git.out(['hash-object', '-t', 'commit', '-w', '--stdin'], { input: await sign(raw) });
    await this.git.run(['update-ref', '-m', `commit: ${message.split('\n')[0]}`, ref, commit, own]);
    return commit;
  }

  /**
   * The files a space's change brings to the working tree (from `before` to
   * `after`: commits, or null for none): each written or taken away by `write`.
   */
  async changes(before: string | null, after: string): Promise<{ path: string; blob: string | null }[]> {
    const from = before ? `${before}^{tree}` : await this.emptyTree();
    const out = (await this.git.run(['diff-tree', '-r', '-z', '--no-renames', from, `${after}^{tree}`])).stdout.split('\0').filter(Boolean);
    const list: { path: string; blob: string | null }[] = [];
    for (let i = 0; i + 1 < out.length; i += 2) {
      const meta = out[i]!.split(' ');
      const status = meta[4];
      list.push({ path: out[i + 1]!, blob: status === 'D' ? null : meta[3]! });
    }
    return list;
  }
}
