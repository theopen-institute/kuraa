// The R engine: runs knitr's `r` chunks. One R process per document session,
// started in the environment the host chose, talking line-delimited JSON with
// the driver (./driver.ts). Outputs come back in order: text, messages,
// warnings, errors, data frames as tables, plots as PNG.
//
// What the workspace may ask of it, in the "r" section of .kuraa/run.json (used
// by environments that build images, such as Podman):
//   { "image": "docker.io/rocker/r-ver:4.5", "packages": ["dplyr"],
//     "system": ["libxml2-dev"], "renv": true }
// Operator options: { "rscript": "/path/to/Rscript" } (for a plain machine).
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  definePlugin, findExecutable,
  type ChunkOutput, type Engine, type EngineContext, type EngineSession, type ImageRecipe, type RunRequest, type RunResult, type SandboxProcess,
} from '@kuraa/run-kit';
import { R_DRIVER, REPLY_PREFIX } from './driver.js';

/** Where R lives when it is not on PATH. */
export const R_SEARCH_PATHS = ['/Library/Frameworks/R.framework/Resources/bin', '/opt/R/current/bin', '/usr/lib/R/bin'];

/** Rscript on this computer, if any. */
export function findRscript(explicit?: string): string | null {
  return findExecutable(explicit ?? process.env.KURAA_RSCRIPT ?? 'Rscript', R_SEARCH_PATHS);
}

export const DEFAULT_IMAGE = 'docker.io/rocker/r-ver:4.5';
const NAME = /^[A-Za-z0-9._+-]+$/;
const IMAGE = /^[A-Za-z0-9./:@_-]+$/;

interface Requirements { image?: unknown; packages?: unknown; system?: unknown; renv?: unknown }

const names = (v: unknown, what: string): string[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string' && NAME.test(x))) throw new Error(`.kuraa/run.json: r.${what} must be a list of plain package names.`);
  return v as string[];
};

/** A container image with R, the driver's packages, and what the workspace asks for. */
export function imageRecipe(requirements: unknown, workspace: string): ImageRecipe {
  const req = (requirements ?? {}) as Requirements;
  const image = req.image === undefined ? DEFAULT_IMAGE : String(req.image);
  if (!IMAGE.test(image)) throw new Error('.kuraa/run.json: r.image is not an image name.');
  const packages = names(req.packages, 'packages');
  const system = names(req.system, 'system');
  // System libraries ragg needs to draw plots, then the driver's packages.
  const lines = [
    `FROM ${image}`,
    'RUN apt-get update && apt-get install -y --no-install-recommends \\',
    `    ${['libfontconfig1-dev', 'libfreetype6-dev', 'libharfbuzz-dev', 'libfribidi-dev', 'libpng-dev', 'libtiff5-dev', 'libjpeg-dev', 'libwebp-dev', ...system].join(' ')} \\`,
    ' && rm -rf /var/lib/apt/lists/*',
    `RUN install2.r --error --skipinstalled evaluate jsonlite knitr ragg ${packages.join(' ')}`.trimEnd(),
  ];
  const context: Record<string, string> = {};
  const lockfile = join(workspace, 'renv.lock');
  if (req.renv === true && existsSync(lockfile)) {
    context['renv.lock'] = '';
    lines.push(
      'COPY renv.lock /tmp/renv.lock',
      `RUN R -q -e 'install.packages("renv"); renv::restore(lockfile = "/tmp/renv.lock", library = .libPaths()[1], prompt = FALSE)'`,
    );
  }
  return { containerfile: `${lines.join('\n')}\n`, context };
}

type DriverOutput = Exclude<ChunkOutput, { type: 'image' }> | { type: 'image'; file: string; width: number; height: number };
interface Reply { type: 'result'; id: string; outputs: DriverOutput[]; interrupted?: boolean }

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
    const proc = await ctx.environment.start({
      name: 'r',
      workspace: ctx.workspace, scratch: ctx.scratch, files: ctx.files, policy: ctx.policy,
      searchPaths: R_SEARCH_PATHS,
      image: recipe,
      // In the workspace root, so a project's .Rprofile (renv, for instance) applies.
      command: (view) => ({ argv: [rscript, '--no-save', '--no-restore', `${view.files}/driver.R`], cwd: view.workspace, env: { R_KURAA: '1' } }),
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
  handles: ['r'],
  open: (ctx) => new RSession(ctx),
};

export default definePlugin({ name: '@kuraa/engine-r', engines: [rEngine] });
