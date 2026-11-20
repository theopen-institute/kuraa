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

The desktop app sets the same things in **Preferences…**, so nobody double-clicking it needs a flag;
the last column says where. What stays on the command line, and why, is in
[decision 0046](docs/decisions/0046-desktop-preferences.md).

| Option | Default | Notes | Desktop app |
| --- | --- | --- | --- |
| `--port` | `4321` | — | Command line only: its server is private to the app |
| `--host` | `127.0.0.1` | Use `0.0.0.0` to let collaborators on your network connect | Command line only (as `--port`) |
| `--token` | random | Or set `KURAA_TOKEN` | Command line only (as `--port`) |
| `--workspaces` | off | Be a hub of many workspaces, added from the app, kept in this folder. See below | Preferences: New workspaces |
| `--peer` | off | Sync with this workspace's other devices, directly. See below | Preferences: Other computers |
| `--allow-invites` | off | Let people make invite links, remove devices and rename this one from the app (`--workspaces` always does) | Always on |
| `--manage-online` | off | Let people using the app add and remove the online copy (desktop app and `pnpm dev`: on). See below | Always on |
| `--manage-person` | off | Let people using the app see and import this computer's identity (your own computer only; `pnpm dev`: on) | Always on |
| `--bootstrap` | Hyperswarm's | DHT nodes for finding devices (`host:port`), for a private network | Preferences: Other computers › Advanced |
| `--flush-ms`, `--commit-ms` | 2000, 30000 | Write to disk after this long idle; commit after this long idle | Preferences: Saving › Advanced (in seconds) |
| `--engine` | off | Turn on running code: `--engine r`. See below | Preferences: Run R code (on) |
| `--env` | the only one loaded | Where code runs, by environment: `--env podman` | Preferences: Where code runs (shown when there is a choice) |
| `--allow-unsandboxed` | off | Allow an environment that is not sandboxed (none ships) | Command line only |
| `--memory` | `4g` | The most memory a code session's container may use | Preferences: Running code › Advanced |
| `--cpus` | `2` | How many CPUs a code session's container may use (fractions allowed: `0.5`) | Preferences: Running code › Advanced |
| `--disk` | `2g` | The most a code session may write (its scratch folder and `/tmp`); past it, the session is stopped | Preferences: Running code › Advanced |
| `--podman` | found on the `PATH` or where the installers put it | The Podman program to run containers with; or set `KURAA_PODMAN` | Preferences: Running code › Advanced |
| `--r-image` | the default | Further base images a workspace may name for R in `.kuraa/run.json` (repeatable) | Preferences: Running code › Advanced |
| `--format` | all | The document formats that are on: `--format pandoc-markdown --format text` | Preferences: Kinds of documents |
| `--component` | none | Load a run component (engine or environment) by path or package name | Command line only |
| `--allow-write`, `--allow-network` | off | Let a workspace ask for write access to itself, or for the network | Preferences: Running code › Advanced |
| `--allow-installs` | off | Let people install packages (desktop and `pnpm dev`: on) | Preferences: Running code (on) |
| `--data-dir` | your app data folder | Where package versions are stored, shared by workspaces | Preferences: Running code › Advanced |

Everyone who has the URL and token can edit. The first time, the app welcomes each person and asks
what to call them, with an email (for co-author credit) and a cursor colour; the menu's **You**
section changes them. In the app the URL and token are the **server address** and **access code**.

