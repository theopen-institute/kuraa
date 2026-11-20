// Git, called as a child process: the one on PATH, or one a shell bundles (useGit).
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { delimiter } from 'node:path';

export interface GitResult { stdout: string; stderr: string; code: number; /** stdout as bytes (a blob may not be text). */ bytes: Buffer }

// Git runs in its own process group, so Ctrl+C in the host's terminal (which goes
// to the whole foreground group) cannot kill a commit half-way. The host stops
// on that signal by finishing its git work first. (Not on Windows, where a
// detached child would get its own console window.)
const OWN_GROUP = process.platform !== 'win32';

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

/** Start git with `args`, its input and output piped. */
export function spawnGit(args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv; detached?: boolean } = {}): ChildProcessWithoutNullStreams {
  return spawn(program.command, [...AS_STORED, ...args], { detached: OWN_GROUP, ...opts });
}

export class Git {
  constructor(readonly dir: string, private env: Record<string, string> = {}) {}

  setEnv(env: Record<string, string>): void {
    this.env = { ...this.env, ...env };
  }

  run(args: string[], opts: { input?: string | Buffer; allowFail?: boolean; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawnGit(args, { cwd: this.dir, env: gitEnv(this.env, opts.env) });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', reject);
      const timer = opts.timeoutMs ? setTimeout(() => child.kill('SIGTERM'), opts.timeoutMs) : undefined;
      child.on('close', (exit, signal) => {
        clearTimeout(timer);
        const bytes = Buffer.concat(out);
        const stdout = bytes.toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        const code = exit ?? 1;
        if (code !== 0 && !opts.allowFail) reject(new Error(`git ${args.join(' ')} failed (${signal ? `killed by ${signal}` : code}): ${stderr || stdout}`));
        else resolve({ stdout, stderr, code, bytes });
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
    const { writeFile, mkdir, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const dir = join(tmpDir, `merge-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(dir, { recursive: true });
    try {
      await writeFile(join(dir, 'ours'), ours);
      await writeFile(join(dir, 'base'), base);
      await writeFile(join(dir, 'theirs'), theirs);
      const r = await this.run(['merge-file', '-p', join(dir, 'ours'), join(dir, 'base'), join(dir, 'theirs')], { allowFail: true });
      if (r.code < 0 || r.code > 127) throw new Error(`git merge-file failed: ${r.stderr}`);
      return { text: r.stdout, conflict: r.code !== 0 };
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /** Spawn a git subcommand with streaming IO (for http-backend). */
  spawn(args: string[], env: Record<string, string>) {
    return spawnGit(args, { cwd: this.dir, env: gitEnv(this.env, env) });
  }
}
