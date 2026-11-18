// The system git binary, called as a child process.
import { spawn } from 'node:child_process';

export interface GitResult { stdout: string; stderr: string; code: number; /** stdout as bytes (a blob may not be text). */ bytes: Buffer }

// Git runs in its own process group, so Ctrl+C in the host's terminal (which goes
// to the whole foreground group) cannot kill a commit half-way. The host stops
// on that signal by finishing its git work first. (Not on Windows, where a
// detached child would get its own console window.)
const OWN_GROUP = process.platform !== 'win32';

export class Git {
  constructor(readonly dir: string, private env: Record<string, string> = {}) {}

  setEnv(env: Record<string, string>): void {
    this.env = { ...this.env, ...env };
  }

  run(args: string[], opts: { input?: string | Buffer; allowFail?: boolean; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', args, { cwd: this.dir, env: { ...process.env, ...this.env, ...opts.env }, detached: OWN_GROUP });
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
    return spawn('git', args, { cwd: this.dir, env: { ...process.env, ...this.env, ...env }, detached: OWN_GROUP });
  }
}
