// Rendering documents with the R engine: R Markdown through rmarkdown::render,
// Markdown through pandoc, to HTML, Word, PDF (Typst, or LaTeX where the
// header asks for it and the environment has it) or EPUB. One process per render, in
// the environment the host chose, from the same image as R sessions (which has
// pandoc, rmarkdown and Typst: recipe.ts). The R side is render-script.ts.
//
// LaTeX is a tool (decision 0045), not part of the image: a PDF whose header
// asks for a LaTeX engine gets the `tinytex` tool mounted, read-only, with its
// programs on PATH. Without it, where people may download it, the render
// answers with `needs` (the app offers the download, then renders again);
// where they may not, the PDF is made with Typst, saying why. Packages LaTeX
// finds missing are the host's to add (it reads the log through the tool).
import { mkdir, open as openFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DocumentRenderer, RenderContext, RenderFormat, RenderRequest, RenderResult, SandboxProcess } from '@kuraa/run-kit';
import { RENDER_PREFIX, RENDER_SCRIPT } from './render-script.js';
import { imageRecipe } from './recipe.js';
import { layout } from './packages.js';
import { Capped, writeIfChanged } from './lines.js';

/** What a render's log keeps. */
const MAX_LOG = 400_000;
const NAMES: Record<RenderFormat, string> = { html: 'HTML', docx: 'Word', pdf: 'PDF', epub: 'EPUB' };
/** The tool that brings LaTeX, and the engines it has. */
export const LATEX_TOOL = 'tinytex';
const LATEX = ['pdflatex', 'xelatex', 'lualatex', 'latexmk'];

/**
 * The LaTeX engine a document's header asks for, if any: R Markdown's
 * `latex_engine`, or `pdf-engine` (Quarto-style headers, pandoc's metadata).
 * Read from the header's text, as the R side reads it (render-script.ts), so
 * the tool is mounted before the process starts.
 */
export async function latexWanted(input: string): Promise<string | null> {
  let text: string;
  try {
    const handle = await openFile(input, 'r');
    try {
      const { buffer, bytesRead } = await handle.read(Buffer.alloc(65_536), 0, 65_536, 0);
      text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
  const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text)?.[1];
  if (!header) return null;
  const m = /^[ \t]*(?:latex_engine|pdf-engine)[ \t]*:[ \t]*["']?([A-Za-z]+)["']?[ \t]*(?:#.*)?$/m.exec(header);
  return m && LATEX.includes(m[1]!) ? m[1]! : null;
}

const minutes = (ms: number) => (ms >= 60_000 ? `${Math.round(ms / 60_000)} minute${Math.round(ms / 60_000) === 1 ? '' : 's'}` : `${Math.round(ms / 1000)} seconds`);

async function render(ctx: RenderContext, req: RenderRequest): Promise<RenderResult> {
  const where = layout(ctx);
  // LaTeX, if the header asks for it: the tool, or an offer to download it, or Typst and why.
  const mounts = where.mounts('read-only');
  const env: Record<string, string> = {};
  let withoutLatex: string | null = null;
  const latex = req.format === 'pdf' ? await latexWanted(req.input) : null;
  if (latex) {
    const use = ctx.tools ? await ctx.tools.use(LATEX_TOOL) : { ok: false as const, reason: 'This host offers no LaTeX.', canDownload: false };
    if (use.ok) {
      mounts.push(...use.mounts);
      Object.assign(env, use.env);
      env.KURAA_TOOL_PATH = use.path.join(':');
    } else if (use.canDownload) {
      return { ok: false, needs: { tool: LATEX_TOOL }, message: `This document asks for LaTeX (${latex}) to make its PDF, which is not on this computer yet. ${use.reason}`, log: '' };
    } else withoutLatex = use.reason;
  }
  await Promise.all([ctx.files, ctx.scratch, where.lib, where.cache].map((d) => mkdir(d, { recursive: true })));
  await writeIfChanged(join(ctx.files, 'render.R'), RENDER_SCRIPT);
  const log = new Capped(MAX_LOG);
  let proc: SandboxProcess;
  try {
    proc = await ctx.environment.start({
      name: 'render',
      workspace: ctx.workspace, scratch: ctx.scratch, files: ctx.files, policy: ctx.policy,
      mounts,
      image: imageRecipe(ctx.requirements, ctx.workspace, ctx.options),
      command: (view) => ({
        // Folders where what it refers to is found, besides its own (a compiled folder's documents': 0093), as pandoc's resource path.
        argv: ['Rscript', '--no-save', '--no-restore', `${view.files}/render.R`, view.inside(req.input), req.format, view.scratch, (req.resources ?? []).map((r) => view.inside(r)).join(':')],
        // In scratch: pandoc writes beside where it runs, and the workspace is read-only.
        cwd: view.scratch,
        env: { ...env, R_KURAA: '1', KURAA_R_LIB: view.inside(where.lib) },
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
    return { ok: true, output: `out/document.${req.format}`, message: [`Rendered to ${NAMES[req.format]}.`, ...notes, ...(withoutLatex ? [withoutLatex] : [])].join(' '), log: text };
  }
  const why = typeof r?.message === 'string' && r.message.trim() ? r.message.trim() : `Rendering stopped unexpectedly (${exit.signal ?? `status ${exit.code}`}).`;
  return { ok: false, message: `The document could not be rendered: ${why}`, log: text };
}

export const rRenderer: DocumentRenderer = {
  extensions: ['.rmd', '.md', '.markdown'],
  formats: ['html', 'docx', 'pdf', 'epub'],
  render,
};
