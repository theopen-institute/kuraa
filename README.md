# kuraa

A git-backed editor for collections of Pandoc markdown and R Markdown files, and the source files
around them (R, Python, YAML, BibTeX, LaTeX and more), with live co-editing.

The files in git are the source of truth. A host process holds the working tree, relays live edits
between clients (Yjs over Hocuspocus), writes them back to the files, commits them with everyone
who edited as a co-author, and merges changes made outside the app into the live session. A
workspace stays an ordinary git repository that works with git, RStudio or any text editor.

This is the phase 0–1 prototype from the design doc. Deviations from that spec are recorded in
[docs/decisions/](docs/decisions/).

## Requirements

- Node 24 or later, and pnpm (`corepack enable pnpm`)
- git
- pandoc, optional: the format oracle tests skip with a warning without it

```sh
pnpm install
```

If `pnpm desktop` reports that Electron failed to install, fetch its binary once with
`node apps/desktop/node_modules/electron/install.js`.

## Run a shared host on a folder

The folder must be a git working tree. Build the web client once, then start the host:

```sh
pnpm web:build
pnpm host --dir ~/research/notes --static apps/web/dist
```

The host prints its URL, the access token, a link that opens the client with the token filled
in, and a `git clone` command. Useful options:

| Option | Default | Notes |
| --- | --- | --- |
| `--port` | `4321` | — |
| `--host` | `127.0.0.1` | Use `0.0.0.0` to let collaborators on your network connect |
| `--token` | random | Or set `KURAA_TOKEN` |
| `--upstream` | `origin` if it exists | The remote that **Sync** fetches from, merges and pushes to |
| `--flush-ms`, `--commit-ms` | 2000, 30000 | Write to disk after this long idle; commit after this long idle |
| `--engine`, `--env` | off | Turn on running code: `--engine r --env podman`. See below |
| `--plugin` | none | Load a run plugin (engine or environment) by path or package name |
| `--allow-write`, `--allow-network` | off | Let a workspace ask for write access to itself, or for the network |

Everyone who has the URL and token can edit. Each person sets a display name, an email (for
co-author credit) and a cursor colour under **Settings** in the client.

