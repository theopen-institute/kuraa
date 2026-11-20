// Rendering documents for real: R Markdown through rmarkdown and Markdown through
// pandoc, in Podman containers, to HTML, Word and PDF (Typst). Skipped unless
// Podman is installed and running; the first render builds the R image.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { podmanWorks } from '@kuraa/env-podman';
import { standardRunComponents } from '@kuraa/run-components';
import { startHost, type RunningHost } from '../src/index.js';
import type { RenderInfo, RenderState } from '../src/renders.js';

const PODMAN_OK = podmanWorks();
const git = (dir: string, ...args: string[]) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' }).trim();
// A one-pixel PNG.
const DOT = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');

const RMD = `---
title: "Tidal analysis"
bibliography: refs.bib
output:
  html_document:
    toc: true
---

# Results

As @ada2020 found, the answer is \`r 6 * 7\`. Area: $\\pi r^2$.

\`\`\`{r plot}
plot(1:10)
\`\`\`

![A dot](dot.png)
`;

describe.skipIf(!PODMAN_OK)('rendering in Podman', () => {
  let dir: string;
  let running: RunningHost;

  const api = (path: string, init: RequestInit = {}) =>
    fetch(running.url + path, { ...init, headers: { authorization: `Bearer ${running.token}`, 'content-type': 'application/json' } });

  async function render(path: string, format: string): Promise<RenderState> {
    const res = await api('/api/renders', { method: 'POST', body: JSON.stringify({ path, format }) });
    expect(res.status).toBe(202);
    for (let i = 0; i < 3000; i++) {
      const info = (await (await api(`/api/renders?path=${encodeURIComponent(path)}`)).json()) as RenderInfo;
      const r = info.renders.find((x) => x.format === format);
      if (r && r.state !== 'rendering') return r;
      await new Promise((r) => setTimeout(r, 200));
    }
    throw new Error('render did not finish');
  }
  const output = async (path: string, format: string) => Buffer.from(await (await api(`/api/renders/file?path=${encodeURIComponent(path)}&format=${format}`)).arrayBuffer());

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'kuraa-render-podman-'));
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'T');
    git(dir, 'config', 'user.email', 't@example.org');
    mkdirSync(join(dir, 'paper'));
    writeFileSync(join(dir, 'paper/analysis.Rmd'), RMD);
    writeFileSync(join(dir, 'paper/notes.md'), '---\ntitle: Notes\nbibliography: refs.bib\n---\n\nSee @ada2020.\n\n![A dot](dot.png)\n');
    writeFileSync(join(dir, 'paper/plain.md'), '# Plain\n\nNothing to fetch, so pandoc runs in its own sandbox too.\n');
    writeFileSync(join(dir, 'paper/broken.Rmd'), '# Broken\n\n```{r}\nstop("the data file is missing")\n```\n');
    writeFileSync(join(dir, 'paper/refs.bib'), '@article{ada2020, title = {Tides}, author = {Lovelace, Ada}, year = {2020}, journal = {Sea}}\n');
    writeFileSync(join(dir, 'paper/dot.png'), DOT);
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'Initial');
    running = await startHost({ dir, port: 0, run: { engines: ['r'], components: standardRunComponents } });
  });

  afterAll(async () => {
    await running?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('knits R Markdown to self-contained HTML, with code run, citations, math and images', async () => {
    const state = await render('paper/analysis.Rmd', 'html');
    expect(state.message, state.log).toBe('Rendered to HTML.');
    const html = (await output('paper/analysis.Rmd', 'html')).toString();
    expect(html).toMatch(/the answer is\s+42/);
    expect(html).toContain('Lovelace');
    expect(html).toContain('<math');
    // The plot and the picture, inside the page.
    expect(html.match(/src="data:image\/png/g)?.length).toBeGreaterThanOrEqual(2);
    // Nothing written into the workspace.
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  }, 900_000);

  it('makes Word and PDF (with Typst), from R Markdown and Markdown', async () => {
    for (const path of ['paper/analysis.Rmd', 'paper/notes.md']) {
      const docx = await render(path, 'docx');
      expect(docx.state, `${docx.message}\n${docx.log}`).toBe('done');
      expect((await output(path, 'docx')).subarray(0, 2).toString()).toBe('PK');
      const pdf = await render(path, 'pdf');
      expect(pdf.state, `${pdf.message}\n${pdf.log}`).toBe('done');
      expect((await output(path, 'pdf')).subarray(0, 5).toString()).toBe('%PDF-');
    }
    const md = await render('paper/notes.md', 'html');
    const html = (await output('paper/notes.md', 'html')).toString();
    expect(md.state).toBe('done');
    expect(html).toContain('Lovelace');
    expect(html).toContain('data:image/png');
    expect((await render('paper/plain.md', 'html')).log).toContain('--sandbox');
    expect(git(dir, 'status', '--porcelain', '--untracked-files=all')).toBe('');
  }, 600_000);

  it('says in plain words why a document could not be rendered, with the log behind it', async () => {
    const state = await render('paper/broken.Rmd', 'html');
    expect(state.state).toBe('failed');
    expect(state.message).toContain('The document could not be rendered');
    expect(state.message).toContain('the data file is missing');
    expect(state.log).toContain('Quitting from');
  }, 300_000);
});
