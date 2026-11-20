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
in, and a `git clone` command. People see the folder as the one workspace in the app's workspace
menu, and cannot add others; `--workspaces` instead serves a folder of workspaces people may add to
(see below). Either way it is the same kind of server, a hub
([decision 0030](docs/decisions/0030-one-kind-of-server.md)). Useful options:

| Option | Default | Notes |
| --- | --- | --- |
| `--port` | `4321` | — |
| `--host` | `127.0.0.1` | Use `0.0.0.0` to let collaborators on your network connect |
| `--token` | random | Or set `KURAA_TOKEN` |
| `--workspaces` | off | Be a hub of many workspaces, added from the app, kept in this folder. See below |
| `--peer` | off | Sync with this workspace's other devices, directly. See below |
| `--allow-invites` | off | Let people make invitations and links from the app (`--workspaces` always does) |
| `--manage-backups` | off | Let people using the app add and remove backups (desktop app and `pnpm dev`: on). See below |
| `--manage-person` | off | Let people using the app see, make and import this computer's person's key (your own computer only; `pnpm dev`: on) |
| `--bootstrap` | Hyperswarm's | DHT nodes for finding devices (`host:port`), for a private network |
| `--flush-ms`, `--commit-ms` | 2000, 30000 | Write to disk after this long idle; commit after this long idle |
| `--engine` | off | Turn on running code: `--engine r`. See below |
| `--env` | the only one loaded | Where code runs, by environment: `--env podman` |
| `--allow-unsandboxed` | off | Allow an environment that is not sandboxed (none ships) |
| `--memory` | `4g` | The most memory a code session's container may use |
| `--cpus` | `2` | How many CPUs a code session's container may use (fractions allowed: `0.5`) |
| `--disk` | `2g` | The most a code session may write (its scratch folder and `/tmp`); past it, the session is stopped |
| `--podman` | found on the `PATH` or where the installers put it | The Podman program to run containers with; or set `KURAA_PODMAN` |
| `--r-image` | the default | Further base images a workspace may name for R in `.kuraa/run.json` (repeatable) |
| `--format` | all | The document formats that are on: `--format pandoc-markdown --format text` |
| `--component` | none | Load a run component (engine or environment) by path or package name |
| `--allow-write`, `--allow-network` | off | Let a workspace ask for write access to itself, or for the network |
| `--allow-installs` | off | Let people install packages (desktop and `pnpm dev`: on) |
| `--data-dir` | your app data folder | Where package versions are stored, shared by workspaces |

Everyone who has the URL and token can edit. Each person sets a display name, an email (for
co-author credit) and a cursor colour under **Settings** in the client.

