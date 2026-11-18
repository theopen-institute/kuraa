# 0018 · People using the app are not trusted; code runs only in Podman

> Changed by [0019](0019-engine-and-environment-components.md): environments are plugins again, like
> engines; Podman is one, and none that runs code on the computer itself ships. An unsandboxed
> environment is used only with `--allow-unsandboxed`.

**Who is trusted with what.** Whoever runs a host is its administrator, and configures it only
with flags (`--engine`, `--env`, `--format`, `--plugin`, `--allow-write`, `--allow-network`,
`--allow-installs`, `--allow-unsandboxed`, `--podman`, …; the desktop app takes the run and format flags too).
People using the app, including the person running the desktop app, are trusted with the content
of documents and nothing more: nothing they write, run or open may execute on the host's computer
or in the app, and nothing in the app changes how the host is configured. Proper accounts and roles
may come later; until then, anything an administrator decides is a flag. This replaces the
in-app switches of [0017](0017-components-panel.md), which now only shows what is on.

**Code runs only in Podman.**

- The Local environment (`@kuraa/env-local`, R on the computer itself) is gone, with
  `--rscript` and engine-r's search for R on the computer.
- Environments were briefly not plugins (only Podman, built in); [0019](0019-engine-and-environment-components.md)
  made them plugins again, with sandboxing declared by each and gated by `--allow-unsandboxed`.
- A workspace can no longer choose an environment (`"environment"` in `.kuraa/run.json` is
  ignored). It can still ask for an image, packages and system libraries (names are checked and
  may not start with `-`), and for write access or the network, which it gets only where the
  host's flags allow.
- Package installers run in containers too, with the network but without the workspace. Image
  builds run in Podman's build containers.
- Tests that ran R on the computer now run it in Podman, and are skipped where Podman is not
  available.

Plugin code itself (engines loaded with `--plugin`) runs in the host process: it is installed by
the administrator, like the host, and is trusted as the host is.

**Interrupts (Podman).** Signals sent to `podman run` reached the container twice (one SIGINT stopped two
runs, or R itself), so Podman now runs with `--sig-proxy=false` and interrupts go through
`podman kill --signal=SIGINT`, which delivers exactly one.

**Nothing in a document runs in the app.**

- Links are rendered with their address only if it is a web (`http`, `https`) or mail address or
  relative to the document; images only from the web, relative paths or raster `data:` URLs
  (`safeUrl` in format-pandoc). `javascript:`, `file:` and the like, including disguised with
  control characters, are drawn without an address.
- Chunk outputs are built as DOM text, never HTML; plot images are shown only as PNG, JPEG, GIF
  or WebP.
- The web client has a Content-Security-Policy: only its own scripts run; no inline script, no
  plugins, frames or workers; connections to any host, as the app needs.
- The desktop window shows only the app's own pages. It refuses navigation elsewhere and new
  windows (web and mail links open in the browser), redirects and web views; the bridge
  (`window.kuraa`) answers only the app's own pages. The renderer stays sandboxed, with context
  isolation and no Node.