The editor has no toolbar: type markdown (`**bold**`, `## `, ```` ```{r} ````, `[text](url)` and
so on) and it is formatted as you type; Backspace straight afterwards undoes the conversion. The
full list is in [decision 0008](docs/decisions/0008-markdown-cues.md). Source, Save version,
History, Sync and Settings are at the right of the status bar.

## Running R chunks

Where the host runs code, each R chunk has **Run** and **Run above** in its header. ⇧⌘↩ runs the chunk; ⌘↩ runs
the current line or the selection. Output appears under the chunk for everyone with the document
open: text, messages, warnings, errors, data frames as tables, and plots at the chunk's
`fig.width` and `fig.height`. Each document has its own R session, so objects carry over between
runs; **Interrupt**, **Restart** and **Run all** are in the status bar, which also says where code
runs. Outputs are kept in `.git/kuraa/`, never in the `.Rmd`.

Code runs through plugins: an **engine** (R) in an **environment**, which is where it runs and
what it may touch ([decision 0013](docs/decisions/0013-run-plugins-and-sandboxing.md)):

- **Podman** (`--env podman`, the desktop app's default): a container with no network, the
  workspace read-only and `.git` hidden, and nothing else of your computer visible. Install it
  once: `brew install podman`, `podman machine init`, `podman machine start`. The first run builds
  an R image, which takes a few minutes.
- **Local** (`--env local`, and `pnpm dev`): R on your computer, as you. Not sandboxed.

The desktop app's **Run Code** menu switches between the two, or turns running off. A workspace
can say what it needs in `.kuraa/run.json`, but cannot loosen what you allow:

```json
{
  "environment": "podman",
  "r": { "packages": ["dplyr", "ggplot2"], "system": ["libxml2-dev"], "renv": true },
  "access": { "workspace": "read-write" }
}
```

Write access and the network are granted only if the host was started with `--allow-write` or
`--allow-network`. A run plugin is a module exporting `definePlugin({ name, engines,
environments })` from `@kuraa/run-kit`; [an example](packages/host/test/fixtures/echo-plugin.mjs).

The repository is also served over git's HTTP protocol at `/git`, with the token as the password:

```sh
git clone http://kuraa:<token>@127.0.0.1:4321/git notes
```

If the folder is not a git repository yet, add `--init` to make it one, committing what is
already there.

## Develop

```sh
pnpm dev                          # uses .dev-workspace/ (created the first time, git-ignored)
pnpm dev --dir ~/research/notes
pnpm dev --env podman             # run R chunks in a Podman container (default: on this computer)
```

`--allow-write` and `--allow-network` let the workspace ask for those in `.kuraa/run.json`.

Open <http://127.0.0.1:5173>. There is nothing to configure: the dev server puts the host behind
its own address and gives the page the token. Client changes apply in place without a reload;
changes to the host, session, kernel or format packages restart the host, and open editors
reconnect without losing anything typed. Ctrl+C writes and commits pending edits before exiting.

To point the dev client at some other host instead, run `pnpm web:dev` and enter that host's
URL and token in **Settings**.

## Run the desktop app

```sh
pnpm desktop                          # launcher: open a folder, or join a shared host
pnpm desktop -- --open ~/research/notes
pnpm desktop -- --join http://192.168.1.20:4321 --token <token>
```

Opening a folder starts a host inside the app, on the loopback address with a random token, and
commits under the folder's git identity. If the folder is not a git repository, the app asks
before initialising one. The folder stays usable by other programs while it is open; their
changes appear in the editor. Quitting writes and commits any pending edits.

Joining a shared host starts no local host.

## Checks

```sh
pnpm check       # lint (including the package dependency rules), typecheck, unit and host tests
pnpm test:e2e    # browser and desktop tests; run `npx playwright install chromium` once first
```

| Milestone | Test |
| --- | --- |
| M0 | `pnpm check` |
| M1, M6, M7 | `packages/format-*/test`: identity, locality, oracle, fixed point, fuzz and totality on the 22-file corpus in [fixtures/corpus](fixtures/corpus/); exact round trips and matching for source files in [fixtures/text](fixtures/text/) |
| M2–M5, M9 | `packages/host/test`: headless clients against a real host and git repo |
| M2 | `tests/e2e/collab.spec.ts`: two browsers type into one paragraph, converge and show each other's cursors |
| — | `tests/e2e/cues.spec.ts`: typed markdown cues format the text, and the file keeps that markdown |
| — | `tests/e2e/text.spec.ts`: source files are highlighted; Enter, Tab and paste keep indentation and line endings |
| — | `packages/host/test/runner.test.ts`, `tests/e2e/run.spec.ts`: R chunks run on the host, outputs reach every client, interrupt and restart work, files stay untouched (skipped without R) |
| M8 | `tests/e2e/desktop.spec.ts`: the Electron app opens a folder, edits and commits while other programs edit the folder and `git pull` into it; survives a reload; joins a shared host; the launcher initialises a plain folder and joins a host |
| — | `tests/e2e/dev.spec.ts`: `pnpm dev` serves a working client with nothing to configure, and Ctrl+C commits pending edits |

## Layout

| Package | Role |
| --- | --- |
| `packages/kernel` | Document type, command and hook registries. No DOM, no Node, no formats |
| `packages/run-kit` | The contract for run plugins: engines, environments, the sandbox policy |
| `packages/engine-r` | The R engine: runs `r` chunks through `evaluate` |
| `packages/env-podman`, `packages/env-local` | Environments: a locked-down container; a plain process |
| `packages/editor-kit` | The contract for a format's editor module (types only) |
| `packages/format-pandoc` | Pandoc markdown: schema, position-preserving parser, block-preserving serializer; `/editor`: cues, keys, footnotes |
| `packages/format-rmarkdown` | R Markdown, built only on format-pandoc's extension points; `/editor`: chunk fences |
| `packages/format-text` | The Text file type for scripts, data and settings files, one node per line, highlighted by file name |
| `packages/formats` | `standardTypes`, which the host and the web client both load; `/editor`: their editor modules |
| `packages/session` | The only package that touches Yjs, y-prosemirror and Hocuspocus |
| `packages/host` | Relay, bridge between rooms and files, committer, git peer, HTTP API, CLI, run plugin registry |
| `packages/client` | The React client: file tree, editor with markdown cues, history, status, settings |
| `apps/web` | Web shell for the client (Vite) |
| `apps/desktop` | Electron shell, embedding the host |
| `scripts/dev.ts` | `pnpm dev`: host under `tsx watch`, client under Vite, one origin |

## Known limits

- Two people typing at exactly the same caret position interleave their keystrokes. Text still
  converges; typing anywhere else in the same paragraph does not interleave.
- A merge from upstream that conflicts is aborted and reported, not resolved in the app.
- Edits made while disconnected are kept and sent on reconnect. If the host reseeded the file in
  the meantime (for example after its room cache was cleared), the client only warns.
- The corpus does not yet include real working files from the project's first users.
