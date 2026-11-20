// The R engine: runs knitr's `r` chunks. One R process per document session,
// started in the host's sandbox (a Podman container), talking line-delimited JSON with
// the driver (./driver.ts). Outputs come back in order: text, messages,
// warnings, errors, data frames as tables, plots as PNG.
//
// Packages are declared per workspace and stored once per host (packages.ts):
// a session sees its workspace's library and the shared cache read-only, and
// install.packages() in a chunk asks the host, which runs a separate installer.
//
// What the workspace may ask of it, in the "r" section of .kuraa/run.json (the
// image the container is built from):
//   { "image": "docker.io/rocker/r-ver:4.5", "packages": ["dplyr"],
//     "system": ["libxml2-dev"], "renv": true }
import { constants } from 'node:fs';
import { lstat, mkdir, open, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  defineRunComponent,
  type ChunkOutput, type Engine, type EngineContext, type EngineSession, type RunRequest, type RunResult, type SandboxProcess,
} from '@kuraa/run-kit';
import { R_DRIVER, REPLY_PREFIX } from './driver.js';
import { imageRecipe } from './recipe.js';
import { layout, rPackages } from './packages.js';
import { Capped, splitLines, writeIfChanged } from './lines.js';
import { rRenderer } from './render.js';

export { DEFAULT_IMAGE, imageRecipe, type ROptions } from './recipe.js';
export { rRenderer } from './render.js';
export { checkRefs, formatManifest, readManifest, MANIFEST, type Manifest } from './packages.js';

/** How long R has to say it is ready, once its process has started. */
const START_MS = 60_000;
/** Output that did not come through evaluate, kept for one run (more is counted, not kept). */
const MAX_STRAY = 200_000;
/** Plots read from one run, and the largest read. */
const MAX_PLOTS = 100;
const MAX_PLOT_BYTES = 50 * 1024 * 1024;
/** A plot the driver wrote: its name only, in scratch itself. */
const PLOT = /^[A-Za-z0-9._-]+\.png$/;

interface Reply { type: 'result'; id: string; outputs?: unknown; interrupted?: boolean; fromEnvironment?: unknown }

