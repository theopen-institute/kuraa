// Git, called as a child process: the one on PATH, or one a shell bundles (useGit).
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';

export interface GitResult { stdout: string; stderr: string; code: number; /** stdout as bytes (a blob may not be text). */ bytes: Buffer }

export interface GitRunOptions {
  input?: string | Buffer;
  allowFail?: boolean;
  env?: Record<string, string>;
  /** Stopped after this long, whatever it is doing. */
  timeoutMs?: number;
  /** Stopped once it has said nothing for this long (a long fetch that is still going, is not). */
  idleMs?: number;
  /** What it writes to stderr, as it comes (a fetch's --progress). */
  onStderr?(chunk: string): void;
}

// Git runs in its own process group, so Ctrl+C in the host's terminal (which goes
// to the whole foreground group) cannot kill a commit half-way. The host stops
// on that signal by finishing its git work first. (Not on Windows, where a
// detached child would get its own console window.)
const OWN_GROUP = process.platform !== 'win32';
/** git's word for a config file another writer holds (`.git/config.lock`): nothing was written. */
const CONFIG_LOCKED = /could not lock config file/;
/** How long a change to a locked config is tried again for. */
const CONFIG_LOCK_WAIT_MS = 2000;

/** The git to run, and what it needs in its environment. */
let program: { command: string; env: Record<string, string> } = { command: 'git', env: {} };

/**
 * Run this git instead of the one on PATH, with these environment variables
 * (GIT_EXEC_PATH and the like). The desktop app ships its own, so every device
 * runs the same git and nobody needs to install one. Set it before starting hosts.
 */
export function useGit(command: string, env: Record<string, string> = {}): void {
  program = { command, env };
}

/** The PATH git sees, with `dir` first (where git finds `git-remote-kuraa`). */
export function gitPath(dir: string): string {
  return [dir, program.env.PATH ?? process.env.PATH ?? ''].join(delimiter);
}

/**
 * An environment for git: the process's, then the git's own, then `layers`.
 * On Windows variable names ignore case, so a PATH replaces a Path rather than sitting beside it.
 */
export function gitEnv(...layers: (Record<string, string> | undefined)[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const layer of [program.env, ...layers]) {
    for (const [k, v] of Object.entries(layer ?? {})) {
      if (process.platform === 'win32') for (const old of Object.keys(env)) if (old.toUpperCase() === k.toUpperCase()) delete env[old];
      env[k] = v;
    }
  }
  return env;
}

/**
 * Files as they are in git, whatever line endings anyone's settings ask for
 * (core.autocrlf, common on Windows): the host compares files with their blobs,
 * and rooms are seeded from blob ids that must be the same on every device.
 */
const AS_STORED = ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf'];

/**
 * A file with nothing in it, for git to read settings and attributes from.
 * Git for Windows takes this name for its own null device (NUL) too.
 */
const NOTHING = '/dev/null';

/**
 * Settings a merge is made with, whatever this computer's or this repository's
 * settings say, and whatever another git takes them to be by default: the same
 * merge everywhere (0025). No attributes file of anyone's (`*.md merge=union`
 * in someone's ~/.gitconfig would merge what others keep as a conflict).
 */
const MERGE_SETTINGS = [
  '-c', 'merge.renames=true', '-c', 'merge.directoryRenames=conflict', '-c', 'merge.renameLimit=7000',
  '-c', 'merge.conflictStyle=merge', '-c', 'i18n.commitEncoding=UTF-8', '-c', 'i18n.logOutputEncoding=UTF-8',
  '-c', `core.attributesFile=${NOTHING}`,
];

/** Git's empty tree, by object format: attributes are read from it, so there are none. */
const EMPTY_TREE: Record<string, string> = {
  sha1: '4b825dc642cb6eb9a060e54bf8d69288fbee4904',
  sha256: '6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321',
};

/** No settings from the system's or this person's git files, nor any passed down by a git that started this process. */
const NO_SETTINGS: Record<string, string> = { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NOTHING, GIT_CONFIG_PARAMETERS: '', GIT_CONFIG_COUNT: '0' };

const versions = new Map<string, string>();

/**
 * The version of the git this process runs (useGit), as `git --version` says
 * it, once. Another git may merge the same commits differently, so it is part
 * of how a device merges (merging.ts, mergeSignature).
 */
export function gitVersion(): string {
  let v = versions.get(program.command);
  if (v === undefined) {
    try {
      v = execFileSync(program.command, ['--version'], { env: gitEnv(), encoding: 'utf8', timeout: 10_000 }).trim().replace(/^git version /, '').replace(/\s+/g, '-');
    } catch {
      v = 'unknown';
    }
    versions.set(program.command, v);
  }
  return v;
}

