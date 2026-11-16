# 0009 · The shell boundary, and `pnpm dev`

The system has three layers, and only the outermost knows which platform it is on:

| Layer | Owns | Platform-specific |
| --- | --- | --- |
| Client (`packages/client`) | The page. Talks to one host over HTTP and a WebSocket | No |
| Host (`packages/host`) | The working tree and git. The only process that writes files or runs git | No |
| Shell (`apps/web`, `apps/desktop`, `scripts/dev.ts`) | Starting things, and telling the client which host to use | Yes |

**The host does all file and git work, shells included.** `@kuraa/host` exports `inspectFolder`,
`gitIdentity` and `initWorkspace`, and `startHost({ init: true })` (`--init` on the command line)
makes a plain folder a repository instead of failing. The desktop app uses these and runs no git
itself; it asks the user, then starts the host.

**The client's view of its shell is the `Shell` interface** (`packages/client/src/shell.ts`):
whether the shell manages the host (then Settings hides host URL and token), and optional native
actions (open another folder, leave for the start screen), shown in Settings only when present.
A native shell exposes a `ShellBridge` as `window.kuraa`; the desktop app's preload implements it,
and the client reads the connection from it at start-up. Because the connection is not in the
URL, reloading the desktop window keeps it.

**`apps/web/src/shell.ts` is the one place that tells shells apart:** the desktop bridge if
present; else the dev server's environment; else URL parameters (`?token=`, `?host=`), which are
remembered for the tab so a reload keeps them.

**`pnpm dev`** runs the host under `tsx watch` and the client under Vite, with Vite proxying
`/api`, `/git` and `/collab` to the host, so page and host share an origin and the token reaches
the page through Vite's environment. A host restart is seamless for open editors: the host writes
and commits pending edits as it stops, and keeps room state in `.git/kuraa`, so the restarted host
resumes the same rooms and editors reconnect, keeping anything typed meanwhile.

**Stopping on Ctrl+C.** Ctrl+C goes to every process in the terminal's group. So that it cannot
kill a git command half-way through a commit, the host runs git in its own process group, and
treats repeated stop signals arriving together as one (a second Ctrl+C a second later still forces
an exit). The dev script does not forward Ctrl+C, since its children already have it.

**Not done:** a page that runs with no host (browser file access plus a JavaScript git) would
be a different system with weaker guarantees about the files. A website covering many folders
would be a host serving every repository under a root folder; nothing here prevents that.
