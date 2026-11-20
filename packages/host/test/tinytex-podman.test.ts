// PDFs with LaTeX for real (decision 0045): TinyTeX downloaded into a fresh data
// folder, R Markdown and Markdown asking for xelatex rendered to PDF in Podman,
// and a document that needs a LaTeX package TinyTeX lacks (tcolorbox), which is
// added and recorded. Skipped unless KURAA_TEST_TINYTEX=1 (it downloads TeX,
// about 54 MB, and packages from CTAN) and Podman is running.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { podmanWorks } from '@kuraa/env-podman';
import { standardRunComponents } from '@kuraa/run-components';
import { startHost, type RunningHost } from '../src/index.js';
import type { RenderInfo, RenderState } from '../src/renders.js';
import type { ToolInfo } from '../src/tools.js';

const ON = process.env.KURAA_TEST_TINYTEX === '1' && podmanWorks();
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
const ADA = { name: 'Ada', email: 'ada@example.org', color: '#123456' };
const took = (since: number) => `${((Date.now() - since) / 1000).toFixed(1)} s`;

const RMD = `---
title: "Tides"
output:
  pdf_document:
    latex_engine: xelatex
---

The answer is \`r 6 * 7\`, and $\\sum_i x_i$ is set by LaTeX.

\`\`\`{r}
plot(1:10)
\`\`\`
`;

const MD = `---
title: Notes
pdf-engine: xelatex
---

# Notes

Ünïcödé and math: $e^{i\\pi} + 1 = 0$.
`;

const BOXED = `---
title: Boxed
output:
  pdf_document:
    latex_engine: xelatex
header-includes:
  - \\usepackage{tcolorbox}
---

\\begin{tcolorbox}
In a box.
\\end{tcolorbox}
`;

describe.skipIf(!ON)('PDF with LaTeX, in Podman', () => {
  let dir: string;
  let data: string;
  let running: RunningHost;

  const api = (path: string, init: RequestInit = {}) =>
    fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' } });

  async function render(path: string): Promise<RenderState> {
    const res = await api('/api/renders', { method: 'POST', body: JSON.stringify({ path, format: 'pdf', by: ADA }) });
    const state = (await res.json()) as RenderState;
    if (res.status !== 202) return state;
    for (let i = 0; i < 6000; i++) {
      const info = (await (await api(`/api/renders?path=${encodeURIComponent(path)}`)).json()) as RenderInfo;
      const r = info.renders.find((x) => x.format === 'pdf');
      if (r && r.state !== 'rendering') return r;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('render did not finish');
  }
  const pdf = async (path: string) => Buffer.from(await (await api(`/api/renders/file?path=${encodeURIComponent(path)}&format=pdf`)).arrayBuffer());

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-tinytex-'));
    data = mkdtempSync(join(tmpdir(), 'kuraa-tinytex-data-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'user.email', 't@example.org');
    writeFileSync(join(dir, 'tides.Rmd'), RMD);
    writeFileSync(join(dir, 'notes.md'), MD);
    writeFileSync(join(dir, 'boxed.Rmd'), BOXED);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    running = await startHost({ dir, port: 0, run: { engines: ['r'], components: standardRunComponents, allowInstalls: true, dataDir: data }, log: (m) => process.env.KURAA_TEST_LOG && console.log(m) });
  }, 60_000);

  afterAll(async () => {
    await running?.close();
    rmSync(dir, { recursive: true, force: true });
    if (process.env.KURAA_TEST_KEEP) console.log(`kept ${data}`);
    else rmSync(data, { recursive: true, force: true });
  });

  it('offers the download, downloads TinyTeX, and makes PDFs with xelatex from R Markdown and Markdown', async () => {
    const offered = await render('tides.Rmd');
    expect(offered.state).toBe('failed');
    expect(offered.needs).toMatchObject({ tool: 'tinytex', label: 'PDF with LaTeX' });

    let t0 = Date.now();
    expect((await api('/api/tools/download', { method: 'POST', body: JSON.stringify({ id: 'tinytex' }) })).status).toBe(202);
    let tool: ToolInfo | undefined;
    for (let i = 0; i < 6000; i++) {
      tool = ((await (await api('/api/tools')).json()) as { tools: ToolInfo[] }).tools.find((x) => x.id === 'tinytex');
      if (tool?.state !== 'downloading') break;
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(tool, tool?.error ?? '').toMatchObject({ state: 'ready' });
    console.log(`TinyTeX: downloaded and installed in ${took(t0)} (installer image included), ${(tool!.size! / 1e6).toFixed(0)} MB on disk`);

    t0 = Date.now();
    const rmd = await render('tides.Rmd');
    console.log(`R Markdown with xelatex: ${took(t0)}`);
    expect(rmd.state, `${rmd.message}\n${rmd.log}`).toBe('done');
    expect(rmd.message).not.toMatch(/Typst/);
    expect(rmd.log).toMatch(/xelatex/);
    expect((await pdf('tides.Rmd')).subarray(0, 5).toString()).toBe('%PDF-');

    t0 = Date.now();
    const md = await render('notes.md');
    console.log(`Markdown with xelatex: ${took(t0)}`);
    expect(md.state, `${md.message}\n${md.log}`).toBe('done');
    expect(md.log).toMatch(/--pdf-engine=xelatex/);
    expect((await pdf('notes.md')).subarray(0, 5).toString()).toBe('%PDF-');
  }, 1_800_000);

  it('adds a LaTeX package a document needs, renders again, and records it in the workspace', async () => {
    const t0 = Date.now();
    const boxed = await render('boxed.Rmd');
    console.log(`Adding tcolorbox and rendering again: ${took(t0)}`);
    expect(boxed.state, `${boxed.message}\n${boxed.log}`).toBe('done');
    expect(boxed.message).toMatch(/Added tcolorbox/);
    expect((await pdf('boxed.Rmd')).subarray(0, 5).toString()).toBe('%PDF-');
    expect(JSON.parse(readFileSync(join(dir, '.kuraa/tex-packages.json'), 'utf8'))).toEqual({ packages: ['tcolorbox'] });
    expect(git(dir, 'log', '-1', '--format=%s', '--', '.kuraa/tex-packages.json')).toBe('LaTeX packages: add tcolorbox');
  }, 1_800_000);
});