The editor has no toolbar: type markdown (`**bold**`, `## `, ```` ```{r} ````, `[text](url)` and
so on) and it is formatted as you type; Backspace straight afterwards undoes the conversion. The
full list is in [decision 0008](docs/decisions/0008-markdown-cues.md).

The sidebar shows the workspace folder, with a button for a new file (＋); right-click the space
below the files for a new folder, and each folder has buttons for both on hover. Documents (Markdown and R Markdown) are listed by their **title**;
text and source files by filename, each with a small icon its type defines (a page, code, data,
settings, a bibliography, …: [decision 0023](docs/decisions/0023-file-icons.md)). A new document is asked for its title, and its filename is made
from it (`Tidal notes: Café` → `tidal-notes-cafe.md`); **Rename…** changes a document's title and
its filename, together or apart ([decision 0022](docs/decisions/0022-titles-and-filenames.md)). Drag a file or folder onto a folder to move it there, or onto the
workspace name to move it to the top level; each move is committed. Right-click a file for
**Open**, **Header…**, **Rename…** and **Delete…**, or a folder for a new file or folder in it and **Rename…** (everything in it goes with it).

A Markdown or R Markdown document's **header** (the YAML block at the top: title, authors, date,
bibliography, PDF and HTML settings, …) is not shown in the page. **Header…** opens it as fields
to fill in, with Pandoc's standard fields (and R Markdown's `output` and `params`) offered by name,
or as YAML; the Source view shows it as text ([decision 0021](docs/decisions/0021-document-header.md)).

Everything else is in the **menu**, from the bottom of the sidebar or
⌘, (Ctrl+,): the document's **Source** (the markdown, which you can edit there too, alongside
others editing the rich view: [decision 0015](docs/decisions/0015-editable-source.md)), **History**,
**Header…**, **Save version**, **Preview** (below), when it was last written and committed; the code session; the workspace's branch,
**Search…** (⇧⌘F: every text file, and open documents as they are being typed; a result opens the
file at the match, [0042](docs/decisions/0042-search.md)), **Sync** and who is here; **Components…**; and your settings. The bottom of the sidebar shows whether you are
connected and how many others are here. Passing news (an outside edit merged, a conflict) appears
as a note in the corner.

A past version opened from **History** (shown by its date and who made it) can be compared with the
document now (**Compare with now**: changed paragraphs, the words in them marked) or restored
(**Restore this version…**: an edit like any other, which everyone sees and ⌘Z undoes;
[0043](docs/decisions/0043-past-versions.md)).

## Rendering: HTML, Word and PDF

**Preview** in the menu, or ⇧⌘R, renders the document as it is now (R Markdown knitted by
rmarkdown, Markdown by pandoc) and shows the page beside it, in a frame where nothing in the document
runs; **Update when saved** renders it again each time it is saved. **Save as** HTML, Word or PDF
renders that format and saves the file. The header's `output:` (or `format:`) settings apply. PDFs are
made with Typst, which the environment has, so no TeX is needed; a header asking for a LaTeX engine
gets it if the environment has one. Rendering runs where code runs (in Podman, with the workspace
read-only and no network), so it needs `--engine r` and Podman, like running chunks; the panel says
what is missing. Outputs are kept in `.git/kuraa/renders/`, never beside the document
([decision 0041](docs/decisions/0041-rendering.md)).

## Backups

A workspace can be backed up to plain git servers: GitHub, GitLab, any git host, or a folder. In the
menu's **Backups** section (the desktop app, `pnpm dev`, or a host started with `--manage-backups`),
add the address of an empty repository, such as `git@github.com:you/notes.git`; from the command
line, `pnpm host backup add <address> --dir <workspace>`. Every branch is pushed to it after each
save, with your own git credentials (an SSH key, or a credential helper for https). Nothing comes
back from a backup, and it is never force-pushed: if another of your devices pushed first, the
backup waits until this one has that work. For a remote that work also comes back from, use a
sync remote (**Sync**) instead ([decision 0036](docs/decisions/0036-backups.md)).

## Many workspaces: a hub

A hub serves many workspaces at one address and token, and lets people add them from the app
([decision 0029](docs/decisions/0029-hub.md)):

```sh
pnpm host --workspaces ~/research --static apps/web/dist
```

In the app, the workspace's name at the top of the sidebar switches between them and adds new
ones: a new folder (made a git repository, inside `~/research`), or a workspace someone shared,
joined with their invitation or subscription link. **Invite people…** (there, and in the menu)
makes a link or invitation for the open workspace, to send to whoever should join it. The desktop app works this way by itself:
new workspaces go in `Documents/kuraa` (or `--workspaces <folder>`), and **Open a folder…** adds
any folder on the computer.

## On several devices

A workspace can be on several devices at once, each running its own host with `--peer`, with no
server in between ([decision 0028](docs/decisions/0028-peers.md)). When people on two devices
have the same document open, they edit it together live; what is done apart reaches the other
devices through git as soon as they meet. Merges read documents and never stop: a passage both
sides changed differently stays in the document with both versions, to choose between there
([0025](docs/decisions/0025-merging.md)).

```sh
# On the first device (its host running with --peer):
pnpm host invite --dir ~/research/notes          # a one-time invitation, for one device
pnpm host link --dir ~/research/notes            # or a subscription link, for anyone, for a week
# On another device:
pnpm host join kuraa-invite:… --dir ~/notes      # or kuraa-link:…; fetches the workspace
pnpm host --dir ~/notes --peer --static apps/web/dist
```

A subscription link lets anyone who has it join as a full device, as often as they like, until it
expires (`--hours`, or `--forever`) or is revoked (`pnpm host revoke-link <id>`; `pnpm host links`
lists them). Any device of the workspace that is running can let them in; the joining device
checks, by the workspace's signed pairing records, that the link's maker vouches for it. Share it
only with people who may join: it carries the workspace's secret.

Paired devices are git remotes (`kuraa://<device key>`): `git log laptop/main` shows what a device
has. `pnpm host devices` lists them; `remove-device`, `name` and `fork` manage them.

Each device decides whose work it accepts ([decision 0032](docs/decisions/0032-accepting-work.md)).
By default, every member's work comes in on its own. `pnpm host accept main self` makes this
device an integrator on `main`: other devices' work there waits as a proposal, accepted in the
menu's **Devices** section; `pnpm host accept main desk` takes `main` only from the device `desk`,
and `everyone` goes back. `pnpm host accept --membership <device|self>…` likewise chooses whose
changes to the members (pairings, removals, revoked links) this device takes. A device joining by
an invitation or link starts with its inviter's rules.

Rules can also name a folder or file: `pnpm host accept main --path chapters/ ada` takes changes
to `chapters/` only from Ada. Others' history still comes in, but this device keeps its own version
there, and lists theirs under **Devices**, with **Take theirs**. Devices publish their rules, so
the editor on another device opens such a document read-only, saying who would not take its edits,
with **Edit anyway** ([decision 0033](docs/decisions/0033-document-rules-and-people.md)). Rules may
name people as well as devices ([decision 0035](docs/decisions/0035-identities-and-signing-keys.md)).
Each person has a signing key on each computer (made there, never copied), which signs the commits
they make there, and an identity that vouches for those keys, so their work counts as theirs
whichever computer it was made on and whichever device it comes through; a lost computer's key can
be revoked. Every host is one person: whoever runs it. The menu's **Identity and access** panel
shows this computer's key and makes, imports, copies or revokes with your identity: in the desktop
app, and in a browser where the host allows it (`--manage-person`, which `pnpm dev` passes); from
the command line, `pnpm host person create "Ada Lovelace"`, `person export`, `person import` and
`person revoke <key>`. Changes to the members are signed by the
device that made them, and commits with the signing key of whoever made them, so `git log
--show-signature` names them ([decision 0031](docs/decisions/0031-signed-membership.md)); `pnpm host signing-key`
prints the key, to add to GitHub as a signing key. `pnpm host sync-remote <remote>` chooses the
sync remote, the ordinary git remote **Sync** fetches from, merges and pushes to (default:
`origin`).

In the desktop app, turn on **Sync every workspace with its
paired devices** in Preferences (or pass `--peer`).

Devices running different versions of kuraa can work together. Each tells the others how it merges
(a version, and the document types that merge on their own); where two differ, only the one with
the lower key makes the merges between them and the other takes them, so their histories never part.
**Devices** in the menu marks such a device *other version*. Merges read files with every format the
host has, whether or not `--format` turns it on, so formats turned off do not change them.

## Running R chunks

Where the host runs code, each R chunk has **Run** in its header. ⇧⌘↩ runs the chunk; ⌘↩ runs
the current line or the selection. An output computed before a chunk above it changed is dimmed
and says so ("chunk 2 changed since"); when the session does not have the chunks above as they now
read, the chunk also offers **Rebuild above**, which runs them again from the first that changed. Output appears under the chunk for everyone with the document
open: text, messages, warnings, errors, data frames as tables, and plots at the chunk's
`fig.width` and `fig.height`. Each document has its own R session, so objects carry over between
runs; **Interrupt**, **Restart** and **Run all** are in the menu, which also says where code runs. Outputs are kept in `.git/kuraa/`, never in the `.Rmd`.

Code runs through two kinds of component, which meet only through the contract in `@kuraa/run-kit`
([decision 0019](docs/decisions/0019-engine-and-environment-components.md)): **engines** are
languages (R), and **environments** are where their processes run. The host itself knows neither;
the ones that ship are R and **Podman**: a container with no network, the workspace read-only and
`.git` hidden, nothing else of the computer visible. Install Podman once: `brew install podman`,
`podman machine init`, `podman machine start`. The first run builds an R image, which takes a few
minutes. Package installs run in containers too. A workspace may name another base image only if the host allows it (`--r-image`); containers a host left behind (it crashed) are removed by the next host to start one on that computer.

**People using the app are not trusted with the computer the host runs on**; only the content of
their documents is theirs ([decision 0018](docs/decisions/0018-untrusted-users.md)). No environment
that runs code on the computer itself ships. One can be written, but a host uses an environment
that is not sandboxed only when started with `--allow-unsandboxed`.

Everything that configures a host is a flag (`--engine`, `--env`, `--format`, `--component`, the
`--allow-…` flags); the desktop app takes `--engine` (`--engine none` for none), `--env`,
`--format`, `--component` and `--allow-unsandboxed` too. **Components…** in the menu shows what is on, read-only, and lets each person turn their own
editing behaviour on and off (markdown cues and footnote ordering, chunk fences), kept in their
browser. A file whose format is off opens as a Text file
([decision 0017](docs/decisions/0017-components-panel.md)). A workspace can say what it needs in
`.kuraa/run.json`, but cannot loosen what the host allows:

```json
{
  "r": { "packages": ["dplyr", "ggplot2"], "system": ["libxml2-dev"], "renv": true },
  "access": { "workspace": "read-write" }
}
```

Write access and the network are granted only if the host was started with `--allow-write` or
`--allow-network`.

**Packages.** The environment starts with the tidyverse. Install more with `install.packages()` in
a chunk, or **Packages…** in the menu (CRAN names, `name@version`, `bioc::name`, or
`owner/repo` from GitHub). Installs run apart from your data, with the network; your code keeps
running without it. Each workspace records its packages in `.kuraa/r-packages.json` (committed),
so collaborators and other machines get the same ones; each package version is stored once per
computer. A shared host allows installs only with `--allow-installs`
([decision 0014](docs/decisions/0014-packages.md)). A run component is a module exporting `defineRunComponent({ name, engines,
environments })` from `@kuraa/run-kit`: examples of [an engine](packages/host/test/fixtures/echo-engine.mjs)
and [environments](packages/host/test/fixtures/environments.mjs), loaded with `--component <path>`.

The repository is also served over git's HTTP protocol at `/w/<workspace>/git`, with the token as
the password (the host prints the command):

```sh
git clone http://kuraa:<token>@127.0.0.1:4321/w/notes/git notes
```

If the folder is not a git repository yet, add `--init` to make it one, committing what is
already there.

## Develop

```sh
pnpm dev                          # a folder of workspaces: .dev-workspaces/ (git-ignored)
pnpm dev --workspaces ~/research  # another folder of workspaces
pnpm dev --dir ~/research/notes   # one folder, as `pnpm host --dir` serves it
```

Like the desktop app, `pnpm dev` serves a folder of workspaces you can add to from the app. The
first time, it starts with a Scratch workspace.

R chunks run in Podman, as everywhere. `--allow-write` and `--allow-network` let the workspace ask
for those in `.kuraa/run.json`.

Open <http://127.0.0.1:5173>. There is nothing to configure: the dev server puts the host behind
its own address and gives the page the token. Client changes apply in place without a reload;
changes to the host, session, kernel or format packages restart the host, and open editors
reconnect without losing anything typed. Ctrl+C writes and commits pending edits before exiting.

To point the dev client at some other host instead, run `pnpm web:dev` and enter that host's
URL and token in **Settings**.

## Run the desktop app

```sh
pnpm desktop                          # your workspaces (new ones in Documents/kuraa)
pnpm desktop -- --workspaces ~/research   # new workspaces in another folder
pnpm desktop -- --open ~/research/notes
pnpm desktop -- --open ~/research/notes --engine none --format pandoc-markdown --format text
pnpm desktop -- --join http://192.168.1.20:4321 --token <token>
```

The app runs a hub inside it, on the loopback address with a random token: your workspaces,
added from the app (see above), each committing under its folder's git identity. **Open a
folder…** (or `--open`) adds a folder and opens it. If the folder is not a git repository, the app asks
before initialising one. The folder stays usable by other programs while it is open; their
changes appear in the editor. Quitting writes and commits any pending edits.

Joining a shared host or hub runs none of the app's own; the launcher leads back to your workspaces.

**Preferences…** (in the app menu on a Mac, ⌘,; in File elsewhere) sets what the flags would: syncing with other
devices, running R code (and whether Podman is ready for it), base images R may use, and where new
workspaces go. Saving restarts your workspaces, committing pending edits first. A flag given on the
command line wins over its preference.

## Package the desktop app

The app packages as one file that runs where it is, with nothing to install, not even git:

```sh
pnpm --filter @kuraa/desktop dist:mac     # dist/kuraa-<version>-mac-{arm64,x64}.{dmg,zip}
pnpm --filter @kuraa/desktop dist:win     # dist/kuraa-<version>-windows-x64.exe (portable)
pnpm --filter @kuraa/desktop dist:linux   # dist/kuraa-<version>-linux-x86_64.AppImage
```

It ships its own git: GitHub Desktop's builds of it ([dugite-native](https://github.com/desktop/dugite-native)),
fetched by `apps/desktop/scripts/fetch-git.mjs` and checked against pinned checksums, less Git
Credential Manager and git-lfs. Every device then runs the same git. Its system-wide settings are
left out, and files are always written as git stores them (no `core.autocrlf`); the person's own
`~/.gitconfig` still applies. Git is GPLv2: distributing the app means offering git's source too (the
script names the release). `pnpm desktop` uses this git as well once it has been fetched
(`pnpm --filter @kuraa/desktop fetch-git`), and the computer's otherwise.

