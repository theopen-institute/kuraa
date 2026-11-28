# 0107 · Rendering Markdown without Podman

*Since [0113](0113-typst-sealed-in-webassembly.md):* PDFs are made by Typst's WebAssembly build (typst.ts), sealed in a context with nothing of Node's and given only copies, not by Typst's own program; the app and the server download carry it, the same for every platform.

**Status: built.** Markdown documents, and every book Compile makes, render to HTML, Word, PDF and
EPUB with no Podman: pandoc's WebAssembly build makes them, inside the host, and Typst makes the
PDFs. R Markdown, whose chunks are code, still renders where code runs. So does a PDF whose header
asks for LaTeX, where that is possible. **Render Markdown where code runs**, in Settings › Host,
sends Markdown there too.

The owner asked whether pandoc needed Podman (it did: every render ran in the R image), then whether
it could be bundled without Podman, then: "as much as possible, let's get pandoc and typst out of
podman, if it can be done securely. Podman should be for things that are much more difficult to
bound, like R code." Offered the WebAssembly build over a native pandoc, they agreed ("wasm is
good"), and asked for a way back for those who want more: "for really technical users or users with
more complex demands, there can be a pathway for rendering in podman or the binary, as an optional
alternative."

This revises [0041](0041-rendering.md) (renders run only where code runs) and keeps
[0018](0018-untrusted-users.md): nothing in a document runs on the computer, and a document's
pandoc and Typst read nothing but what the host copies for them.

## What is decided

**A new kind of run component, a renderer** (`renderers` in `@kuraa/run-kit`'s `RunComponent`): it
renders documents of some file types to some formats with no environment. It says which formats it
cannot make here (`unavailable(format)`: a program missing). It may say a render is better made
where code runs (`prefersEngine(req)`). It is given what it reads (`RendererContext.read`). It is on
wherever it is loaded, code running or not. `RUN_API_VERSION` stays 1: the contract only grew.

**How a render is made** (the host's `renders.ts`, `route`):

1. A renderer renders a document of its kind, to a format it can make here.
2. An engine renders it instead, where code runs, when the renderer can't make that format here (no
   Typst for a PDF), or would rather not (a PDF whose header asks for LaTeX), or the host's Settings
   say so. In each case an engine must render that kind and format, and its environment must be
   there.
3. If no engine can, the renderer still does, saying what it left out ("made with Typst: settings
   only LaTeX understands were left out").
4. Otherwise, why not.

**`@kuraa/render-pandoc`** (one of the standard run components) renders `.md` and `.markdown`:

1. The document is copied into the render's scratch folder. pandoc reads it into its syntax tree.
2. Every file the tree refers to is asked of the host: an image (in raw HTML too), and the
   bibliography, CSL, CSS, Word template or cover the header names. The host gives a file only if
   it is inside the workspace, outside `.git`, reached through no link, a plain file of 256 MB at
   most, and not in a space hidden from the document's readers (0066). That is what a render in
   Podman sees. Each file given is copied in, and the tree points at the copy. An image that can't
   be had, a web address among them, becomes its description, and the message counts them. The
   header's file keys come out of the metadata: flags name the copies instead.
3. pandoc writes the format from the tree. It runs in a worker thread under WASI, seeing only the
   copies' folder and the output's. It has no network, no programs to start, and no environment
   variables.
4. For a PDF, Typst runs on what pandoc wrote. Its root is the scratch folder, so it reads nothing
   outside. It has no packages, and the only proxy it is given answers nothing, so it can fetch
   none. A document's own Typst (`{=typst}`, a page break) works within those bounds: it can't read
   outside the render or download.

The header is read as the R engine reads it: R Markdown's `output:`, Quarto's `format:`, and their
keys at the top level (`toc`, `number-sections`, `reference-doc`, `cover-image`: 0106). So a
document comes out the same either way. HTML is self-contained, with math as MathML. Citations go
through `--citeproc`. The time limit and stopping are the host's, as for renders in Podman.

**The programs.**

- **pandoc 3.14:** its WebAssembly build, 62 MB, the same file on every platform. It is compiled
  once per host and run in a worker, so a book never holds up the host. A 108,000-word novel takes
  about 2–4 seconds per format.
- **Typst 0.15.1:** its own program for each platform (14–22 MB). It makes the same novel's PDF in
  half a second.
- **Fetching them:** `scripts/fetch-render-tools.mjs` downloads both and checks them against their
  pinned SHA-256. It keeps them once per computer, in the user's cache folder (`kuraa/render-tools`,
  or `KURAA_RENDER_TOOLS`), so every checkout shares them. `pnpm install` runs it; offline, it says
  so and goes on.
- **The desktop app** carries both, with their licences, in its resources (`render/`). It names
  them to the host (`KURAA_PANDOC_WASM`, `KURAA_TYPST`).
- **The server archive** carries pandoc.wasm, beside the bundle in `render/`. A host started from it
  uses the computer's Typst, if one is on `PATH`, or makes PDFs where code runs. One for six
  platforms would add about 100 MB.
- **Licences:** pandoc is GPL-2.0-or-later and Typst Apache-2.0. Both are separate programs Kuraa
  runs, shipped with their licences. pandoc's source is at its tag.

**Where code runs, by choice.** **Render Markdown where code runs** (Settings › Host, under running
code; `--render-where-code-runs`; off by default) sends Markdown to the R engine's pandoc in Podman.
That is slower to start, but it is R Markdown's own pandoc, with LaTeX for every PDF a header asks
it for. A format the engine can't make is still made by the built-in pandoc.

### Not yet

- A native pandoc instead of the WebAssembly build, for speed or a version of one's own. It would be
  another renderer, run with `--sandbox`, the host still copying in what it reads.
- LaTeX without Podman. It is safe only with its file and shell access shut, which is well known but
  is its own work.
- Renderers in Settings' **Components**, with a switch of their own.
- `.qmd` rendered at all. It still opens as text.
