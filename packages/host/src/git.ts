// The system git binary, called as a child process.
import { execFile, spawn } from 'node:child_process';

export interface GitResult { stdout: string; stderr: string; code: number }

export class Git {
  constructor(readonly dir: string, private env: Record<string, string> = {}) {}

  setEnv(env: Record<string, string>): void {
    this.env = { ...this.env, ...env };
  }

  run(args: string[], opts: { input?: string; allowFail?: boolean } = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = execFile('git', args, { cwd: this.dir, env: { ...process.env, ...this.env }, maxBuffer: 256 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
        if (code !== 0 && !opts.allowFail) reject(new Error(`git ${args.join(' ')} failed (${code}): ${stderr || stdout}`));
        else resolve({ stdout, stderr, code });
      });
      if (opts.input !== undefined) {
        child.stdin?.end(opts.input);
      }
    });
  }

  async out(args: string[]): Promise<string> {
    return (await this.run(args)).stdout.trim();
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
    return spawn('git', args, { cwd: this.dir, env: { ...process.env, ...this.env, ...env } });
  }
}
