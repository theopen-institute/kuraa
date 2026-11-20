// Rendering documents with the R engine: R Markdown through rmarkdown::render,
// Markdown through pandoc, to HTML, Word or PDF (Typst, or LaTeX where the
// header asks for it and the environment has it). One process per render, in
// the environment the host chose, from the same image as R sessions (which has
// pandoc, rmarkdown and Typst: recipe.ts). The R side is render-script.ts.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { DocumentRenderer, RenderContext, RenderFormat, RenderRequest, RenderResult, SandboxProcess } from '@kuraa/run-kit';
import { RENDER_PREFIX, RENDER_SCRIPT } from './render-script.js';
import { imageRecipe } from './recipe.js';
import { layout } from './packages.js';
import { Capped, writeIfChanged } from './lines.js';

/** What a render's log keeps. */
const MAX_LOG = 400_000;
const NAMES: Record<RenderFormat, string> = { html: 'HTML', docx: 'Word', pdf: 'PDF' };

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`);

async function render(ctx: RenderContext, req: RenderRequest): Promise<RenderResult> {
  const where = layout(ctx);
  await Promise.all([ctx.files, ctx.scratch, where.lib, where.cache].map((d) => mkdir(d, { recursive: true })));
  await writeIfChanged(join(ctx.files, 'render.R'), RENDER_SCRIPT);
  const log = new Capped(MAX_LOG);
  let proc: SandboxProcess;
  try {
    proc = await ctx.environment.start({
      name: 'render',
      workspace: ctx.workspace, scratch: ctx.scratch, files: ctx.files, policy: ctx.policy,
      mounts: where.mounts('read-only'),
      image: imageRecipe(ctx.requirements, ctx.workspace, ctx.options),
      command: (view) => ({
        argv: ['Rscript', '--no-save', '--no-restore', `${view.files}/render.R`, view.inside(req.input), req.format, view.scratch],
        // In scratch: pandoc writes beside where it runs, and the workspace is read-only.
        cwd: view.scratch,
        env: { R_KURAA: '1', KURAA_R_LIB: view.inside(where.lib) },
      }),
      log: ctx.log,
      status: ctx.status,
    }, ctx.environmentOptions);
  } catch (e) {
    return { ok: false, message: (e as Error).message, log: '' };
  }
  if (ctx.signal.aborted) proc.kill();
  let stopped: string | null = null;
  const timer = setTimeout(() => {
    stopped = `The render took longer than ${minutes(ctx.timeLimitMs)}, the most this host allows, and was stopped.`;
    proc.kill();
  }, ctx.timeLimitMs);
  const onAbort = () => {
    stopped ??= 'The render was stopped.';
    proc.kill();
  };
  ctx.signal.addEventListener('abort', onAbort);
  proc.stdin.end();
  let reply: { ok?: unknown; message?: unknown; notes?: unknown } | null = null;
  const read = (stream: NodeJS.ReadableStream) => new Promise<void>((resolve) => {
    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      log.add(chunk);
      const at = chunk.lastIndexOf(RENDER_PREFIX);
      if (at >= 0) {
        try {
          reply = JSON.parse(chunk.slice(at + RENDER_PREFIX.length).split('\n')[0]!) as typeof reply;
        } catch { /* a line cut in two: the log still has it */ }
      }
    });
    stream.on('end', () => resolve());
    stream.on('error', () => resolve());
  });
  const [, , exit] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
  clearTimeout(timer);
  ctx.signal.removeEventListener('abort', onAbort);
  const text = log.toString().split(RENDER_PREFIX).join('').trim();
  const r = reply as { ok?: unknown; message?: unknown; notes?: unknown } | null;
  if (stopped) return { ok: false, message: stopped, log: text };
  if (exit.reason) return { ok: false, message: `The render was stopped. ${exit.reason}`, log: text };
  if (r?.ok === true && exit.code === 0) {
    const notes = Array.isArray(r.notes) ? r.notes.filter((n): n is string => typeof n === 'string') : [];
    return { ok: true, output: `out/document.${req.format}`, message: [`Rendered to ${NAMES[req.format]}.`, ...notes].join(' '), log: text };
  }
  const why = typeof r?.message === 'string' && r.message.trim() ? r.message.trim() : `Rendering stopped unexpectedly (${exit.signal ?? `status ${exit.code}`}).`;
  return { ok: false, message: `The document could not be rendered: ${why}`, log: text };
}

export const rRenderer: DocumentRenderer = {
  extensions: ['.rmd', '.md', '.markdown'],
  formats: ['html', 'docx', 'pdf'],
  render,
};
