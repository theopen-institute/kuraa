# 0011 · Running R chunks

R chunks in R Markdown documents can be run from the editor, as in RStudio's or Positron's
notebook mode. The host runs them; the client shows the output under each chunk.

**One R session per document, run by the host.** The host starts `Rscript` with a small driver
(`packages/host/src/r-driver.ts`, written to `.git/kuraa/run/` when needed) on the first run of a
document. R starts in the workspace root, so a project's `.Rprofile` (renv, for instance) applies;
each run happens in the document's folder, as knitr does. The driver reads one JSON request per
line on stdin and evaluates the code with `evaluate`, the package knitr uses, in the global
environment, so state carries over between runs. It replies with the outputs in order: text,
messages, warnings, errors, data frames (as tables, first 1,000 rows) and plots (PNG, with knitr's
merging of low-level plot calls). Chunk options are read with knitr's own parser; `eval`,
`fig.width`, `fig.height` and `fig.dim` apply. A chunk stops at its first error. Replies carry a
prefix, so stray output (from `system()`, say) cannot be mistaken for one; it is shown as a
message. The R process runs in its own process group, so Ctrl+C in the host's terminal does not
reach it; Interrupt sends it SIGINT, which stops the running code and keeps the session.
Requires the `evaluate` and `jsonlite` packages (`knitr` and `ragg` are used when present).

**Runs are shared.** Runs for a document are queued and run one at a time. Every change (queued,
running, finished) is broadcast to everyone with the document open, so collaborators see the
same session and outputs. Interrupt stops the current run and drops the queue; Restart starts a
fresh session. Idle sessions stop after an hour.

**Outputs are never written into the file.** The latest run of each chunk is cached in
`.git/kuraa/outputs/` and shown under the chunk. Chunks have no ids in the file, so a client
matches runs to chunks in passes: by label, then by code, then by position among unlabelled
chunks; a run claimed in an earlier pass is not offered to later ones. When a chunk's code has
changed since its output was produced, the output is marked "code changed since"; when a chunk
above it has, the output says which (see [0024](0024-out-of-date-outputs.md)).

**Off unless allowed.** Running code means anyone with the token can run programs as the host's
user. A host runs chunks only when started with `--allow-run` (or `run: true`). The desktop app
allows it for folders it opens itself (loopback, random token); `pnpm dev` allows it. Joining a
shared host runs nothing locally. `Rscript` is found on `PATH` or in the usual install locations,
since apps started from the macOS Dock get a short `PATH`; `--rscript` overrides it.

**In the client** (`packages/client/src/runs.ts`, `nodeviews.ts`): the format declares a code
block runnable (`run: { engineAttr }` on its node view hint); R Markdown's chunks do. Each chunk
gets Run in its header (and Rebuild above when the chunks above need it; see 0024), and ⇧⌘↩ runs it; ⌘↩ runs the current line (then moves to
the next) or the selection. In a runnable chunk ⌘↩ therefore no longer leaves the block; arrow
keys at the edges and a closing fence still do. The status bar shows the session and offers Run
all, Interrupt and Restart R.

**Not yet:** output while a chunk is still running (it appears when the chunk finishes), inline
`` `r expr` `` previews, HTML widgets (plotly, leaflet), chunk options written as `#|` comments,
engines other than R, and a variable browser.

*Since 0013:* the R runner is now the `engine-r` plugin, and where it runs is an environment
plugin. "Off unless allowed" became `--engine r --env <environment>`; the desktop app runs chunks
in a Podman container by default, and on this computer only if chosen in its Run Code menu.
Session messages are `run-session` (with the engine and environment), not `r-session`.