The editor has no toolbar: type markdown (`**bold**`, `## `, ```` ```{r} ````, `[text](url)` and
so on) and it is formatted as you type; Backspace straight afterwards undoes the conversion. The
full list is in [decision 0008](docs/decisions/0008-markdown-cues.md). Citations are typed as
Pandoc writes them (`[@smith2020, p. 3]`, `@smith2020`); typing `@` offers the keys of the
bibliography the header names, and citations show as "Smith 2020", a key the bibliography lacks
marked. Paste or drop an image to keep it in `images/` beside the document; `| a | b |` then Enter
makes a table (Tab between cells, right-click for rows and columns; **Insert table** in the menu);
`$$` then Enter starts display math. ⌘F finds and replaces, ⌥⌘O shows the outline, and ⌥⌘N goes to
the next conflict; clicking a file's conflict count opens it at the first
([decision 0040](docs/decisions/0040-writing-in-the-editor.md)). An empty document says how to start,
and ⌘/ (Ctrl+/), the menu, or the desktop app's Help menu lists everything that can be typed and
pressed, from the same tables the editor binds its keys from
([decision 0044](docs/decisions/0044-polish.md)).

The sidebar shows the workspace folder, with a button for a new file (＋); right-click the space
below the files for a new folder, and each folder has buttons for both on hover. Documents (Markdown and R Markdown) are listed by their **title**;
text and source files by filename, each with a small icon its type defines (a page, code, data,
settings, a bibliography, …: [decision 0023](docs/decisions/0023-file-icons.md)). A new document is asked for its title, and its filename is made
from it (`Tidal notes: Café` → `tidal-notes-cafe.md`); **Rename…** changes a document's title and
its filename, together or apart ([decision 0022](docs/decisions/0022-titles-and-filenames.md)). Drag a file or folder onto a folder to move it there, or onto the
workspace name to move it to the top level, or use **Move to…** in its right-click menu; each move is
committed. Right-click a file for **Open**, **Header…**, **Rename…**, **Move to…**, a new file or folder
beside it and **Delete…**, or a folder for a new file or folder in it, **Rename…** (everything in it goes
with it) and **Move to…**. The list works from the keyboard as a tree: arrows move and open folders,
Enter opens, F2 renames, Delete deletes, Shift+F10 shows the menu.

A Markdown or R Markdown document's **header** (the YAML block at the top: title, authors, date,
bibliography, PDF and HTML settings, …) is not shown in the page. **Header…** opens it as fields
to fill in, with Pandoc's standard fields (and R Markdown's `output` and `params`) offered by name,
or as YAML; the Source view shows it as text ([decision 0021](docs/decisions/0021-document-header.md)).

Everything else is in the **menu**, from the bottom of the sidebar or
⌘, (Ctrl+,), which takes the keyboard's focus as every dialog does: the document's **Source** (the markdown, which you can edit there too, alongside
others editing the rich view: [decision 0015](docs/decisions/0015-editable-source.md)), **History**,
**Header…**, **Save version**, **Preview** (below), when it was last saved and kept in the history; the code session; the workspace,
**Search…** (⇧⌘F: every text file, and open documents as they are being typed; a result opens the
file at the match, [0042](docs/decisions/0042-search.md)), **Sync** (offered once there is an online
copy or another device; it says "Up to date" or how many changes it brought in) and who is here;
**Components…** and **Markdown and shortcuts**; and your settings. Commit ids and branch names are
behind **Details**. The bottom of the sidebar shows whether you are connected and how many others are
here; while the connection is lost, a banner says so, with how many changes are waiting to be sent and
**Try again now**. Saving paused or failing (git busy outside the app) is a banner while it lasts.
Passing news (an outside edit merged) appears as a note in the corner; an outside edit that
conflicted has **Open** and **Compare** in its note. Errors are said in plain words, with what was
actually said behind **Details** ([decision 0044](docs/decisions/0044-polish.md)).

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

## An online copy

A workspace can keep a copy on a git server: GitHub, GitLab, any git host, or a folder. In the
menu's **Online copy** section (the desktop app, `pnpm dev`, or a host started with
`--manage-online`), add the address of an empty repository, such as
`git@github.com:you/notes.git`; from the command line, `pnpm host online add <address> --dir
<workspace>` (or the name of a remote already there, such as `origin`). Each save is pushed to it,
with your own git credentials (an SSH key, or a credential helper for https). On **Sync**, and
every few minutes, it is fetched from and its work merged in, as another device's would be, so
computers that cannot reach each other directly still meet through it: add the same address on
each. If someone else pushed first, this device fetches, merges and pushes again; it never
force-pushes ([decision 0039](docs/decisions/0039-online-copy.md)).

## Many workspaces: a hub

A hub serves many workspaces at one address and token, and lets people add them from the app
([decision 0029](docs/decisions/0029-hub.md)):

```sh
pnpm host --workspaces ~/research --static apps/web/dist
```

In the app, the workspace's name at the top of the sidebar switches between them and adds new
ones: a new folder (made a git repository, inside `~/research`), or a workspace someone shared,
joined with their invite link. **Invite people…** (there, and in the menu) makes an invite link
for the open workspace, to send to whoever should join it. The desktop app works this way by itself:
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
pnpm host invite --dir ~/research/notes          # an invite link for one person, for a week
pnpm host invite --anyone --forever --dir ~/research/notes   # or for anyone with it, with no expiry
# On another device:
pnpm host join kuraa-invite:… --dir ~/notes      # fetches the workspace
pnpm host --dir ~/notes --peer --static apps/web/dist
```

**Every member has the same say** ([decision 0038](docs/decisions/0038-equal-peers.md)): every
member's work comes in, on every branch, and any member may invite people, remove anyone, and
revoke links. An invite link is for one person (the first device it lets in uses it up) or for
anyone who has it, and lasts a day, a week (`--hours`) or forever (`--forever`), unless revoked
(`pnpm host revoke-invite <id>`; `pnpm host invites` lists them). Any running device of the
workspace can let someone in. Whoever joins can read and change everything, and invite and remove
others: share a link only with people you trust with that. It carries the workspace's secret.
The trust model is to be redesigned; its known weaknesses are listed in 0038.

In the app, the menu's **Devices** section lists who is in the workspace, by person and computer,
online or offline, with **Remove…** (for good; they keep their copy) and **Rename this
computer…**; **Invite people…** makes and lists invite links, to revoke. From the command line,
`pnpm host devices` lists them; `remove-device`, `name` and `fork` manage them. Paired devices
are git remotes (`kuraa://<device key>`): `git log laptop/main` shows what a device has.

Merges are the same on every device, so work done apart comes together into one history. A
document open on several devices is one live room there, saved by one of them (the one with the
lowest key). Commits are signed, for attribution only: each person has a signing key on each
computer, which their identity vouches for, so `git log --show-signature` and the app can say who
wrote what ([0035](docs/decisions/0035-identities-and-signing-keys.md)). Your identity is made for
you, from your name, the first time the app knows it; the menu's **You** section says "You on this
computer", and keeps the keys under **Advanced**: copy your identity there to a second computer
(it replaces the one made there), or revoke a lost computer's key. From the command line, `pnpm
host person [create | export | import | revoke <key>]`; `pnpm host signing-key` prints this
computer's signing key, to add to GitHub as a signing key.

In the desktop app, turn on **Sync every workspace with the other computers it is on** in
Preferences (or pass `--peer`); workspaces you invited people to, or joined, always sync.

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
URL and token in the welcome, or later in the menu's **Server and access code…**.

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

**Preferences…** (in the app menu on a Mac, ⌥⌘,; in File elsewhere, Ctrl+Alt+,; or **App preferences…** in
the in-app menu, which keeps ⌘, for itself) sets what a host's flags would (the table under
[Run a shared host](#run-a-shared-host-on-a-folder) says which). In view: syncing with other
computers, the kinds of documents that are on, running R code (and whether Podman is ready for it),
whether documents may install packages and download tools, and where new workspaces go. Under
**Advanced**: the servers used to find other computers on a private network, the limits on each
document's code (memory, CPUs, disk), what a workspace may ask for (writing to its own folder, the
network), base images R may use, the Podman program, where packages and tools are kept, and how soon
edits are written and versions saved. Saving restarts your workspaces, committing pending edits first;
a value that is wrong is refused, saying what. A flag given on the command line (`--engine`, `--env`,
`--format`, `--r-image`, `--peer`, `--workspaces`) wins over its preference, and the window says so.

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
| — | `tests/e2e/citations.spec.ts`, `images.spec.ts`, `tables.spec.ts`, `find.spec.ts`: the citation picker and chips, pasted images, tables, find and replace, the outline and going to conflicts |
| — | `tests/e2e/text.spec.ts`: source files are highlighted; Enter, Tab and paste keep indentation and line endings |
| — | `packages/host/test/render.test.ts`, `render-podman.test.ts`, `tests/e2e/render.spec.ts`: documents render to HTML, Word and PDF in Podman, from the live text, never into the workspace, previewed without running anything (Podman ones skipped without it) |
| — | `packages/host/test/search.test.ts`, `tests/e2e/search.spec.ts`: search finds text in every text file and in what is being typed, and opens the match; `tests/e2e/versions.spec.ts`: past versions compared and restored |
| — | `packages/client/test/polish.test.ts`, `packages/format-pandoc/test/editor-help.test.ts`, `tests/e2e/polish.spec.ts`: the shortcuts sheet lists what is bound, errors in plain words, the offline banner, the keyboard file tree, dialogs keeping focus |
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
- Symbolic links in a workspace are listed but never opened or followed, and files not saved as
  UTF-8 (a Latin-1 `.bib`) are not opened for editing ([decision 0037](docs/decisions/0037-host-safety.md)).
- While git is in the middle of an operation in the folder (a rebase, a merge with conflicts), or no
  branch is checked out, nothing is saved: edits wait in the app until it is done. A branch switched
  outside the app moves open files to that branch's version, saving their edits on the old branch.
