# kuraa

A git-backed editor for collections of Pandoc markdown and R Markdown files, with live co-editing.

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

Everyone who has the URL and token can edit. Each person sets a display name, an email (for
co-author credit) and a cursor colour under **Settings** in the client.

The editor has no toolbar: type markdown (`**bold**`, `## `, ```` ```{r} ````, `[text](url)` and
so on) and it is formatted as you type; Backspace straight afterwards undoes the conversion. The
full list is in [decision 0008](docs/decisions/0008-markdown-cues.md). Source, Save version,
History, Sync and Settings are at the right of the status bar.

The repository is also served over git's HTTP protocol at `/git`, with the token as the password:

```sh
git clone http://kuraa:<token>@127.0.0.1:4321/git notes
```

## Run the web client in development

Start a host as above (without `--static`), then:

```sh
pnpm web:dev
```

Open <http://localhost:5173> and enter the host's URL and token in **Settings**.

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
| M1, M6, M7 | `packages/format-*/test`: identity, locality, oracle, fixed point, fuzz and totality on the 22-file corpus in [fixtures/corpus](fixtures/corpus/) |
| M2–M5, M9 | `packages/host/test`: headless clients against a real host and git repo |
| M2 | `tests/e2e/collab.spec.ts`: two browsers type into one paragraph, converge and show each other's cursors |
| — | `tests/e2e/cues.spec.ts`: typed markdown cues format the text, and the file keeps that markdown |
| M8 | `tests/e2e/desktop.spec.ts`: the Electron app opens a folder, edits and commits while other programs edit the folder and `git pull` into it; and it joins a shared host |

## Layout

| Package | Role |
| --- | --- |
| `packages/kernel` | Document type, command and hook registries. No DOM, no Node, no formats |
| `packages/format-pandoc` | Pandoc markdown: schema, position-preserving parser, block-preserving serializer |
| `packages/format-rmarkdown` | R Markdown, built only on format-pandoc's extension point |
| `packages/session` | The only package that touches Yjs, y-prosemirror and Hocuspocus |
| `packages/host` | Relay, bridge between rooms and files, committer, git peer, HTTP API, CLI |
| `packages/client` | The React client: file tree, editor with markdown cues, history, status, settings |
| `apps/web` | Web shell for the client (Vite) |
| `apps/desktop` | Electron shell, embedding the host |

## Known limits

- Two people typing at exactly the same caret position interleave their keystrokes. Text still
  converges; typing anywhere else in the same paragraph does not interleave.
- A merge from upstream that conflicts is aborted and reported, not resolved in the app.
- Edits made while disconnected are kept and sent on reconnect. If the host reseeded the file in
  the meantime (for example after its room cache was cleared), the client only warns.
- The corpus does not yet include real working files from the project's first users.