/** Start git with `args`, its input and output piped. */
export function spawnGit(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean } = {}): ChildProcessWithoutNullStreams {
  return spawn(program.command, [...AS_STORED, ...args], { detached: OWN_GROUP, ...opts });
}

/**
 * For git talking to other computers (fetch, push): never wait for anyone to type
 * a password or accept a host key; with no credentials, fail and say so.
 */
export const NON_INTERACTIVE: Record<string, string> = {
  GIT_TERMINAL_PROMPT: '0',
  GCM_INTERACTIVE: 'never',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? 'ssh -o BatchMode=yes',
};

/** Stop a git process and what it started (it has its own process group, where it can). */
function killGroup(child: ChildProcessWithoutNullStreams): void {
  try {
    if (OWN_GROUP && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

export class Git {
  /** `settings`: put before every command's own arguments (`-c name=value`). */
  constructor(readonly dir: string, private env: Record<string, string> = {}, private readonly settings: string[] = []) {}

  setEnv(env: Record<string, string>): void {
    this.env = { ...this.env, ...env };
  }

  /**
   * Put these paths in the index (`env` may name another index) as they are in
   * the working tree: those there are added, those gone are taken out. Unlike
   * `git add -A -- <paths>`, a path in neither the index nor the working tree
   * (a file moved away that the index had already let go of) is no error.
   */
  async stage(paths: string[], opts: { env?: Record<string, string> } = {}): Promise<void> {
    const present = paths.filter((p) => existsExactly(resolve(this.dir, p)));
    const gone = paths.filter((p) => !present.includes(p));
    // Taken out first: after a rename in case alone (drama to Drama), git, ignoring case as the file
    // system does, would take the new name's entries out with the old one's.
    if (gone.length) await this.run(['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', ...gone], opts);
    if (present.length) await this.run(['add', '-A', '--', ...present], opts);
  }

  /**
   * Run git. A change to the repository's config that finds it locked (another
   * process, or this one, writing it at that moment) is tried again a little
   * later, for up to two seconds (by the clock, not a count of tries: on a busy
   * computer each try takes longer): git wrote nothing, and the lock is held only
   * for a moment.
   */
  async run(args: string[], opts: GitRunOptions = {}): Promise<GitResult> {
    const until = Date.now() + CONFIG_LOCK_WAIT_MS;
    for (;;) {
      const r = await this.runOnce(args, { ...opts, allowFail: true });
      if (r.code !== 0 && Date.now() < until && CONFIG_LOCKED.test(r.stderr)) {
        await new Promise((res) => setTimeout(res, 25 + Math.random() * 50));
        continue;
      }
      if (r.code !== 0 && !opts.allowFail) throw new Error(`git ${args.join(' ')} failed (${r.signal ? `killed by ${r.signal}` : r.code}): ${r.stderr || r.stdout}`);
      return { stdout: r.stdout, stderr: r.stderr, code: r.code, bytes: r.bytes };
    }
  }

  private runOnce(args: string[], opts: GitRunOptions): Promise<GitResult & { signal: NodeJS.Signals | null }> {
    return new Promise((resolve, reject) => {
      const child = spawnGit([...this.settings, ...args], { cwd: this.dir, env: gitEnv(this.env, opts.env) });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      // Past its time, or quiet for too long, the whole group goes (git, and the ssh or helper it started).
      const timer = opts.timeoutMs ? setTimeout(() => killGroup(child), opts.timeoutMs) : undefined;
      let idle: NodeJS.Timeout | undefined;
      const stillGoing = () => {
        if (!opts.idleMs) return;
        clearTimeout(idle);
        idle = setTimeout(() => killGroup(child), opts.idleMs);
      };
      stillGoing();
      child.stdout.on('data', (d: Buffer) => {
        out.push(d);
        stillGoing();
      });
      child.stderr.on('data', (d: Buffer) => {
        err.push(d);
        stillGoing();
        opts.onStderr?.(d.toString('utf8'));
      });
      child.on('error', reject);
      child.on('close', (exit, signal) => {
        clearTimeout(timer);
        clearTimeout(idle);
        const bytes = Buffer.concat(out);
        const stdout = bytes.toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        resolve({ stdout, stderr, code: exit ?? 1, bytes, signal });
      });
      child.stdin.end(opts.input);
    });
  }

  async out(args: string[], opts: { input?: string | Buffer; env?: Record<string, string> } = {}): Promise<string> {
    return (await this.run(args, opts)).stdout.trim();
  }

  async isRepo(): Promise<boolean> {
    return (await this.run(['rev-parse', '--is-inside-work-tree'], { allowFail: true })).code === 0;
  }

  /**
   * Whether the folder is a repository's top: not only inside one. A
   * workspace made inside another repository (a dev workspace in a checkout
   * of Kuraa, in a git worktree) is a repository of its own, never the one
   * around it.
   */
  async isRepoTop(): Promise<boolean> {
    const r = await this.run(['rev-parse', '--show-toplevel'], { allowFail: true });
    if (r.code !== 0) return false;
    try {
      return realpathSync(r.stdout.trim()) === realpathSync(this.dir);
    } catch {
      return false;
    }
  }

  async branch(): Promise<string> {
    const r = await this.run(['symbolic-ref', '--short', 'HEAD'], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : 'HEAD';
  }

  async head(): Promise<string | null> {
    const r = await this.run(['rev-parse', '--verify', '-q', 'HEAD'], { allowFail: true });
    return r.code === 0 ? r.stdout.trim() : null;
  }

  async gitDir(): Promise<string> {
    return this.out(['rev-parse', '--absolute-git-dir']);
  }

  /** Three-way text merge. Returns the merged text and whether it conflicted. */
  async mergeFile(ours: string, base: string, theirs: string, tmpDir: string): Promise<{ text: string; conflict: boolean }> {
    const dir = join(tmpDir, `merge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, 'ours'), ours);
      await writeFile(join(dir, 'base'), base);
      await writeFile(join(dir, 'theirs'), theirs);
      // Markers as git makes them by default, whatever anyone's merge.conflictStyle.
      const r = await this.run([...MERGE_SETTINGS, 'merge-file', '-p', join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { allowFail: true, env: NO_SETTINGS });
      if (r.code < 0 || r.code > 127) throw new Error(`git merge-file failed: ${r.stderr}`);
      return { text: r.stdout, conflict: r.code !== 0 };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * This repository's git as merges use it (merging.ts), the same on every
   * device (0025): nothing of this computer's or this repository's settings, nor
   * of attributes (the person's, the system's, `.git/info/attributes`, the working
   * tree's `.gitattributes`), nor replaced objects. It runs in a git folder of its
   * own under `tmpDir` that has only this repository's objects (and its shallow
   * commits, if any); what it writes goes into those objects. Commits are named
   * by id: it has no branches.
   */
  async forMerging(tmpDir: string): Promise<Git> {
    const [objects, shallow, format = 'sha1'] = (await this.out(['rev-parse', '--git-path', 'objects', '--git-path', 'shallow', '--show-object-format'])).split('\n');
    const own = join(tmpDir, `merge-git-${format}`);
    if (!existsSync(join(own, 'config'))) {
      await mkdir(join(own, 'refs'), { recursive: true });
      await mkdir(join(own, 'objects'), { recursive: true });
      await writeFile(join(own, 'HEAD'), 'ref: refs/heads/main\n');
      const config = `[core]\n\trepositoryformatversion = ${format === 'sha1' ? 0 : 1}\n\tbare = true\n${format === 'sha1' ? '' : `[extensions]\n\tobjectformat = ${format}\n`}`;
      // Whole or not at all: another merge may be reading it.
      const tmp = join(own, `config.${process.pid}-${Math.random().toString(36).slice(2)}`);
      await writeFile(tmp, config);
      await rename(tmp, join(own, 'config'));
    }
    const shallowAt = resolve(this.dir, shallow!);
    if (existsSync(shallowAt)) await copyFile(shallowAt, join(own, 'shallow'));
    else await rm(join(own, 'shallow'), { force: true });
    return new Git(own, {
      ...NO_SETTINGS,
      GIT_DIR: own,
      GIT_OBJECT_DIRECTORY: resolve(this.dir, objects!),
      GIT_ATTR_NOSYSTEM: '1',
      GIT_ATTR_SOURCE: EMPTY_TREE[format] ?? EMPTY_TREE.sha1!,
      GIT_NO_REPLACE_OBJECTS: '1',
    }, MERGE_SETTINGS);
  }

  /** Spawn a git subcommand with streaming IO (for http-backend). */
  spawn(args: string[], env: Record<string, string>) {
    return spawnGit(args, { cwd: this.dir, env: gitEnv(this.env, env) });
  }
}

/**
 * Whether a path is there with its name in exactly this case. On a file system
 * that ignores case (macOS, Windows) `drama` is there when `Drama` is; after a
 * rename in case alone, the old name is gone.
 */
export function existsExactly(abs: string): boolean {
  try {
    lstatSync(abs);
  } catch {
    return false;
  }
  // Gone only if the folder has it in another case and not in this one (names compared as NFC, as
  // macOS may hand back either form of an accented name).
  const name = basename(abs).normalize('NFC');
  try {
    const names = readdirSync(dirname(abs)).map((n) => n.normalize('NFC'));
    return names.includes(name) || !names.some((n) => n.toLowerCase() === name.toLowerCase());
  } catch {
    return true;
  }
}
