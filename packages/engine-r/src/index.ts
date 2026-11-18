// The R engine: runs knitr's `r` chunks. One R process per document session,
// started in the environment the host chose, talking line-delimited JSON with
// the driver (./driver.ts). Outputs come back in order: text, messages,
// warnings, errors, data frames as tables, plots as PNG.
//
// Packages are declared per workspace and stored once per host (packages.ts):
// a session sees its workspace's library and the shared cache read-only, and
// install.packages() in a chunk asks the host, which runs a separate installer.
//
// What the workspace may ask of it, in the "r" section of .kuraa/run.json (used
// by environments that build images, such as Podman):
//   { "image": "docker.io/rocker/r-ver:4.5", "packages": ["dplyr"],
//     "system": ["libxml2-dev"], "renv": true }
// Operator options: { "rscript": "/path/to/Rscript" } (for a plain machine).
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  definePlugin, findExecutable,
  type ChunkOutput, type Engine, type EngineContext, type EngineSession, type RunRequest, type RunResult, type SandboxProcess,
} from '@kuraa/run-kit';
import { R_DRIVER, REPLY_PREFIX } from './driver.js';
import { imageRecipe } from './recipe.js';
import { layout, rPackages } from './packages.js';

export { DEFAULT_IMAGE, imageRecipe } from './recipe.js';
export { checkRefs, formatManifest, readManifest, MANIFEST, type Manifest } from './packages.js';

/** Where R lives when it is not on PATH. */
export const R_SEARCH_PATHS = ['/Library/Frameworks/R.framework/Resources/bin', '/opt/R/current/bin', '/usr/lib/R/bin'];

/** Rscript on this computer, if any. */
export function findRscript(explicit?: string): string | null {
  return findExecutable(explicit ?? process.env.KURAA_RSCRIPT ?? 'Rscript', R_SEARCH_PATHS);
}

type DriverOutput = Exclude<ChunkOutput, { type: 'image' }> | { type: 'image'; file: string; width: number; height: number };
interface Reply { type: 'result'; id: string; outputs: DriverOutput[]; interrupted?: boolean; fromEnvironment?: { name: string; version: string }[] }

class RSession implements EngineSession {
  ready: Promise<string>;
  ended: Promise<string>;
  private proc: SandboxProcess | null = null;
  private buffer = '';
  private stray = '';
  private waiting: { id: string; resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private failure: string | null = null;
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
    await mkdir(ctx.files, { recursive: true });
    await writeFile(join(ctx.files, 'driver.R'), R_DRIVER);
    await mkdir(join(ctx.scratch, 'plots'), { recursive: true });
    const recipe = imageRecipe(ctx.requirements, ctx.workspace);
    if (recipe.context?.['renv.lock'] === '') recipe.context['renv.lock'] = await readFile(join(ctx.workspace, 'renv.lock'), 'utf8');
    // An explicit Rscript applies to a plain machine; inside an image, Rscript is on PATH.
    const rscript = !ctx.environment.sandboxed ? ((ctx.options as { rscript?: string } | undefined)?.rscript ?? process.env.KURAA_RSCRIPT ?? 'Rscript') : 'Rscript';
    const where = layout(ctx);
    await Promise.all([where.lib, where.cache].map((d) => mkdir(d, { recursive: true })));
    const proc = await ctx.environment.start({
      name: 'r',
      workspace: ctx.workspace, scratch: ctx.scratch, files: ctx.files, policy: ctx.policy,
      mounts: where.mounts('read-only'),
      searchPaths: R_SEARCH_PATHS,
      image: recipe,
      // In the workspace root, so a project's .Rprofile (renv, for instance) applies.
      command: (view) => ({ argv: [rscript, '--no-save', '--no-restore', `${view.files}/driver.R`], cwd: view.workspace, env: { R_KURAA: '1', KURAA_R_LIB: view.inside(where.lib) } }),
      log: ctx.log,
      status: ctx.status,
    }, ctx.environmentOptions);
    this.proc = proc;

    const timer = setTimeout(() => this.readyWith.reject(new Error('R did not start within 60 seconds.')), 60_000);
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', (chunk: string) => this.onStdout(chunk, timer));
    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', (chunk: string) => this.strayOutput(chunk));
    void proc.exited.then(({ code, signal }) => {
      clearTimeout(timer);
      const why = this.failure ?? `R exited (${signal ?? `status ${code}`}).`;
      this.proc = null;
      this.readyWith.reject(new Error(this.stray.trim() ? `${why}\n${this.stray.trim()}` : why));
      const w = this.waiting;
      this.waiting = null;
      w?.reject(new Error(this.stray.trim() ? `${why}\n${this.stray.trim()}` : why));
      this.endedWith(why);
    });
  }

