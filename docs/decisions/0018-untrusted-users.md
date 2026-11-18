# 0018 · People using the app are not trusted; code runs only in Podman

**Who is trusted with what.** Whoever runs a host is its administrator, and configures it only
with flags (`--engine`, `--format`, `--plugin`, `--allow-write`, `--allow-network`,
`--allow-installs`, `--podman`, …; the desktop app takes `--engine`, `--format` and `--plugin`).
People using the app, including the person running the desktop app, are trusted with the content
of documents and nothing more: nothing they write, run or open may execute on the host's computer
or in the app, and nothing in the app changes how the host is configured. Proper accounts and roles
may come later; until then, anything an administrator decides is a flag. This replaces the
in-app switches of [0017](0017-plugins-panel.md), which now only shows what is on.

**Code runs only in Podman.**

- The Local environment (`@kuraa/env-local`, R on the computer itself) is gone, with
  `--env`, `--rscript` and engine-r's search for R on the computer.
- Environments are no longer plugins. The runner has one, the Podman sandbox
  (`@kuraa/env-podman`), given to it by the host. `RunPlugin` has no `environments`, and a plugin
  that brings any is refused when the host starts. Engines remain plugins; everything an engine
  starts, it starts through the sandbox.
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

**Interrupts.** Signals sent to `podman run` reached the container twice (one SIGINT stopped two
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