Running R still needs Podman installed; everything else works without it, and Preferences says
whether it is ready.

**macOS.** Build on a Mac. electron-builder signs with the *Developer ID Application* certificate in
the keychain (make one at developer.apple.com → Certificates; *Apple Development* and *Apple
Distribution* certificates sign only for this Mac and the App Store). It notarizes when Apple
credentials are in the environment, most simply a keychain profile:

```sh
xcrun notarytool store-credentials kuraa --apple-id <apple id> --team-id <team id>
APPLE_KEYCHAIN_PROFILE=kuraa pnpm --filter @kuraa/desktop dist:mac
```

**Windows.** One `.exe`, x64 (it also runs on Arm under emulation), unsigned: Windows SmartScreen
warns before its first run. It unpacks itself each time it starts, so it takes a few seconds to
open. It builds on a Mac as well as on Windows.

**Linux.** An AppImage: `chmod +x` it and run it. Some distributions need FUSE (`libfuse2`) for
AppImages.

The packaged app turns off what it does not need (Electron's fuses): Node's inspector and
`NODE_OPTIONS`, so nothing can attach to it, and loading code from outside its signed archive. It
keeps running as Node, for `git-remote-kuraa`. The desktop tests can run against a packaged app,
with no git on its PATH, through a copy with the inspector on (which Playwright needs):

```sh
KURAA_DESKTOP_APP=$(node apps/desktop/scripts/testable-copy.mjs apps/desktop/dist/mac-arm64/kuraa.app) \
  npx playwright test --project desktop
```

The app has no icon of its own yet: put `icon.png` (1024×1024) in `apps/desktop/build-resources`.

## Checks

```sh
pnpm check       # lint (including the package dependency rules), typecheck, unit and host tests
pnpm test:e2e    # browser and desktop tests; run `npx playwright install chromium` once first
```

The desktop tests run the app with its windows hidden, so they do not take over the screen;
`KURAA_SHOW_WINDOWS=1 pnpm test:e2e` shows them, to watch.

| Milestone | Test |
| --- | --- |
| M0 | `pnpm check` |
| M1, M6, M7 | `packages/format-*/test`: identity, locality, oracle, fixed point, fuzz and totality on the 22-file corpus in [fixtures/corpus](fixtures/corpus/); exact round trips and matching for source files in [fixtures/text](fixtures/text/) |
| M2–M5, M9 | `packages/host/test`: headless clients against a real host and git repo |
| M2 | `tests/e2e/collab.spec.ts`: two browsers type into one paragraph, converge and show each other's cursors |
| — | `tests/e2e/cues.spec.ts`: typed markdown cues format the text, and the file keeps that markdown |
| — | `tests/e2e/text.spec.ts`: source files are highlighted; Enter, Tab and paste keep indentation and line endings |
| — | `packages/host/test/render.test.ts`, `render-podman.test.ts`, `tests/e2e/render.spec.ts`: documents render to HTML, Word and PDF in Podman, from the live text, never into the workspace, previewed without running anything (Podman ones skipped without it) |
| — | `packages/host/test/search.test.ts`, `tests/e2e/search.spec.ts`: search finds text in every text file and in what is being typed, and opens the match; `tests/e2e/versions.spec.ts`: past versions compared and restored |
| — | `packages/host/test/runner.test.ts`, `tests/e2e/run.spec.ts`: R chunks run on the host, outputs reach every client, interrupt and restart work, files stay untouched, and code cannot see this computer (skipped without Podman) |
| M8 | `tests/e2e/desktop.spec.ts`: the Electron app opens a folder, edits and commits while other programs edit the folder and `git pull` into it; survives a reload; joins a shared host; the launcher initialises a plain folder and joins a host |
| — | `tests/e2e/dev.spec.ts`: `pnpm dev` serves a working client with nothing to configure, and Ctrl+C commits pending edits |

## Layout

| Package | Role |
| --- | --- |
| `packages/kernel` | Document type registry, hook bus and merging (lines, words, blocks). No DOM, no Node, no formats |
| `packages/run-kit` | The contract between run components: engines (languages) and environments (where processes run), the policy |
| `packages/engine-r` | Engine component: R, running `r` chunks through `evaluate`, and rendering R Markdown and Markdown (rmarkdown, pandoc, Typst) |
| `packages/env-podman` | Environment component: a locked-down Podman container |
| `packages/run-components` | The run components that ship, for the programs that start a host; the host imports none |
| `packages/editor-kit` | The contract for a format's editor module (types only) |
| `packages/format-pandoc` | Pandoc markdown: schema, position-preserving parser, block-preserving serializer; `/editor`: cues, keys, footnotes |
| `packages/format-rmarkdown` | R Markdown, built only on format-pandoc's extension points; `/editor`: chunk fences |
| `packages/format-text` | The Text file type for scripts, data and settings files, one node per line, highlighted by file name |
| `packages/formats` | `standardTypes`, which the host and the web client both load; `/editor`: their editor modules |
| `packages/session` | The only package that touches Yjs, y-prosemirror and Hocuspocus |
| `packages/host` | Relay, bridge between rooms and files, committer, git peer, merges (`merging.ts`), devices (`peers/`), hub of many workspaces (`hub.ts`), HTTP API, CLI, run component registry |
| `packages/client` | The client (Vue): file tree, editor, menu, history, settings ([decision 0016](docs/decisions/0016-vue-client.md)) |
| `apps/web` | Web shell for the client (Vite) |
| `apps/desktop` | Electron shell, embedding the host |
| `scripts/dev.ts` | `pnpm dev`: host under `tsx watch`, client under Vite, one origin |

## Known limits

- Two people typing at exactly the same caret position interleave their keystrokes. Text still
  converges; typing anywhere else in the same paragraph does not interleave.
- Conflicts are kept a block at a time (a whole paragraph), not marked within a sentence.
- The Windows and Linux packages have not yet been run on Windows or Linux; only the macOS one has
  been tested. On Windows the desktop app cannot serve its workspaces' git over HTTP (`git clone` from
  a host's `/git`): the git it ships has no `git-http-backend`.
- Edits made while disconnected are kept and sent on reconnect. If the host reseeded the file in
  the meantime (for example after its room cache was cleared), the client only warns.
- The corpus does not yet include real working files from the project's first users.
