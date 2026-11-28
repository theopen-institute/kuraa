// A file converted into Markdown by pandoc.wasm (decision 0116: importing):
// Word, OpenDocument, RTF, EPUB or HTML in; pandoc's Markdown out, with the
// images it held extracted beside it. pandoc sees only the render's scratch
// folder (the file, copied there by the host, and where it writes), as for
// rendering (0107).
import { readdir, readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { extname, join, posix, relative, sep } from 'node:path';
import type { ConvertRequest, ConvertResult, RendererContext } from '@kuraa/run-kit';
import { runPandoc } from './wasi.js';

/** pandoc's reader for each extension it converts from. */
export const READERS: Record<string, string> = {
  '.docx': 'docx',
  '.odt': 'odt',
  '.rtf': 'rtf',
  '.epub': 'epub',
  '.html': 'html',
  '.htm': 'html',
};

const MAX_LOG = 100_000;

/** Every file under a folder, as paths relative to it ('/'-separated). */
async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  await walk(dir);
  return out;
}

export async function convertToMarkdown(ctx: RendererContext, req: ConvertRequest, wasm: string): Promise<ConvertResult> {
  const ext = extname(req.input).toLowerCase();
  const reader = READERS[ext];
  if (!reader) return { ok: false, message: `${ext || 'This kind of file'} is not one that can be imported.`, log: '' };
  const work = join(ctx.scratch, 'work');
  const out = join(ctx.scratch, 'out');
  const log = join(ctx.scratch, 'convert.log');
  const stdin = join(ctx.scratch, 'nothing');
  await Promise.all([mkdir(work, { recursive: true }), mkdir(out, { recursive: true })]);
  await writeFile(log, '');
  await writeFile(stdin, '');
  await writeFile(join(work, `in${ext}`), await readFile(req.input));
  const args = [`/work/in${ext}`, '-f', reader, '-t', 'markdown', '--standalone', '--wrap=none', '--extract-media=/out/media', '-o', '/out/out.md'];
  // Changes a Word file tracks: as they would read once accepted.
  if (reader === 'docx') args.push('--track-changes=accept');
  ctx.status('Converting…');
  const r = await runPandoc(wasm, args, { preopens: { '/work': work, '/out': out }, log, stdin, timeLimitMs: ctx.timeLimitMs, signal: ctx.signal });
  const said = (await readFile(log, 'utf8').catch(() => '')).trim().slice(-MAX_LOG);
  if (r.stopped) return { ok: false, message: r.stopped, log: said };
  if (r.code !== 0) {
    const last = said.split('\n').filter((l) => l.trim() && !/^\[WARNING\]/.test(l)).at(-1);
    return { ok: false, message: `It could not be read: pandoc: ${last ?? `it stopped with status ${r.code}`}`, log: said };
  }
  const markdown = await readFile(join(out, 'out.md'), 'utf8');
  const media: { name: string; file: string }[] = [];
  for (const rel of await filesUnder(join(out, 'media'))) {
    const file = posix.join('out', 'media', rel);
    if ((await stat(join(ctx.scratch, file))).size > 0) media.push({ name: `/out/media/${rel}`, file });
  }
  return { ok: true, markdown, media, message: 'Converted.', log: said };
}