class RSession implements EngineSession {
  ready: Promise<string>;
  ended: Promise<string>;
  private proc: SandboxProcess | null = null;
  private started = false;
  private stopped = false;
  private readonly stray = new Capped(MAX_STRAY);
  private waiting: { id: string; resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failure: string | null = null;
  private pendingLog = '';
  private endedWith!: (why: string) => void;
  private readyWith!: { resolve: (v: string) => void; reject: (e: Error) => void };

  constructor(private readonly ctx: EngineContext) {
    this.ended = new Promise((r) => (this.endedWith = r));
    this.ready = new Promise<string>((resolve, reject) => (this.readyWith = { resolve, reject }));
    this.ready.catch(() => undefined);
    this.boot().catch((e: Error) => {
      this.failure = e.message;
      this.readyWith.reject(e);
      this.endedWith(e.message);
    });
  }

  private async boot(): Promise<void> {
    const { ctx } = this;
    const where = layout(ctx);
    await Promise.all([ctx.files, ctx.scratch, where.lib, where.cache].map((d) => mkdir(d, { recursive: true })));
    await writeIfChanged(join(ctx.files, 'driver.R'), R_DRIVER);
    if (this.stopped) throw new Error('Stopped before R started.');
    const proc = await ctx.environment.start({
      name: 'r',
      workspace: ctx.workspace, scratch: ctx.scratch, files: ctx.files, policy: ctx.policy,
      mounts: where.mounts('read-only'),
      image: imageRecipe(ctx.requirements, ctx.workspace, ctx.options),
      // In the workspace root, so a project's .Rprofile (renv, for instance) applies.
      command: (view) => ({ argv: ['Rscript', '--no-save', '--no-restore', `${view.files}/driver.R`], cwd: view.workspace, env: { R_KURAA: '1', KURAA_R_LIB: view.inside(where.lib) } }),
      log: ctx.log,
      status: ctx.status,
    }, ctx.environmentOptions);
    // Stopped while the environment was starting it (building an image, say): it is not wanted.
    if (this.stopped) {
      proc.stdin.end();
      proc.kill();
      throw new Error('Stopped before R started.');
    }
    this.proc = proc;
    proc.stdin.on('error', (e) => ctx.log(`R's input: ${e.message}`));

    // R that never says it is ready is ended, so the session does not hang on it.
    const timer = setTimeout(() => {
      this.failure = `R did not start within ${START_MS / 1000} seconds.`;
      proc.kill();
    }, START_MS);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', splitLines((line) => this.onLine(line, proc, timer), (partial) => this.onOverflow(partial)));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => this.strayOutput(chunk));
    void proc.exited.then(({ code, signal, reason }) => {
      clearTimeout(timer);
      const why = this.failure ?? (reason ? `R was stopped. ${reason}` : `R exited (${signal ?? `status ${code}`}).`);
      const detail = this.stray.empty ? why : `${why}\n${this.stray.toString().trim()}`;
      this.proc = null;
      this.readyWith.reject(new Error(detail));
      const w = this.waiting;
      this.waiting = null;
      w?.reject(new Error(detail));
      this.endedWith(why);
    });
  }

  private onLine(line: string, proc: SandboxProcess, timer: ReturnType<typeof setTimeout>): void {
    const at = line.indexOf(REPLY_PREFIX);
    if (at < 0) return this.strayOutput(line + '\n');
    if (at > 0) this.strayOutput(line.slice(0, at));
    let msg: { type?: unknown; [k: string]: unknown };
    try {
      msg = JSON.parse(line.slice(at + REPLY_PREFIX.length)) as typeof msg;
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'ready' && !this.started) {
      clearTimeout(timer);
      this.started = true;
      // What R said while starting (a project's .Rprofile, say) is for the log, not the first run.
      if (!this.stray.empty) this.ctx.log(`R: ${this.stray.toString().trim()}`);
      this.stray.clear();
      this.readyWith.resolve(String(msg.r ?? 'R'));
    } else if (msg.type === 'fatal' && !this.started) {
      this.failure = String(msg.message ?? 'R failed to start.');
      this.readyWith.reject(new Error(this.failure));
    } else if (msg.type === 'install' || msg.type === 'remove') {
      // install.packages() / remove.packages() in a chunk: the host does it; the chunk waits.
      const names = Array.isArray(msg.refs) ? msg.refs.filter((r): r is string => typeof r === 'string') : [];
      void (msg.type === 'install' ? this.ctx.install(names) : this.ctx.remove(names))
        .catch((e: Error) => ({ ok: false, message: e.message }))
        .then((r) => this.send(proc, { type: 'done', ok: r.ok, message: r.message }));
    } else if (msg.type === 'result' && this.waiting && this.waiting.id === msg.id) {
      const w = this.waiting;
      this.waiting = null;
      w.resolve(msg as unknown as Reply);
    }
  }

  /** A line too long to hold: if it was the reply, the run fails rather than wait for it forever. */
  private onOverflow(partial: string): void {
    if (partial.includes(REPLY_PREFIX) && this.waiting) {
      const w = this.waiting;
      this.waiting = null;
      w.reject(new Error(`The chunk's output was too large to show (over ${Math.round(partial.length / 1024 / 1024)} MB).`));
    } else {
      this.strayOutput(`${partial.slice(0, 1000)}… (a line too long to show)\n`);
    }
  }

  /** To R, if it is still the process this session runs; once R has gone, nothing is listening. */
  private send(proc: SandboxProcess, message: object): void {
    if (this.proc === proc && proc.stdin.writable) proc.stdin.write(JSON.stringify(message) + '\n');
  }

  /**
   * Output that did not come through evaluate: startup messages, output from
   * system(), crashes. Kept for the run (or the start) it belongs to; between
   * runs (a process left running in the background, say) it goes to the log,
   * a little at a time, so a flood of it cannot flood the log.
   */
  private strayOutput(text: string): void {
    if (this.waiting || !this.started) return this.stray.add(text);
    if (!text.trim()) return;
    if (!this.pendingLog) {
      setTimeout(() => {
        this.ctx.log(`R: ${this.pendingLog.trim()}`);
        this.pendingLog = '';
      }, 200).unref?.();
    }
    if (this.pendingLog.length < 2000) this.pendingLog += text.slice(0, 2000);
  }

  async run(req: RunRequest): Promise<RunResult> {
    await this.ready;
    const proc = this.proc;
    if (!proc) throw new Error(this.failure ?? 'R is not running.');
    this.stray.clear();
    // knitr's options are everything after the engine name: `r label, fig.width = 6`.
    const options = req.header.replace(/^\s*[A-Za-z][\w-]*\s*,?\s*/, '');
    const request = { id: req.id, code: req.code, options, dir: proc.view.inside(req.dir), out: proc.view.scratch };
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.waiting = { id: req.id, resolve, reject };
      this.send(proc, request);
    });
    // The reply comes from a process running people's code, which can write one
    // of its own: only outputs of known kinds go on, as the client expects them.
    const outputs: ChunkOutput[] = [];
    let plots = 0;
    for (const o of Array.isArray(reply.outputs) ? (reply.outputs as unknown[]) : []) {
      const x = (o ?? {}) as Record<string, unknown>;
      if (x.type === 'image') {
        if (++plots <= MAX_PLOTS) outputs.push(await this.plot(proc, x));
        else await this.dropPlot(proc, x);
      } else {
        const out = checked(x);
        if (out) outputs.push(out);
      }
    }
    if (plots > MAX_PLOTS) outputs.push({ type: 'note', text: `${plots - MAX_PLOTS} more plots not shown.` });
    if (!this.stray.empty) outputs.push({ type: 'message', text: this.stray.toString() });
    const used = Array.isArray(reply.fromEnvironment) ? (reply.fromEnvironment as { name?: unknown; version?: unknown }[]) : [];
    const fromEnvironment = used.filter((p) => typeof p?.name === 'string' && typeof p.version === 'string') as { name: string; version: string }[];
    if (fromEnvironment.length) this.ctx.usedFromEnvironment(fromEnvironment);
    return { outputs, interrupted: reply.interrupted === true };
  }

  /** The host file of a plot the driver says it wrote: only a plain name in scratch itself. */
  private plotFile(proc: SandboxProcess, o: Record<string, unknown>): string | null {
    const file = typeof o.file === 'string' ? o.file : '';
    const name = file.slice(proc.view.scratch.length + 1);
    return file === `${proc.view.scratch}/${name}` && PLOT.test(name) ? proc.view.outside(file) : null;
  }

  private async plot(proc: SandboxProcess, o: Record<string, unknown>): Promise<ChunkOutput> {
    const file = this.plotFile(proc, o);
    const unread: ChunkOutput = { type: 'error', text: 'A plot could not be read.' };
    if (!file) return unread;
    try {
      // Scratch is the process's to write: it may have left a link to anywhere on
      // this computer, or a pipe that never ends, where the plot should be.
      // Windows has no O_NOFOLLOW: look at the name itself first.
      if (process.platform === 'win32' && !(await lstat(file)).isFile()) return unread;
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > MAX_PLOT_BYTES) return unread;
        const data = (await handle.readFile()).toString('base64');
        return { type: 'image', mime: 'image/png', data, width: Number(o.width) || 0, height: Number(o.height) || 0 };
      } finally {
        await handle.close();
      }
    } catch {
      return unread;
    } finally {
      await rm(file, { force: true }).catch(() => undefined);
    }
  }

  private async dropPlot(proc: SandboxProcess, o: Record<string, unknown>): Promise<void> {
    const file = this.plotFile(proc, o);
    if (file) await rm(file, { force: true }).catch(() => undefined);
  }

  interrupt(): void {
    if (this.waiting) this.proc?.interrupt();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const proc = this.proc;
    if (!proc) return;
    proc.stdin.end();
    const kill = setTimeout(() => proc.kill(), 3000);
    if (this.waiting) proc.interrupt();
    await proc.exited;
    clearTimeout(kill);
  }
}

/** An output of a kind the client knows, with fields of the types it expects; null for anything else. */
function checked(x: Record<string, unknown>): ChunkOutput | null {
  const str = (v: unknown) => (typeof v === 'string' ? v : v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(str) : []);
  switch (x.type) {
    case 'text': case 'message': case 'warning': case 'error': case 'note':
      return { type: x.type, text: str(x.text) };
    case 'table':
      return {
        type: 'table', columns: strs(x.columns), types: strs(x.types),
        data: Array.isArray(x.data) ? x.data.map(strs) : [],
        rownames: Array.isArray(x.rownames) ? strs(x.rownames) : null,
        nrow: Number(x.nrow) || 0, ncol: Number(x.ncol) || 0,
      };
    default:
      return null;
  }
}

export const rEngine: Engine = {
  id: 'r',
  label: 'R',
  description: 'Runs r chunks in R Markdown documents, one R session per document, through knitr\'s evaluate.',
  handles: ['r'],
  open: (ctx) => new RSession(ctx),
  packages: rPackages,
  render: rRenderer,
};

export default defineRunComponent({ name: '@kuraa/engine-r', engines: [rEngine] });
