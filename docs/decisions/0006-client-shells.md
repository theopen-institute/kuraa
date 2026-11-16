# 0006 · How the shells load the client

**Document types come from the shell.** `mountApp` takes the list of document types; `apps/web`
passes Pandoc markdown and R Markdown, the same implementations the host registers. The client
package names no format. When a file's type version on the host differs from the client's, the
editor does not open and a banner says which side to update, since the version is part of the
room key.

**One build, loaded three ways.** The web client is built with relative asset paths, so the same
`apps/web/dist` is served by a host (`--static`), by the Vite dev server, or loaded by Electron
from `file://`. The desktop app loads it from disk in both modes, with the host URL and token
as URL parameters, which the client removes from the address bar. Host and token from the shell
override stored settings; name and email (from git config) only fill empty fields.

**Desktop bundling.** The Electron main process, with the embedded host, is bundled to CommonJS
by esbuild. Some dependencies call `createRequire(import.meta.url)`, so the bundle defines
`import.meta.url` from `__filename`.

**`ELECTRON_RUN_AS_NODE`.** Some editors' terminals set it, which makes Electron run as plain
Node. `pnpm desktop` and the desktop test clear it before launching.