  private onStdout(chunk: string, timer: ReturnType<typeof setTimeout>): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      const at = line.indexOf(REPLY_PREFIX);
      if (at < 0) {
        this.strayOutput(line + '\n');
        continue;
      }
      if (at > 0) this.strayOutput(line.slice(0, at));
      let msg: { type: string; [k: string]: unknown };
      try {
        msg = JSON.parse(line.slice(at + REPLY_PREFIX.length)) as typeof msg;
      } catch {
        continue;
      }
      if (msg.type === 'ready') {
        clearTimeout(timer);
        this.readyWith.resolve(String(msg.r ?? 'R'));
      } else if (msg.type === 'fatal') {
        this.failure = String(msg.message ?? 'R failed to start.');
        this.readyWith.reject(new Error(this.failure));
      } else if ((msg.type === 'install' || msg.type === 'remove') && this.proc) {
        // install.packages() / remove.packages() in a chunk: the host does it; the chunk waits.
        const proc = this.proc;
        const names = (msg.refs as string[] | undefined) ?? [];
        void (msg.type === 'install' ? this.ctx.install(names) : this.ctx.remove(names))
          .catch((e: Error) => ({ ok: false, message: e.message, log: '', restart: false }))
          .then((r) => proc.stdin.write(JSON.stringify({ type: 'done', ok: r.ok, message: r.message }) + '\n'));
      } else if (msg.type === 'result' && this.waiting?.id === msg.id) {
        const w = this.waiting!;
        this.waiting = null;
        w.resolve(msg as unknown as Reply);
      }
    }
  }

  /** Output that did not come through evaluate: startup messages, output from system(), crashes. */
  private strayOutput(text: string): void {
    if (this.waiting) this.stray += text;
    else if (text.trim()) this.ctx.log(`R: ${text.trim()}`);
  }

  async run(req: RunRequest): Promise<RunResult> {
    await this.ready;
    const proc = this.proc;
    if (!proc) throw new Error(this.failure ?? 'R is not running.');
    this.stray = '';
    // knitr's options are everything after the engine name: `r label, fig.width = 6`.
    const options = req.header.replace(/^\s*[A-Za-z][\w-]*\s*,?\s*/, '');
    const reply = await new Promise<Reply>((resolve, reject) => {
      this.waiting = { id: req.id, resolve, reject };
      proc.stdin.write(JSON.stringify({
        id: req.id, code: req.code, options, dir: proc.view.inside(req.dir), out: `${proc.view.scratch}/plots`,
      }) + '\n');
    });
    const outputs: ChunkOutput[] = [];
    for (const o of reply.outputs ?? []) {
      if (o.type === 'image' && 'file' in o) {
        const file = proc.view.outside(o.file);
        try {
          outputs.push({ type: 'image', mime: 'image/png', data: (await readFile(file)).toString('base64'), width: o.width, height: o.height });
        } catch {
          outputs.push({ type: 'error', text: 'A plot could not be read.' });
        }
        await rm(file, { force: true });
      } else {
        outputs.push(o as ChunkOutput);
      }
    }
    if (this.stray.trim()) outputs.push({ type: 'message', text: this.stray });
    if (reply.fromEnvironment?.length) this.ctx.usedFromEnvironment(reply.fromEnvironment);
    return { outputs, interrupted: reply.interrupted === true };
  }

  interrupt(): void {
    if (this.waiting) this.proc?.interrupt();
  }

  async stop(): Promise<void> {
    const proc = this.proc;
    if (!proc) return;
    proc.stdin.end();
    const kill = setTimeout(() => proc.kill(), 3000);
    if (this.waiting) proc.interrupt();
    await proc.exited;
    clearTimeout(kill);
  }
}

export const rEngine: Engine = {
  id: 'r',
  label: 'R',
  description: 'Runs r chunks in R Markdown documents, one R session per document, through knitr\'s evaluate.',
  handles: ['r'],
  open: (ctx) => new RSession(ctx),
  packages: rPackages,
};

export default definePlugin({ name: '@kuraa/engine-r', engines: [rEngine] });
