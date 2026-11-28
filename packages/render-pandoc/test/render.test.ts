// Markdown rendered with pandoc.wasm and Typst (decision 0107): each format, the
// files a document refers to copied in only as the host gives them, nothing
// else of the computer reachable, by pandoc or by a document's own Typst.
// Skipped where the programs have not been fetched (scripts/fetch-render-tools.mjs).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RenderFormat, RendererContext } from '@kuraa/run-kit';
import vm from 'node:vm';
import { pandocRenderer, pandocWasm, sealGlue, typstParts } from '../src/index.js';
import { codeOf } from '../src/typst.js';

const PIXEL = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

describe.skipIf(!pandocWasm())('Markdown rendered without Podman (0107)', () => {
  let dir: string;
  let ws: string;
  let scratch: string;
  let asked: string[];

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-pandoc-'));
    ws = join(dir, 'workspace');
    scratch = join(dir, 'scratch');
    mkdirSync(join(ws, 'novel', 'art'), { recursive: true });
    mkdirSync(join(ws, '.git'), { recursive: true });
    mkdirSync(scratch);
    writeFileSync(join(ws, 'novel', 'art', 'pixel.png'), PIXEL);
    writeFileSync(join(ws, '.git', 'config'), 'SECRET-GIT');
    writeFileSync(join(dir, 'outside.png'), PIXEL);
    asked = [];
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  /** As the host gives files: the workspace's, but .git. */
  const ctx = (o: Partial<RendererContext> = {}): RendererContext => ({
    scratch, workspace: ws, timeLimitMs: 120_000, signal: new AbortController().signal, log: () => {}, status: () => {},
    read: async (p) => {
      asked.push(p);
      if (p.split('/')[0] === '.git') return null;
      try {
        return readFileSync(join(ws, p));
      } catch {
        return null;
      }
    },
    ...o,
  });
  const doc = (text: string) => {
    writeFileSync(join(ws, 'novel', 'a.md'), text);
    return join(ws, 'novel', 'a.md');
  };
  const render = async (input: string, format: RenderFormat, o?: Partial<RendererContext>) => {
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch);
    const r = await pandocRenderer.render(ctx(o), { input, format });
    return { ...r, file: r.output ? join(scratch, r.output) : null };
  };
  const unzip = (file: string, entry: string) => execFileSync('unzip', ['-p', file, entry], { encoding: 'utf8' });
  const entries = (file: string) => execFileSync('unzip', ['-Z1', file], { encoding: 'utf8' }).split('\n');

  it('renders to HTML, Word and EPUB, its images inside, its header followed', async () => {
    const input = doc('---\ntitle: The Coast\nauthor: Ada Byron\ntoc: true\nnumber-sections: true\n---\n\n# Arrival\n\nThe boat. $e^{i\\pi}$\n\n![A pixel](art/pixel.png)\n\n# Departure\n\nThe tide.[^1]\n\n[^1]: A note.\n');
    const html = await render(input, 'html');
    expect(html).toMatchObject({ ok: true, message: 'Rendered to HTML.' });
    const page = readFileSync(html.file!, 'utf8');
    expect(page).toContain('data:image/png;base64');
    expect(page).toMatch(/<math/);
    expect(page).toMatch(/id="TOC"|role="doc-toc"/);
    expect(page).toMatch(/<span class="header-section-number">1<\/span>/);
    const word = await render(input, 'docx');
    expect(word.ok).toBe(true);
    expect(entries(word.file!).some((e) => /^word\/media\/.*\.png$/.test(e))).toBe(true);
    expect(unzip(word.file!, 'word/document.xml')).toContain('The tide.');
    const epub = await render(input, 'epub');
    expect(epub.ok).toBe(true);
    expect(entries(epub.file!).some((e) => /^EPUB\/media\/.*\.png$/.test(e))).toBe(true);
  });

  it('uses the files its header names: a bibliography, a cover; for a book joined by the host, those beside it', async () => {
    writeFileSync(join(ws, 'novel', 'refs.bib'), '@book{doe, author = {Doe, Jane}, title = {Tides}, year = {1999}}\n');
    const input = doc('---\ntitle: The Coast\nbibliography: refs.bib\ncover-image: art/pixel.png\n---\n\nAs shown [@doe].\n');
    const html = await render(input, 'html');
    expect(html.ok).toBe(true);
    expect(readFileSync(html.file!, 'utf8')).toMatch(/Doe[\s\S]*1999/);
    const epub = await render(input, 'epub');
    expect(epub).toMatchObject({ ok: true, message: 'Rendered to EPUB.' });
    expect(entries(epub.file!)).toContain('EPUB/text/cover.xhtml');
    // Joined by the host (0093) in the render's scratch, which is inside the workspace's .git as the
    // host keeps it, a cover beside it by the name the header gives.
    const hostScratch = join(ws, '.git', 'kuraa', 'run', 'render', 'x');
    const joined = join(hostScratch, 'in');
    mkdirSync(joined, { recursive: true });
    writeFileSync(join(joined, 'cover.png'), PIXEL);
    writeFileSync(join(joined, 'book.md'), '---\ntitle: "Book"\ncover-image: "cover.png"\n---\n\n# One\n\n![A pixel](art/pixel.png)\n');
    const book = await pandocRenderer.render(ctx({ scratch: hostScratch }), { input: join(joined, 'book.md'), format: 'epub', resources: [join(ws, 'novel')] });
    expect(book).toMatchObject({ ok: true, message: 'Rendered to EPUB.' });
    expect(entries(join(hostScratch, book.output!))).toContain('EPUB/text/cover.xhtml');
    expect(asked).toContain('novel/art/pixel.png');
  });

  it.skipIf(!typstParts())('makes a PDF with Typst', async () => {
    const pdf = await render(doc('---\ntitle: The Coast\n---\n\n# Arrival\n\n![A pixel](art/pixel.png)\n'), 'pdf');
    expect(pdf).toMatchObject({ ok: true, message: 'Rendered to PDF.' });
    expect(readFileSync(pdf.file!).subarray(0, 5).toString()).toBe('%PDF-');
  });

  // 0130: images placed (fig-align) and columns, in each format.
  const LAID_OUT = '![Right](art/pixel.png){width=40% fig-align=right}\n\n![](art/pixel.png){width=20%}\n\n'
    + ':::: columns\n::: {.column width=30%}\nLeft words.\n:::\n\n::: {.column width=70%}\nRight words.\n:::\n::::\n';

  it('places images and puts columns side by side in HTML and EPUB', async () => {
    const input = doc(LAID_OUT);
    const page = readFileSync((await render(input, 'html')).file!, 'utf8');
    expect(page).toMatch(/<figure style="text-align:right;margin-left:0;margin-right:0">/);
    expect(page).toMatch(/style="width:40.0%"/);
    // An image without a caption, alone on its line: centred, as in the editor.
    expect(page).toMatch(/<div style="text-align:center">\s*<p><img [^>]*style="width:20.0%"/);
    expect(page).toMatch(/<div class="columns" style="display:flex;gap:1.5em;align-items:flex-start">\s*<div class="column" style="flex:30 1 0;min-width:0">\s*<p>Left words.<\/p>/);
    const epub = await render(input, 'epub');
    expect(epub.ok).toBe(true);
    const chapter = entries(epub.file!).find((e) => /^EPUB\/text\/ch\d+\.xhtml$/.test(e))!;
    expect(unzip(epub.file!, chapter)).toContain('style="flex:70 1 0;min-width:0"');
  });

  it('places images and puts columns side by side in Word: placement styles aligned, columns a table without borders', async () => {
    const word = await render(doc(LAID_OUT), 'docx');
    expect(word.ok).toBe(true);
    const body = unzip(word.file!, 'word/document.xml');
    expect(body).toContain('<w:pStyle w:val="ImageRight" />');
    expect(body).toContain('<w:pStyle w:val="ImageCaptionRight" />');
    expect(body).toContain('<w:pStyle w:val="ImageCentre" />');
    expect(body).toMatch(/<w:tbl>[\s\S]*Left words[\s\S]*Right words[\s\S]*<\/w:tbl>/);
    expect(body).toContain('<w:tblLook w:firstRow="0"');
    const styles = unzip(word.file!, 'word/styles.xml');
    expect(styles).toMatch(/w:styleId="ImageRight">[\s\S]*?<w:jc w:val="right" \/>/);
    expect(styles).toMatch(/w:styleId="ImageCaptionRight">[\s\S]*?<w:basedOn w:val="ImageCaption" \/>[\s\S]*?<w:jc w:val="right" \/>/);
    expect(styles).toMatch(/w:styleId="ImageCentre">[\s\S]*?<w:jc w:val="center" \/>/);
  });

  it.skipIf(!typstParts())('places images and puts columns side by side in a PDF: Typst’s figure placement and grid', async () => {
    const pdf = await render(doc(LAID_OUT), 'pdf');
    expect(pdf).toMatchObject({ ok: true, message: 'Rendered to PDF.' });
    const typ = readFileSync(join(scratch, 'out', 'document.typ'), 'utf8');
    expect(typ).toMatch(/#\[#show figure: set align\(right\)\s*#figure\(image\("[^"]*pixel\.png", width: 40\.0%/);
    expect(typ).toMatch(/#align\(center\)\[\s*#box\(image\("[^"]*pixel\.png", width: 20\.0%/);
    expect(typ).toMatch(/#grid\(columns: \(30fr, 70fr\), column-gutter: 1\.5em,\s*\[\s*Left words\.\s*\],\s*\[\s*Right words\.\s*\],\s*\)/);
  });

  it('copies in only what the host gives: nothing outside the workspace, nothing of .git; what cannot be had, its description', async () => {
    const input = doc(`Words.\n\n![Outside](../../outside.png)\n\n![Hosts](/etc/hosts)\n\n![Git](../.git/config)\n\n![Web](https://example.org/x.png)\n\n<img src="../.git/config">\n`);
    const r = await render(input, 'html');
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/4 images could not be found in the workspace/);
    const page = readFileSync(r.file!, 'utf8');
    expect(page).not.toContain('SECRET-GIT');
    expect(page).not.toContain(Buffer.from('SECRET-GIT').toString('base64'));
    expect(page).toContain('Outside');
    // Asked of the host only for what is in the workspace.
    expect(asked).toEqual(['.git/config']);
  });

  it.skipIf(!typstParts())('a document’s own Typst reads nothing but the copies, and gets no package', async () => {
    for (const path of ['/etc/hosts', join(dir, 'outside.png'), '../../../../etc/hosts', '/work/ws/.git/config']) {
      const r = await render(doc(`\`\`\`{=typst}\n#read("${path}")\n\`\`\`\n`), 'pdf');
      expect(r.ok, path).toBe(false);
      expect(r.message, path).toMatch(/^The document could not be rendered: Typst: (failed to load file|path .* would escape)/);
    }
    const started = Date.now();
    const pkg = await render(doc('```{=typst}\n#import "@preview/example:0.1.0": *\n```\n'), 'pdf');
    expect(pkg.ok).toBe(false);
    expect(pkg.message).toMatch(/failed to load package/);
    expect(Date.now() - started).toBeLessThan(20_000);
    // What was copied in, it can read (the image the document names); and its own Typst otherwise works: a page break.
    expect((await render(doc('![A pixel](art/pixel.png)\n\n```{=typst}\n#let b = read("/work/ws/novel/art/pixel.png", encoding: none)\nBytes: #b.len()\n#pagebreak()\n```\n\nTwo.\n'), 'pdf')).ok).toBe(true);
  });

  it.skipIf(!typstParts())('seals Typst in a context with nothing of Node’s, no code from strings, and no imports', async () => {
    const context = vm.createContext(vm.constants.DONT_CONTEXTIFY, { codeGeneration: { strings: false, wasm: true } });
    vm.runInContext(await codeOf(typstParts()!.glue), context);
    const probe = async (code: string) => {
      try {
        return String(await vm.runInContext(code, context));
      } catch (e) {
        return `throws ${(e as Error).name}`;
      }
    };
    expect(await probe('typeof process + typeof require + typeof fetch + typeof Buffer')).toBe('undefinedundefinedundefinedundefined');
    expect(await probe('new Function("return 1")()')).toBe('throws EvalError');
    expect(await probe('eval("1")')).toBe('throws EvalError');
    expect(await probe('globalThis.constructor.constructor("return typeof process")()')).toBe('throws EvalError');
    expect(await probe('(async () => {}).constructor("return 1")')).toBe('throws EvalError');
    expect(await probe('import("node:fs").then(() => "imported", (e) => "refused")')).toBe('refused');
    // The glue's own new Function: the fixed few, nothing else.
    expect(await probe('__fixed("return true")()')).toBe('true');
    expect(await probe('__fixed("return process")')).toBe('throws Error');
  });

  it('refuses a typst.ts that makes or loads code in another way', () => {
    const ok = 'export class TypstCompilerBuilder {}\nfunction initSync() {}\nconst ret = new Function(getStringFromWasm0(arg0, arg1));\n';
    expect(sealGlue(ok)).not.toMatch(/new Function/);
    expect(() => sealGlue(`${ok}\nconst other = new Function('a', 'b');\n`)).toThrow(/does not expect/);
    expect(() => sealGlue(`${ok}\nawait import('fs');\n`)).toThrow(/does not expect/);
    expect(() => sealGlue('function initSync() {}\n')).toThrow(/knows how to drive/);
  });

  it('would rather an engine made a PDF its header asks LaTeX for', async () => {
    expect(await pandocRenderer.prefersEngine!({ input: doc('---\npdf-engine: xelatex\n---\nHi.\n'), format: 'pdf' })).toMatch(/xelatex/);
    expect(await pandocRenderer.prefersEngine!({ input: doc('---\noutput:\n  pdf_document:\n    latex_engine: lualatex\n---\nHi.\n'), format: 'pdf' })).toMatch(/lualatex/);
    expect(await pandocRenderer.prefersEngine!({ input: doc('---\npdf-engine: xelatex\n---\nHi.\n'), format: 'docx' })).toBeNull();
    expect(await pandocRenderer.prefersEngine!({ input: doc('Hi.\n'), format: 'pdf' })).toBeNull();
  });

  it('stops at its time limit, and when asked to', async () => {
    const long = doc(Array.from({ length: 20_000 }, (_, i) => `Paragraph ${i} of many words, and more of them.`).join('\n\n'));
    const r = await render(long, 'docx', { timeLimitMs: 50 });
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toMatch(/longer than|stopped/);
    const stop = new AbortController();
    const going = render(long, 'docx', { signal: stop.signal });
    setTimeout(() => stop.abort(), 100);
    expect((await going).message).toMatch(/was stopped/);
  });
});
