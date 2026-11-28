// A Markdown document rendered by pandoc.wasm, and Typst for a PDF (decision
// 0107), with nothing of the computer's open to either but this render's
// scratch folder:
//
//   1. the document, copied into scratch/work, read by pandoc into its syntax
//      tree (JSON);
//   2. each file the tree refers to (images, in HTML too; the bibliography,
//      CSL, styles, a Word template, a cover) asked of the host
//      (RendererContext.read: inside the workspace, no links, not .git, not
//      hidden from the document's readers) and copied in beside it, the tree
//      pointing at the copy; an image that cannot be had is its description;
//   3. the tree written to the format by pandoc, seeing scratch/work and
//      scratch/out alone;
//   4. for a PDF, Typst on what pandoc wrote: its root scratch (it reads
//      nothing outside), with no packages and nowhere to fetch one from (a
//      proxy that answers nothing), so a document's own Typst can do no more.
import { execFile } from 'node:child_process';
import { appendFile, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, posix, relative, resolve, sep } from 'node:path';
import type { RenderFormat, RenderRequest, RenderResult, RendererContext } from '@kuraa/run-kit';
import { headerOf, headerOptions } from './header.js';
import { runPandoc } from './wasi.js';

const NAMES: Record<RenderFormat, string> = { html: 'HTML', docx: 'Word', pdf: 'PDF', epub: 'EPUB' };
/** What a render's log keeps. */
const MAX_LOG = 400_000;
/** An address that answers nothing: where Typst is told to fetch packages through. */
const NOWHERE = 'http://127.0.0.1:9';

const inside = (root: string, p: string) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);
const toPosix = (p: string) => p.split(sep).join('/');

type Node = { t?: string; c?: unknown };

/** Every object in pandoc's JSON, depth first. */
function each(v: unknown, fn: (n: Node) => void): void {
  if (Array.isArray(v)) for (const x of v) each(x, fn);
  else if (v && typeof v === 'object') {
    fn(v as Node);
    for (const x of Object.values(v)) each(x, fn);
  }
}

/** A reference that is not a file here: a web address, data. */
const notAFile = (ref: string) => /^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith('//') || ref.startsWith('#');

