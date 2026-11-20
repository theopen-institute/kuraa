# 0041 · Rendering documents to HTML, Word and PDF, where code runs

Knitting is the core of the R Markdown workflow: a document becomes a page, a Word file or a PDF
to send. It runs the document's code and reads its files, so it runs where code runs, never on the
host's computer ([0018](0018-untrusted-users.md)), and the host knows neither R nor pandoc
([0019](0019-engine-and-environment-components.md)).

**In the run contract.** An engine may have a `render` (`DocumentRenderer` in `@kuraa/run-kit`):
the file extensions it renders, the formats (`html`, `docx`, `pdf`), and `render(ctx, req)`. The
context is a component context with its own empty scratch folder, a time limit and an abort signal;
the policy is the operator's (memory, CPUs, disk), with the workspace **read-only and no network**
whatever `.kuraa/run.json` asks for. The renderer starts its processes through the environment, as
sessions do, and answers with the output's place in scratch, a plain-language message and the log.
The contract grew only optional members, so `RUN_API_VERSION` stays 1. Rendering is on wherever an
engine that renders is on (`--engine r`); there is no separate flag.

**R's renderer** (`packages/engine-r/src/render.ts`, `render-script.ts`) runs one `Rscript` per
render in the R image. R Markdown goes through `rmarkdown::render`, knitted in the document's folder
with intermediates and output in scratch, so nothing is written beside the document and the
workspace can stay read-only (checked against Podman). Markdown goes to `pandoc` directly, run from
scratch with the document's folder as its resource path. The workspace's own R packages are visible,
read-only, as for runs.

- **HTML** is always self-contained (images, styles, the plot of every chunk inside the page), with
  math as MathML unless the header chooses another method: it shows without scripts or the network.
- **Word** uses the header's Word format and its options (`reference_docx`).
- **PDF without TeX.** A TeX installation is gigabytes; Typst is one small program. The image has
  Typst (the one RStudio's Quarto brings in `rocker/tidyverse`, else release 0.14.2, checked against
  its SHA-256), and PDFs are made with `pandoc --pdf-engine=typst` (for R Markdown, a format with
  rmarkdown's knitting and pandoc writing Typst). When the header asks for a LaTeX engine
  (`latex_engine`, `pdf-engine`) and the environment has it, LaTeX is used instead. When it asks for
  one the environment lacks, the PDF is made with Typst and the message says so ("settings only
  LaTeX understands were left out"). With neither, the message says to render to HTML or Word.
  *Since [0045](0045-tools.md):* LaTeX is a tool, TinyTeX, downloaded on request where installs are
  allowed and mounted read-only into the renders that ask for it; without it, the render offers the
  download, and falls back to Typst only where downloads are not allowed, saying why.
- **The header.** R Markdown's `output:` decides the format function and its options (the first
  `…html…`, `…word…|…docx…`, `…pdf…` entry; `bookdown::html_document2` and the like work if
  installed); `toc` and `number_sections`, and a Quarto-style `format:` (`toc`, `number-sections`,
  `pdf-engine`), apply where the format is ours.
- **pandoc's `--sandbox`** is used for a Markdown document that reads no files besides its
  bibliography: in its sandbox pandoc cannot read images (they would be dropped from the page) or
  CSL, include and reference files. Either way the container sees only the workspace, read-only,
  without `.git`, and no network.

**The host** (`packages/host/src/renders.ts`) writes the document's open room to its file first, so
the render is of the document as it is now, including what was typed a second ago. One render at a
time per document; asking for one under way joins it. The output is read from scratch only through
real folders and with `O_NOFOLLOW` (a link left by code in the document is refused), at most
256 MB, and kept in `.git/kuraa/renders/`, never in the working tree, with what was said (state,
message, log, who asked, when). A render past its time (`renderTimeoutMs`, default 10 minutes, not
counting an image build) is stopped and says so; past the disk limit, the environment's reason is
given. The API: `GET /api/renders?path=` (formats, why not, the latest renders), `POST /api/renders`,
`GET /api/renders/file?path=&format=` (as an attachment; HTML with
`Content-Security-Policy: sandbox; default-src 'none'; …`, so even opened on its own it runs nothing).

**In the app** (`RenderPanel.vue`), **Preview** in the menu or ⇧⌘R renders to HTML and shows it in
a frame sandboxed without `allow-scripts` or `allow-same-origin`, with a policy of its own in the
page's head (`default-src 'none'`, images, styles and fonts only from inside the page), on top of the
app's. Chunks, widgets and scripts in a page therefore do nothing in the preview, as 0018 requires;
the saved HTML works fully in a browser. **Update when saved** renders again each time the document
is written to its file. **Save as** HTML, Word or PDF renders that format and saves it: a download in
a browser, a save dialog in the desktop app. Progress (building the environment, rendering) and
errors are in plain words, with the log behind **Details**. Where nothing can render, the panel says
why: running code is off (start the host with `--engine r`), or the environment's own message (for
Podman, what to install and start). In the desktop app a link followed inside the preview opens in
the browser instead of loading in the window, and ⇧⌘R is no longer Electron's Force Reload.

**The image changed** (rmarkdown, pandoc where the base lacks it, Typst, curl and xz), so it is
rebuilt once, a few minutes, the first time code runs or a document renders.

**Tests.** `packages/host/test/render.test.ts` with a renderer from outside the packages
(`fixtures/render-engine.mjs`) and the test environments: the live room's text is rendered, read-only
and offline; outputs outside the working tree and kept across restarts; failures, the time limit, a
link where the output should be, an unavailable environment, rendering off.
`render-podman.test.ts` (skipped without Podman): R Markdown to HTML with code, citations, MathML and
images inside; Word and PDF from R Markdown and Markdown; `--sandbox` for a plain document; an R
error in plain words with the log. `tests/e2e/render.spec.ts` (skipped without Podman): the panel,
no script running in the preview, ⇧⌘R after typing, saving Word, an error with Details.

**Not yet:** other output formats (slides, EPUB), rendering a whole book or website project,
parameters (`params`) asked for before rendering, outputs shared between devices, and keeping more
than the latest render of each format.