export async function renderMarkdown(ctx: RendererContext, req: RenderRequest, programs: { wasm: string; typst: string | null }): Promise<RenderResult> {
  const deadline = Date.now() + ctx.timeLimitMs;
  const left = () => Math.max(1000, deadline - Date.now());
  const ext = req.format;
  const work = join(ctx.scratch, 'work');
  const out = join(ctx.scratch, 'out');
  const logFile = join(ctx.scratch, 'render.log');
  const stdin = join(ctx.scratch, 'nothing');
  await Promise.all([mkdir(work, { recursive: true }), mkdir(out, { recursive: true })]);
  await writeFile(stdin, '');
  await writeFile(logFile, '');
  const notes: string[] = [];
  const log = async () => {
    const text = (await readFile(logFile, 'utf8').catch(() => '')).trim();
    return text.length > MAX_LOG ? `…\n${text.slice(-MAX_LOG)}` : text;
  };

  // The document, in the workspace or (a book joined from several: 0093) made by the host beside the files it names.
  const workspace = resolve(ctx.workspace);
  const input = resolve(req.input);
  // Made by the host in this render's scratch (which may itself be inside the workspace, in .git), or a document of the workspace.
  const fromWorkspace = !inside(resolve(ctx.scratch), input) && inside(workspace, input);
  const own = dirname(input);
  const text = await readFile(input, 'utf8');
  const key = fromWorkspace ? `ws/${toPosix(relative(workspace, input))}` : `in/${basename(input)}`;
  await mkdir(dirname(join(work, key)), { recursive: true });
  await writeFile(join(work, key), text);

  /** A file it refers to, copied in: where pandoc sees the copy, or null. */
  const provided = new Map<string, Promise<string | null>>();
  const provide = (ref: string): Promise<string | null> => {
    if (!provided.has(ref)) provided.set(ref, (async () => {
      if (notAFile(ref)) return null;
      let decoded = ref;
      try {
        decoded = decodeURI(ref);
      } catch { /* as it is */ }
      for (const dir of [own, ...(req.resources ?? []).map((r) => resolve(r))]) {
        for (const name of new Set([ref, decoded])) {
          const abs = resolve(dir, name);
          let bytes: Buffer | null;
          let to: string;
          if (!fromWorkspace && inside(own, abs) && abs !== own) {
            // Beside a joined book: what the host put there (a template, a cover), as plain files.
            const st = await lstat(abs).catch(() => null);
            bytes = st?.isFile() ? await readFile(abs) : null;
            to = `in/${toPosix(relative(own, abs))}`;
          } else if (inside(workspace, abs) && abs !== workspace) {
            const rel = toPosix(relative(workspace, abs));
            bytes = await ctx.read(rel);
            to = `ws/${rel}`;
          } else continue;
          if (!bytes) continue;
          await mkdir(dirname(join(work, to)), { recursive: true });
          await writeFile(join(work, to), bytes);
          return `/work/${to}`;
        }
      }
      return null;
    })());
    return provided.get(ref)!;
  };

  const pandoc = async (args: string[]) => {
    await appendFile(logFile, `pandoc ${args.join(' ')}\n`);
    const r = await runPandoc(programs.wasm, args, { preopens: { '/work': work, '/out': out }, log: logFile, stdin, timeLimitMs: left(), signal: ctx.signal });
    if (r.stopped) return r.stopped;
    if (r.code !== 0) {
      const said = (await log()).split('\n').filter((l) => l.trim() && !/^\[WARNING\]/.test(l) && !l.startsWith('pandoc /'));
      return `pandoc: ${said.at(-1) ?? `it stopped with status ${r.code}`}`;
    }
    return null;
  };

  // 1. The document as pandoc's tree.
  ctx.status('Reading the document…');
  const read = await pandoc([`/work/${key}`, '-f', 'markdown', '-t', 'json', '-o', '/out/tree.json']);
  if (read) return { ok: false, message: `The document could not be rendered: ${read}`, log: await log() };
  const tree = JSON.parse(await readFile(join(out, 'tree.json'), 'utf8')) as unknown;

  // 2. What it refers to, copied in; the tree pointing at the copies.
  const images: Node[] = [];
  const raws: Node[] = [];
  each(tree, (n) => {
    if (n.t === 'Image') images.push(n);
    else if ((n.t === 'RawBlock' || n.t === 'RawInline') && Array.isArray(n.c) && n.c[0] === 'html') raws.push(n);
  });
  const missing = new Set<string>();
  for (const n of images) {
    const c = n.c as [unknown, unknown, [string, string]];
    const target = c[2]?.[0] ?? '';
    if (target.startsWith('data:')) continue;
    const at = await provide(target);
    if (at) c[2][0] = at;
    else {
      // Its description in its place: pandoc here fetches nothing else.
      missing.add(target);
      n.t = 'Span';
      n.c = [c[0], c[1]];
    }
  }
  for (const n of raws) {
    const c = n.c as [string, string];
    const refs = [...c[1].matchAll(/\b(src|href)\s*=\s*(["'])([^"']+)\2/gi)].map((m) => m[3]!);
    for (const ref of new Set(refs)) {
      const at = await provide(ref);
      if (at) c[1] = c[1].split(ref).join(at);
    }
  }
  // Files the header names are given as flags, pointing at the copies: pandoc is not to look for them itself.
  const meta = (tree as { meta?: Record<string, unknown> }).meta;
  if (meta) for (const k of ['bibliography', 'csl', 'css', 'reference-doc', 'cover-image']) delete meta[k];
  if (missing.size) notes.push(`${missing.size === 1 ? 'An image' : `${missing.size} images`} could not be found in the workspace, and ${missing.size === 1 ? 'its description is' : 'their descriptions are'} shown instead: ${[...missing].slice(0, 5).join(', ')}${missing.size > 5 ? ', …' : ''}.`);
  await writeFile(join(out, 'tree.json'), JSON.stringify(tree));

  const header = headerOf(text);
  const o = headerOptions(header, req.format);
  const files = async (flag: string, refs: string[]) => {
    const got: string[] = [];
    for (const ref of refs) {
      const at = await provide(ref);
      if (at) got.push(`${flag}=${at}`);
      else notes.push(`${ref}, which the header names, could not be found in the workspace, and was left out.`);
    }
    return got;
  };
  const stem = basename(input).replace(/\.[^.]*$/, '');
  const args = ['/out/tree.json', '-f', 'json', '--standalone', '--citeproc', `--resource-path=/work/${posix.dirname(key)}`];
  args.push(...await files('--bibliography', o.bibliography));
  if (o.csl) args.push(...await files('--csl', [o.csl]));
  if (o.toc) args.push('--toc');
  if (o.numbered) args.push('--number-sections');
  if (ext === 'html') {
    args.push('--embed-resources', '--math-method=mathml', ...await files('--css', o.css));
    if (!o.titled) args.push(`--metadata=pagetitle:${stem}`);
  }
  if (ext === 'docx' && o.referenceDoc) args.push(...await files('--reference-doc', [o.referenceDoc]));
  if (ext === 'epub') {
    args.push('--math-method=mathml');
    if (!o.titled) args.push(`--metadata=title:${stem}`);
    if (o.cover) args.push(...await files('--epub-cover-image', [o.cover]));
  }
  args.push(...(ext === 'pdf' ? ['-t', 'typst', '-o', '/out/document.typ'] : ['-o', `/out/document.${ext}`]));

  // 3. Written to the format.
  ctx.status(ext === 'pdf' ? 'Writing it for Typst…' : `Writing ${NAMES[ext]}…`);
  const wrote = await pandoc(args);
  if (wrote) return { ok: false, message: `The document could not be rendered: ${wrote}`, log: await log() };

  // 4. A PDF: Typst, on what pandoc wrote.
  if (ext === 'pdf') {
    if (!programs.typst) return { ok: false, message: 'Making a PDF needs Typst, which is not on this computer. Render to HTML, Word or EPUB instead.', log: await log() };
    if (o.latex) notes.push(`The header asks for ${o.latex}; PDFs are made with LaTeX only where code runs (Podman), which is not here, so this one was made with Typst: settings only LaTeX understands were left out.`);
    ctx.status('Making the PDF…');
    const typst = await runTypst(programs.typst, ctx.scratch, left(), ctx.signal);
    await writeFile(logFile, `${await readFile(logFile, 'utf8')}\n${typst.said}`);
    if (!typst.ok) return { ok: false, message: `The document could not be rendered: ${typst.message}`, log: await log() };
  }
  return { ok: true, output: `out/document.${ext}`, message: [`Rendered to ${NAMES[ext]}.`, ...notes].join(' '), log: await log() };
}

/** Typst, reading only scratch, with no packages and nowhere to fetch one from. */
function runTypst(program: string, scratch: string, timeLimitMs: number, signal: AbortSignal): Promise<{ ok: boolean; message: string; said: string }> {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG'];
  const env: Record<string, string> = Object.fromEntries(keep.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
  Object.assign(env, {
    TYPST_PACKAGE_PATH: join(scratch, 'packages'),
    TYPST_PACKAGE_CACHE_PATH: join(scratch, 'packages'),
    HTTPS_PROXY: NOWHERE, HTTP_PROXY: NOWHERE, ALL_PROXY: NOWHERE, https_proxy: NOWHERE, http_proxy: NOWHERE, all_proxy: NOWHERE, NO_PROXY: '', no_proxy: '',
  });
  return new Promise((done) => {
    execFile(program, ['compile', '--root', scratch, join(scratch, 'out', 'document.typ'), join(scratch, 'out', 'document.pdf')], { env, cwd: scratch, timeout: timeLimitMs, signal, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      const said = `${stdout}${stderr}`.trim();
      if (!err) return done({ ok: true, message: '', said });
      const e = err as NodeJS.ErrnoException & { killed?: boolean };
      if (e.name === 'AbortError') return done({ ok: false, message: 'The render was stopped.', said });
      if (e.killed) return done({ ok: false, message: `The render took longer than ${Math.round(timeLimitMs / 1000)} seconds, the most this host allows, and was stopped.`, said });
      const last = said.split('\n').find((l) => /^error:/.test(l.trim()));
      done({ ok: false, message: `Typst: ${last?.replace(/^\s*error:\s*/, '') ?? e.message}`, said });
    });
  });
}

/** The LaTeX engine a document's header asks for, if any, for a PDF. */
export async function latexAsked(input: string): Promise<string | null> {
  const text = await readFile(input, 'utf8').catch(() => '');
  return headerOptions(headerOf(text), 'pdf').latex;
}
