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

## Run a host

Build the web client once, then start the host:

```sh
pnpm web:build
pnpm host --static apps/web/dist                       # your workspaces, as the desktop app
pnpm host --dir ~/research/notes --static apps/web/dist   # one folder, and nothing else
```

With neither `--dir` nor `--workspaces`, `pnpm host` serves **your workspaces**, just as the desktop
app does: new ones go in the folder Settings names (`Documents/kuraa` at first), its list and its
settings are kept with the app's data (`settings.json` and `host-workspaces.json`, or beside the file
`--settings` names), so choosing another folder for new workspaces keeps the list. `--workspaces
<folder>` names that folder instead (its list kept in it), and wins over Settings. `--dir` serves
exactly one folder, a git working tree (`--init` makes it one), and nothing can be added from the
app. Either way it is the same kind of server, a hub
([decision 0030](docs/decisions/0030-one-kind-of-server.md)).

The host prints its URL, the access token, a link that opens the client with the token filled
in, and for `--dir` a `git clone` command. Run as a service (`kuraa-host install --service`), it
leaves the token out, as its output is a log file.

**Whoever has the access code of a host listening only on this computer is its owner**, as the
person using the desktop app is ([decision 0047](docs/decisions/0047-browser-equals-desktop.md)):
in a browser too they have **Settings…**, **Open a folder…** (any folder on the computer, chosen
in the page), their identity and the online copy. That is the default (`--host 127.0.0.1`). With
`--host` naming a network address, those are off, and the app says why; invites and devices stay,
for the workspace's admins ([0066](docs/decisions/0066-permissions-without-a-centre.md)). A server
for many people will need a design of its own.

Every setting below is in **Settings** (This computer’s server), in a browser and in the desktop app alike, so nobody
needs a flag; a flag given at start wins over its setting for as long as the host runs, and
Settings says so. The last column says where. What stays on the command line, and why, is in
[decision 0047](docs/decisions/0047-browser-equals-desktop.md).

| Option | Default | Notes | In the app |
| --- | --- | --- | --- |
| `--port` | `4321` | — | Command line only: how the server is reached |
| `--host` | `127.0.0.1` | Use `0.0.0.0` to let collaborators on your network connect (Settings, opening folders and your identity are then off) | Command line only (as `--port`) |
| `--token` | random | Or set `KURAA_TOKEN` | Command line only (as `--port`) |
| `--static` | none | The built web client to serve | Command line only (as `--port`) |
| `--allow-origin` | none | A page served elsewhere that may use the server (its origin, e.g. `https://notes.example.org`); repeatable. The server's own page, `pnpm dev` and the desktop app need none | Command line only (as `--port`) |
| `--dir` | off | Serve this one folder, and nothing else | Command line only; **Open a folder…** adds one to your workspaces |
| `--settings` | `settings.json` in your app data folder | Where Settings are kept | Command line only |
| `--workspaces` | Settings, else `Documents/kuraa` | Where new workspaces go (their list kept in it). See below | Settings: New workspaces |
| `--bootstrap` | Hyperswarm's | DHT nodes for finding devices (`host:port`), for a private network | Settings: Other computers › Advanced |
| `--relay` | none | Relays to connect through when computers cannot connect directly, by key (`pnpm host relay` runs one) | Settings: Other computers › Advanced |
| `--peer-port`, `--public-address` | none | A server's: take devices' connections over TCP on this port, and where they reach it (`host` or `host:port`), for networks that block UDP; told to members and put in invite links | Command line only |
| `--dht-port`, `--no-serve-dht` | any, serving | A server's: its DHT node on a fixed port, for members to start from; never serving the public DHT | Command line only |
| `--flush-ms`, `--commit-ms` | 2000, 30000 | Write to disk after this long idle; commit after this long idle | Settings: Saving › Advanced (in seconds) |
| `--engine` | `r` | Which engines run code: `--engine r`, or `--engine none`. See below | Settings: Run R code |
| `--env` | the only one loaded | Where code runs, by environment: `--env podman` | Settings: Where code runs (shown when there is a choice) |
| `--memory` | `4g` | The most memory a code session's container may use | Settings: Running code › Advanced |
| `--cpus` | `2` | How many CPUs a code session's container may use (fractions allowed: `0.5`) | Settings: Running code › Advanced |
| `--disk` | `2g` | The most a code session may write (its scratch folder and `/tmp`); past it, the session is stopped | Settings: Running code › Advanced |
| `--r-image` | the default | Further base images a workspace may name for R in `.kuraa/run.json` (repeatable) | Settings: Running code › Advanced |
| `--format` | all | The document formats that are on: `--format pandoc-markdown --format text` | Settings: Kinds of documents |
| `--allow-write`, `--allow-network` | off | Let a workspace ask for write access to itself, or for the network | Settings: Running code › Advanced |
| `--allow-installs` | on | Let people install packages and download tools such as TeX (`--no-allow-installs` to refuse) | Settings: Running code |
| `--data-dir` | your app data folder | Where package versions and tools are stored, shared by workspaces (an empty folder, or one already used for them) | Settings: Running code › Advanced |
| `--podman` | found on the `PATH` or where the installers put it | The Podman program to run containers with; or set `KURAA_PODMAN` | Command line only: it names a program run with your rights |
| `--component` | none | Load a run component (engine, environment or tool) by path or package name | Command line only: code run with your rights |
| `--allow-unsandboxed` | off | Allow an environment that is not sandboxed (none ships) | Command line only: code run with your rights |

`--allow-invites`, `--manage-online` and `--manage-person` are gone: invites are always on, and the
online copy and your identity follow from where the host listens.

Everyone who has the URL and token can edit. The first time, the app welcomes each person and asks
what to call them, with an email (for co-author credit) and a cursor colour; the menu's **You**
section changes them. In the app the URL and token are the **server address** and **access code**.

## Settings

**Settings…** in the menu's **You** section, or ⌥⌘, (Ctrl+Alt+,; ⌘, is the menu's own), opens
one window in a browser and in the desktop app (where it is also in the app menu on a Mac, and
in File elsewhere), in two parts ([0060](docs/decisions/0060-one-settings-window.md)). **You**:
your name, email and cursor colour, kept in this browser and saved as each is changed; your key
on this computer; and, where the app does not run the server itself, the server address and access
code. **This computer’s server**, wherever the host listens only on this computer: in view, the kinds of
documents that are on, running R code (and whether Podman is ready for it),
whether documents may install packages and download tools, and where new workspaces go. Under
**Advanced**: the servers used to find other computers on a private network, the limits on each
document's code (memory, CPUs, disk), what a workspace may ask for (writing to its own folder, the
network), base images R may use, where packages and tools are kept, and how soon edits are written
and versions saved. A value that is wrong is refused, saying what. Saving reopens every workspace
with them, committing pending edits first, at the same address and access code, and the page reloads.
A flag given at start wins over its setting, and the window says so. The desktop app keeps them in
`preferences.json` with its data, `pnpm host` in `settings.json`, `pnpm dev` in
`.dev-workspaces/settings.json` ([decision 0047](docs/decisions/0047-browser-equals-desktop.md)).

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
settings, a bibliography, …: [decision 0023](docs/decisions/0023-file-icons.md)). **＋** makes an untitled Markdown document at
once and opens it with the cursor in its title; when you leave it, its filename is made from the title you typed
(`Tidal notes: Café` → `tidal-notes-cafe.md`). **Rename…** changes a document's title and its filename, together or
apart ([decision 0022](docs/decisions/0022-titles-and-filenames.md)), and any file's kind: Markdown, R Markdown, a text
file ([decision 0056](docs/decisions/0056-new-files-at-once.md)). Drag a file or folder onto a folder to move it there, or onto the
workspace name to move it to the top level; each move is committed. Right-click a file for
**Document settings…**, **Rename…** and **Delete…**, or a folder for a new file or folder in it and
**Rename…** (everything in it goes with it). The list works from the keyboard as a tree: arrows move and open folders,
Enter opens, F2 renames, Delete deletes, Shift+F10 shows the menu.

A Markdown or R Markdown document's **header** (the YAML block at the top: title, authors, date,
bibliography, PDF and HTML settings, …) is not shown in the page, except its **title**, which is the page's top
heading and is typed there (↑ at the top of the text goes up to it, Enter comes back down; [decision 0055](docs/decisions/0055-title-in-the-page.md)).
**Document settings** shows the whole header as fields
to fill in, with Pandoc's standard fields (and R Markdown's `output` and `params`) offered by name,
or as YAML; the Source view shows it as text ([decision 0021](docs/decisions/0021-document-header.md)).

The open document's **⋯** (its top-right corner) is a menu of what to do with it
([0074](docs/decisions/0074-the-document-menu-is-a-menu.md)): **Source** (the markdown, which you
can edit there too, alongside others editing the rich view: [decision 0015](docs/decisions/0015-editable-source.md))
and **History**, ticked when shown; **Preview** (below); **Find and replace…**, **Outline**, **Insert
table**; **Save version…**; its code session (**Run all**, **Restart**, **Packages…**); and
**Permissions…**, **Document settings…** and **Markdown and shortcuts**, each with its keys; below
them, when it was last saved and kept in the history. **Search** (⇧⌘F: every text file, and open documents as they are being
typed; a result opens the file at the match, [0042](docs/decisions/0042-search.md)) is beside **+**
at the top of the sidebar ([decision 0065](docs/decisions/0065-no-menu.md)). There is no Sync button:
devices sync as they connect and the online copy every few minutes
([0076](docs/decisions/0076-a-quieter-sidebar.md)).

Settings are in one window of four sections, each saying who it applies to and where it is kept
([decision 0064](docs/decisions/0064-four-kinds-of-settings.md)): **You** (your name, email and
colour, your key, and how each kind of document is edited for you; in this browser), **Document**
(the open document's header; in its file), **Workspace** (its name, as its heading, with **Rename
workspace…**; packages, people and computers, its groups and permissions, and removing it from the
list; in the workspace) and **Server** (its settings, only its owner changes them; and every component
it has, the online copy among them, with its settings for the open workspace). **Workspace settings…**,
in the menu of the workspace's name, opens it at the workspace; ⌘, (Ctrl+,) at the open document
(else the workspace); **Document settings…** and right-clicking a file at the document; ⌥⌘, where you
left it. Commit ids and branch names are behind **Details**. A light left of the workspace's name
says whether you are connected (green), and its tooltip who else is here; while the connection is lost, a banner says so, with how many changes are waiting to be sent and
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
made with Typst, which the environment has, so no TeX is needed. A header asking for a LaTeX engine
(`latex_engine: xelatex`, `pdf-engine:`) gets TeX as a **tool**: where installs are allowed, the
panel offers **Download PDF with LaTeX** (TinyTeX, about 54 MB, kept once on this computer) and
renders again when it is there; LaTeX packages a document lacks are added when it first needs them
and recorded in `.kuraa/tex-packages.json`, so other computers add them before their first PDF.
Without permission, the PDF is made with Typst and says why
([decision 0045](docs/decisions/0045-tools.md)). Rendering runs where code runs (in Podman, with the workspace
read-only and no network), so it needs `--engine r` and Podman, like running chunks; the panel says
what is missing. Outputs are kept in `.git/kuraa/renders/`, never beside the document
([decision 0041](docs/decisions/0041-rendering.md)).

## An online copy

A workspace can keep a copy on a git server: GitHub, GitLab, any git host, or a folder. It is a
component (`@kuraa/sync-git`, loaded with the others; [decision 0059](docs/decisions/0059-online-copy-is-a-component.md)).
In **Settings › Server**, under its components, the online copy's **Settings…** (for the open workspace;
wherever the host listens only on this computer: the desktop app, `pnpm dev`, `pnpm host`), add the address of an empty repository, such as
`git@github.com:you/notes.git`; from the command line, `pnpm host online add <address> --dir
<workspace>` (or the name of a remote already there, such as `origin`). Each save is pushed to it,
with your own git credentials (an SSH key, or a credential helper for https). Every few minutes it is
fetched from and its work merged in, as another device's would be, so
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

**A workspace has one name, the same for everyone in it**
([0061](docs/decisions/0061-one-name-for-a-workspace.md)). Whoever makes it names it; it is kept in
the workspace itself, in `.kuraa/workspace.json`, so whoever joins sees it by that name and is not
asked for one. **Rename workspace…** in the menu renames it for everyone: the rename is a commit,
crediting who made it, which reaches every device as any change does, and each device's list of
workspaces follows. A workspace made before then goes by what each device calls it until it is
first shared (its first invite link names it, as that device calls it) or renamed. Two renames at
once keep the first of them, the same on every device, until someone renames it again. The folder
a joined workspace is copied into is `shared-workspace` (or `-2`, …): only its name is shared.

## A server that updates itself

For a computer that serves kuraa all the time (to browsers, or as an always-on device of shared
workspaces), each release has the server on its own: `kuraa-server-<version>.tar.gz`, the server
and the web client in one folder, needing only Node 24 and git (and Podman to run R). Installed,
it updates itself ([decision 0052](docs/decisions/0052-the-server-updates-itself.md)):

```sh
v=$(curl -sLo /dev/null -w '%{url_effective}' https://github.com/<owner>/<repo>/releases/latest); v=${v##*/v}
curl -L https://github.com/<owner>/<repo>/releases/download/v$v/kuraa-server-$v.tar.gz | tar xz
node kuraa-server-*/kuraa-host.mjs install --service -- --workspaces ~/kuraa
# Installed kuraa in ~/.kuraa/server, with a service (systemd on Linux, launchd on macOS) that runs
# ~/.kuraa/server/kuraa-host --auto-update --workspaces ~/kuraa, with an access code of its own.
systemctl --user daemon-reload && systemctl --user enable --now kuraa   # as it says
```

The flags after `--` are the server's (`--host`, `--port`, `--workspaces`, as above). For devices on
networks that block UDP (many companies and universities), and to be where the workspace's devices
start from, give it a public address: `-- --workspaces ~/kuraa --peer-port 443 --public-address
kuraa.example.org --dht-port 49737`, with those ports open in its firewall (TCP 443, UDP 49737).
Members learn them from it, and invite links made from then on carry them. With
`--auto-update`, it looks for a newer release every six hours, takes it only if it is signed with
the release key, puts it beside the one running, and restarts to use it at night (between 3 and 5),
or at once when a device of a workspace runs a newer kuraa (the two do not sync until then). Its
service starts it again; the version before is kept. `~/.kuraa/server/kuraa-host update` takes the
latest by hand, for the next start; `--version` says which runs. Run from the repository (`pnpm
host`), a server does not update itself: `git pull`, `pnpm install` and `pnpm web:build`.

## On several devices

A workspace can be on several devices at once, each running its own host, with no server in
between ([decision 0028](docs/decisions/0028-peers.md)). A workspace syncs once it is shared:
inviting someone to it, or joining it from an invite link, makes it so, for good. One on this
computer alone has nothing to sync with, so there is no setting for it
([0048](docs/decisions/0048-shared-workspaces-always-sync.md)). When people on two devices
have the same document open, they edit it together live, in one session of it; what is done apart
reaches the other devices through git as soon as they meet, and their sessions become one
([0077](docs/decisions/0077-one-leader-per-room.md)). Merges read documents and never stop: a passage both
sides changed differently stays in the document with both versions, to choose between there
([0025](docs/decisions/0025-merging.md)).

```sh
# On the first device (inviting makes the workspace shared; its host syncs it from then on):
pnpm host invite --dir ~/research/notes          # an invite link for one person, for a week, as a member
pnpm host invite --anyone --forever --dir ~/research/notes   # or for anyone with it, with no expiry
pnpm host invite --admin --dir ~/research/notes  # who joins by it is an admin
# On another device:
pnpm host join kuraa-invite:… --dir ~/notes      # fetches the workspace
pnpm host --dir ~/notes --static apps/web/dist
```

**A workspace has an owner, admins and members** ([decisions 0066](docs/decisions/0066-permissions-without-a-centre.md),
[0070](docs/decisions/0070-an-owner.md)). The owner, whoever made the workspace, is the one admin
who makes and unmakes admins; they hand the role to someone else with **Make owner…**, staying an
admin.
everyone reads everything; only admins invite people, remove devices, make others admins or
members or take them out, and say who may change a file or folder (Workspace settings' **Permissions**, below its **Workspace groups**; a
file's or folder's **Permissions…**, or `pnpm host rule chapters/ Ada group:editors`; `rules` lists
them, `group` manages groups). Where nothing is said, anyone may change it. A document you may not
change opens read only, saying who may. A change by anyone else (made outside the app) is kept out
where it comes in: every device's merge keeps its own version of the file, and the change stays in
the file's history, listed as *not kept*, to read and for someone who may change it to restore; its
maker is told ([0072](docs/decisions/0072-ranks-devices-and-changes-not-kept.md)). Changes to the
policy made at the same time on different devices settle the same way everywhere: the one that
gives less counts, whoever made it (out beats member beats admin; a removal beats what the one taken
out did meanwhile; of two rules, the narrower), and each such clash is listed in Workspace settings,
where whoever may can **Make it again** after both
([0078](docs/decisions/0078-restrictive-wins.md)). What someone taken out, or a dropped, revoked or lost key, signs after that counts for
nothing anywhere; merges are made again by every device that brings them in, so none can slip a
change past the rules. How every device works the policy out is in [docs/policy.md](docs/policy.md).

**Devices are in as their people are** (0072): a computer is in the workspace where its key is
vouched for by someone the workspace has in it; taking someone out takes their computers out, and
**Lost or no longer used…** drops one computer's key (its own person, or an admin). Workspace
settings list recent removals and who has confirmed each so far; admins may name *witnesses*
(usually an always-on server) whose devices confirm them.

**Permissions** are on files and folders ([0069](docs/decisions/0069-permissions-on-files-and-folders.md)):
a file's or folder's **Permissions…** (its right-click menu, or a document's ⋯ menu) say who can
read it and who can change it, each its own or as the folder above says (the nearest up the tree
counts). Who can change anything is the admins' to say; who reads a file, whoever may change it;
who reads a folder (and so what is made in it, which goes straight to its readers), the admins'.
Permissions go with a file or folder when an admin moves it (anyone else is told they cannot move
what has its own). The file list marks what fewer read (a lock) or fewer may change (a pen), and
Workspace settings' **Permissions** lists them all. A permission about something private names it
by a hash, so members who cannot see it do not learn its path.

**Who can read a file**: everyone in the workspace, only you, or people and groups. A file read by fewer is kept in a *space*: a
history of its own in the repository (`refs/spaces/…`), which devices send only to the devices
of the people who may read it, so no one else's device ever has it, nor its history. On your
device its files lie in the folder with the rest, marked with a lock in the file list, and kept
out of plain git's way (`.git/info/exclude`). A folder read by fewer holds a space of its own:
changing who reads it moves nothing, sends its history to whoever is added, and sends nothing new to
whoever is taken out (0072). Code run for a document cannot see files fewer people read than the
document, and nothing of a space goes to the online copy.

**Who is in** is a signed policy every device holds alike, so no device takes
a removal from someone who is not an admin. Whoever makes a workspace is its first admin, and its
owner. A workspace from before 0066 keeps its people and permissions as they were, unchanging, until
its owner (or, where it has none, an admin) founds it again (Workspace settings, or `pnpm host
refound`): every device then takes that ([0078](docs/decisions/0078-restrictive-wins.md)). An invite link puts whoever joins
by it in as a member, or as an admin (`--admin`, or the checkbox in the app); it is for one person
(the first device it lets in uses it up) or for anyone who has it, and lasts a day, a week
(`--hours`) or forever (`--forever`), unless revoked (`pnpm host revoke-invite <id>`; `pnpm host
invites` lists them). Any running device of the workspace can let someone in. A link does not
carry the workspace's secret: the device that lets its holder in gives it, and removing a device
makes a new one, so the removed device can no longer find the others
([0050](docs/decisions/0050-networking-review.md)).

Joining in the app says how it is going: looking for a computer the workspace is on, being let in,
copying, opening; and, on a network that makes direct connections take a few tries, that it may take
a minute or two. The joined workspace goes on with the connection the join made. Devices tell each other whom they
are connected to: a device reached through another shows as "online, through" it, its work reaching
you that way, and while one is missing the workspace is looked up again, less and less often
([0049](docs/decisions/0049-joining-on-slow-networks.md)).

Two computers whose networks keep them from connecting directly (some office, campus and phone
networks) connect through another device of the workspace that reaches both, which passes on what
it cannot read, or through a relay: the workspace's other computers on ordinary networks offer one.
**Devices** says how each device is connected (on this network, by its address, through another
device), when an offline one was last seen, and when this computer's network is the problem
([0053](docs/decisions/0053-reaching-each-other.md)). A workspace on only two computers needs one run elsewhere: `pnpm host relay`
runs one and prints its key, to name in Settings (Other computers › Advanced) or with
`--relay`. Computers on the same local network find each other there too, with or without the
internet. All the workspaces on a computer share one connection to the DHT, which remembers the
nodes it knew for next time ([0050](docs/decisions/0050-networking-review.md)).

In the app, Workspace settings' **People and computers** lists each person, admin or member, with
their computers, online or offline ([0068](docs/decisions/0068-people-and-their-computers.md)).
**Lost or no longer used…** on a computer removes it, for good (it keeps its copy): your own,
whether or not you are an admin (its key revoked too, where your identity is on this computer), or
anyone's, for admins. Admins also have **Make admin**/**Make member**, **Take out…** (a person and
their computers) and **Invite people…**, which makes and lists invite links, to revoke; anyone has
**Rename this computer…**. From the command line, `pnpm host
devices` and `people` list them; `remove-device`, `role <person> admin|member`, `remove-person`,
`name` and `fork` manage them. Paired devices
are git remotes (`kuraa://<device key>`): `git log laptop/main` shows what a device has.

Merges are the same on every device, so work done apart comes together into one history (of two
devices, the one with the lower key makes the merges). A document open on several devices is one
live session there, led by one of them (the one with the lowest key): it alone writes the file,
commits it and brings changes from git into it; the others' copy of the file follows git, and an
edit made outside the app on one of them is committed there and reaches the session through the
leader ([0077](docs/decisions/0077-one-leader-per-room.md)). Commits are signed, for attribution only: each person has a signing key on each
computer, which their identity vouches for, so `git log --show-signature` and the app can say who
wrote what ([0035](docs/decisions/0035-identities-and-signing-keys.md)). Your identity is made for
you, from your name, the first time the app knows it; Settings › **You** says "You on this
computer". Its **Sign in from another device** copies your identity to a second computer (it replaces
the one made there) or takes one copied on another, lists your computers to revoke a lost one's key,
and shows the keys themselves. Your identity is a stable ID whose key can change: Settings shows its
**recovery key** until you say it is saved somewhere safe (then it is removed from the computer), and
with it **Account recovery** recovers your identity on any computer if its key is lost or stolen; what the old key signs from then on is no one's
([0066](docs/decisions/0066-permissions-without-a-centre.md)). From the command line, `pnpm host
person [create | export | import | recovery [saved] | recover <recovery key> | revoke <key>]`;
`pnpm host signing-key` prints this computer's signing key, to add to GitHub as a signing key.

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

In a shared workspace, outputs reach the other devices too: each device publishes its latest
outputs on a git ref of its own (`refs/kuraa/outputs/<device>`, not a branch, never merged, pushed
to backups or to the online copy), and the others fetch it. Devices connected with the document
open are also sent each run as it happens, so it shows there within moments, and a run under way
on another device shows where ("Running on ada-laptop… 3 s"). An output from
another device says where it ran ("Ada · on ada-laptop · 14:02"); the newest output of a chunk is
shown, whichever device it came from, dimmed as usual if the code has changed since. Clearing an
output clears it on every device ([decisions 0058](docs/decisions/0058-shared-outputs.md),
[0062](docs/decisions/0062-outputs-as-they-happen.md)). `KURAA_TIMINGS=1` logs how long each step takes.

Code runs through two kinds of component, which meet only through the contract in `@kuraa/run-kit`
([decision 0019](docs/decisions/0019-engine-and-environment-components.md)): **engines** are
languages (R), and **environments** are where their processes run. The host itself knows neither;
the ones that ship are R and **Podman**: a container with no network, the workspace read-only and
`.git` hidden, nothing else of the computer visible. Install Podman once: `brew install podman`,
`podman machine init`, `podman machine start`. The first run builds an R image, which takes a few
minutes. Package installs run in containers too. A workspace may name another base image only if the host allows it (`--r-image`); containers a host left behind (it crashed) are removed by the next host to start one on that computer.

**Nothing in a document runs on the computer itself** ([decision 0018](docs/decisions/0018-untrusted-users.md)):
code runs only where the environment keeps it from your files and network. No environment
that runs code on the computer itself ships. One can be written, but a host uses an environment
that is not sandboxed only when started with `--allow-unsandboxed`.

What runs and which formats are on are the host's Settings (or its flags); loading a component,
turning off the sandbox and naming the Podman program are flags only (`--component`,
`--allow-unsandboxed`, `--podman`), as they choose code that runs with your rights. The desktop app
takes `--engine` (`--engine none` for none), `--env`, `--format`, `--component`,
`--allow-unsandboxed` and `--podman` too. Settings' **Server** section shows what is on, read-only, and its **You** section lets each person turn their own
editing behaviour on and off (markdown cues and footnote ordering, chunk fences), kept in their
browser. The Server section also lists the **tools** the host knows (TeX, as TinyTeX), what each downloads, and
where installs are allowed offers **Download** and **Remove**: tools are kept once per computer in
the data folder and used only where code runs ([decision 0045](docs/decisions/0045-tools.md)). A
file whose format is off opens as a Text file
([decision 0017](docs/decisions/0017-components-panel.md)). A workspace can say what it needs in
`.kuraa/run.json`, but cannot loosen what the host allows:

```json
{
  "r": { "packages": ["dplyr", "ggplot2"], "system": ["libxml2-dev"], "renv": true },
  "access": { "workspace": "read-write" }
}
```

Write access and the network are granted only where Settings (or `--allow-write`,
`--allow-network`) allow them.

**Packages.** The environment starts with the tidyverse. Install more with `install.packages()` in
a chunk, or **Packages…** in the menu (CRAN names, `name@version`, `bioc::name`, or
`owner/repo` from GitHub). Installs run apart from your data, with the network; your code keeps
running without it. Each workspace records its packages in `.kuraa/r-packages.json` (committed),
so collaborators and other machines get the same ones; each package version is stored once per
computer. Installs are allowed unless Settings (or `--no-allow-installs`) turn them off
([decision 0014](docs/decisions/0014-packages.md)). A run component is a module exporting `defineRunComponent({ name, engines,
environments, tools })` from `@kuraa/run-kit`: examples of [an engine](packages/host/test/fixtures/echo-engine.mjs),
[environments](packages/host/test/fixtures/environments.mjs) and [a tool](packages/host/test/fixtures/tools.mjs),
loaded with `--component <path>`.

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

Like the desktop app, `pnpm dev` serves a folder of workspaces you can add to from the app, with
Settings and **Open a folder…** in the page; its settings are kept in
`.dev-workspaces/settings.json` (beside `--workspaces`, if given). The first time, it starts with a
Scratch workspace.

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

**Settings…** is the client's dialog, as in a browser ([above](#settings)). What stays the
desktop app's own: its native menus, the spelling suggestions in its right-click menu, the git it
ships, the launcher and joining another server, native save dialogs (a browser downloads instead), and
leaving out the server address and access code, which it manages itself.

## Package the desktop app

The app packages as one file to install or run, needing nothing else, not even git:

```sh
pnpm --filter @kuraa/desktop dist:mac     # dist/kuraa-<version>-mac-{arm64,x64}.{dmg,zip}
pnpm --filter @kuraa/desktop dist:win     # dist/kuraa-<version>-windows-x64-setup.exe
pnpm --filter @kuraa/desktop dist:linux   # dist/kuraa-<version>-linux-{x86_64,arm64}.AppImage, .deb and .rpm (the .rpm needs rpmbuild)
```

It ships its own git: GitHub Desktop's builds of it ([dugite-native](https://github.com/desktop/dugite-native)),
fetched by `apps/desktop/scripts/fetch-git.mjs` and checked against pinned checksums, less Git
Credential Manager and git-lfs. Every device then runs the same git. Its system-wide settings are
left out, and files are always written as git stores them (no `core.autocrlf`); the person's own
`~/.gitconfig` still applies. Git is GPLv2: distributing the app means offering git's source too (the
script names the release). `pnpm desktop` uses this git as well once it has been fetched
(`pnpm --filter @kuraa/desktop fetch-git`), and the computer's otherwise.

Running R still needs Podman installed; everything else works without it, and Settings says
whether it is ready.

**macOS.** Build on a Mac. electron-builder signs with the *Developer ID Application* certificate in
the keychain (make one at developer.apple.com → Certificates; *Apple Development* and *Apple
Distribution* certificates sign only for this Mac and the App Store). It notarizes when Apple
credentials are in the environment, most simply a keychain profile:

```sh
xcrun notarytool store-credentials kuraa --apple-id <apple id> --team-id <team id>
APPLE_KEYCHAIN_PROFILE=kuraa pnpm --filter @kuraa/desktop dist:mac
```

**Windows.** An installer, x64 (it also runs on Arm under emulation), for the person installing it
alone (no administrator), unsigned: Windows SmartScreen warns before its first run. It builds on a
Mac as well as on Windows.

**Linux.** x64 and arm64, three ways, each updating itself:

- **`.deb`** (Debian, Ubuntu, Mint, Pop!_OS, …) and **`.rpm`** (Fedora, RHEL and its rebuilds,
  openSUSE, …): installed with the system's own tool (`sudo apt install ./kuraa-….deb`,
  `sudo dnf install ./kuraa-….rpm`), into `/opt/kuraa`, with kuraa in the app menu and Chromium's
  sandbox set up for the system (an AppArmor profile on Ubuntu 24 and later). An update asks for an
  administrator's password when you choose **Restart now**, not when kuraa quits.
- **AppImage**, for anything else: `chmod +x` it and run it. Some distributions need FUSE
  (`libfuse2`) for AppImages, and Ubuntu 24 and later may need it run with `--no-sandbox`; the
  packages need neither.

It needs glibc 2.33 or later (Ubuntu 22.04, Debian 12, Fedora 34, RHEL 9 and later), as its
networking library does; not musl (Alpine).

### Updates

The app updates itself ([decision 0051](docs/decisions/0051-the-app-updates-itself.md)): it looks for
a newer release a minute after starting and every four hours (and from **Check for Updates…** in
its menu, which stays open and shows the download's progress, then offers **Restart Now**), downloads it in the background, only the parts that changed where it can (a code change
is a few megabytes of a 130 MB app), and puts it in place when it quits; the page offers **Restart
now**. It also looks at once when a device of a workspace runs a newer kuraa, as the two do not
sync until this one is updated (**Devices** says "newer kuraa" or "older kuraa").

Where it looks is set when it is built, with `KURAA_UPDATES`: `github:<owner>/<repo>` for GitHub
Releases, or an https URL of a folder holding what `dist/` has. Without it, the app built does not
update itself.

### Releasing

```sh
pnpm release 0.2.0              # or 0.3.0-beta.1 for a pre-release; --dry-run says what it would do
```

From `main`, with nothing uncommitted, it sets the app's version, commits, tags `v0.2.0`, and
pushes both. It says so when the protocol devices speak changed since the last release: then the
release notes should say that every device must be updated to go on syncing. The push runs the
**Check** workflow (lint, typecheck and the unit tests) once, on `main`; once it passes on a commit
with a version tag, the **Release** workflow (`.github/workflows/release.yml`) builds it. If Check
fails (a flaky test, say), re-running it starts the release once it passes.

1. **tag**: the commit's version tag, and that it is the app's version.
2. **draft**: a draft GitHub release, with notes from the commits since the last (a pre-release for
   a tag with a `-`: installed apps never update to one).
3. **build**: builds for macOS (Apple silicon and Intel, signed and notarized), Windows (signed) and
   Linux, and adds each to the draft; **server**: the server on its own
   ([above](#a-server-that-updates-itself)), signed with the release key.
4. **publish**: once everything is in it, the release is published, and installed apps and servers
   update to it within hours. If a build fails, the release stays a draft: fix, and release the next version
   (or publish the draft by hand).

Every push to `main`, and every pull request, runs the same checks (`.github/workflows/check.yml`).

**Setting up the repository, once:**

- **Settings › Environments › New environment** `release`, its deployment tags limited to `v*`
  (add yourself as a required reviewer to approve each release before it is built). Its secrets
  and variables:

  | Secret | What |
  |---|---|
  | `MAC_CERTIFICATE_P12` | Your *Developer ID Application* certificate and key, exported from Keychain Access as a `.p12`, base64: `base64 -i cert.p12 \| pbcopy` |
  | `MAC_CERTIFICATE_PASSWORD` | The password it was exported with |
  | `APPLE_API_KEY_P8` | An App Store Connect API key (Users and Access › Integrations › Team Keys, *Developer* access): the `.p8` file's text |
  | `APPLE_API_KEY_ID`, `APPLE_API_ISSUER` | That key's id, and the issuer id shown above the list |
  | `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET` | An Entra app registration with the *Trusted Signing Certificate Profile Signer* role on the signing account |
  | `SERVER_SIGNING_KEY` | The release key that signs the server's archive, from `node scripts/server-signing-key.mjs` (keep a copy: servers built with it take only updates signed with it) |

  | Variable | What |
  |---|---|
  | `AZURE_SIGNING_ENDPOINT` | The Trusted Signing account's endpoint, for its region (`https://eus.codesigning.azure.net`, say) |
  | `AZURE_SIGNING_ACCOUNT`, `AZURE_SIGNING_PROFILE` | The account's name, and its public-trust certificate profile's |
  | `WIN_PUBLISHER_NAME` | The publisher exactly as the certificate names it (its CN): the installed app takes only updates signed by it |

  Without the Azure ones, the Windows build is made unsigned.
- **Settings › Rules › Rulesets**: a tag ruleset for `v*` that only you may create, update or
  delete, so no one else can start a release.
- **Windows signing**: an Azure subscription, a *Trusted Signing* account (Basic plan) with a
  public-trust certificate profile, after Microsoft has verified who you are (an organisation, or
  an individual where Microsoft offers that). electron-builder signs with it from the Windows
  runner. Until then, Windows SmartScreen warns before the app's first run, and its updates are
  checked only against the checksums the release lists.

On macOS, a release must be signed with the same Developer ID as the app installed, or it is not
put in place; the first update after installing from the DMG is downloaded whole. To release from
a computer instead, set `KURAA_UPDATES` and `GH_TOKEN`, and run `pnpm --filter @kuraa/desktop
release:mac` (or `:win`, `:linux`) after the tag is pushed and its draft release made.

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
| — | `packages/host/test/outputs.test.ts`, `peers.test.ts` (run outputs between devices): outputs published on a signed ref of each device's own, taken by the others (passed on only if signed by the device they came from, the newest kept), shown with where they ran, and cleared everywhere from any device; sent as they happen to devices with the document open, before any publish, believed only from the device that ran them, kept until its commit holds them, and cleared there at once; `link.test.ts`: never sent to a device whose kuraa does not open their channel |
| — | `packages/host/test/sessions.test.ts`: one session per room and one leader (0077): a device leaving and coming back (its room warm, or closed) on either key, a commit or an outside edit arriving at a device that does not lead, the leader leaving while others type, a network split and its healing, the last device leaving; and three devices at random (`KURAA_SESSION_SEED`), each ending in one session, every room and file the same, every edit once; `seed.test.ts`: two sessions started apart would show the text twice |
| M8 | `tests/e2e/desktop.spec.ts`: the Electron app opens a folder, edits and commits while other programs edit the folder and `git pull` into it; survives a reload; joins a shared host; the launcher initialises a plain folder and joins a host |
| — | `tests/e2e/dev.spec.ts`: `pnpm dev` serves a working client with nothing to configure, and Ctrl+C commits pending edits |
| — | `packages/host/test/settings.test.ts`, `tests/e2e/preferences.spec.ts`: one settings model in the hub (read leniently, saved strictly, flags winning), applied by reopening every workspace at the same address; the owner's features only on loopback; Settings and Open a folder… in the browser, through the folder picker |

## Layout

| Package | Role |
| --- | --- |
| `packages/kernel` | Document type registry, hook bus and merging (lines, words, blocks). No DOM, no Node, no formats |
| `packages/run-kit` | The contract between run components: engines (languages), environments (where processes run), tools (toolchains downloaded on request) and syncs (the online copy), the policy |
| `packages/engine-r` | Engine component: R, running `r` chunks through `evaluate`, and rendering R Markdown and Markdown (rmarkdown, pandoc, Typst) |
| `packages/env-podman` | Environment component: a locked-down Podman container |
| `packages/tool-tinytex` | Tool component: TinyTeX, for PDFs made with LaTeX, pinned per architecture; reads LaTeX logs for missing packages |
| `packages/sync-git` | Sync component: the online copy, a git server each save is pushed to and fetched and merged from every few minutes |
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
- Edits made while disconnected are kept and sent on reconnect; if the room's session ended
  meanwhile, they are carried into the new one, but only while the page stays open: edits not sent
  before the page was closed are not carried across a reload.
- Edits not yet committed when the network parts are in both sides' rooms; where both sides then
  edit the same paragraph beside them, the merge keeps a conflict block
  ([0077](docs/decisions/0077-one-leader-per-room.md)). A device that does not lead a room renders
  the file as last committed.
- The corpus does not yet include real working files from the project's first users.
- Symbolic links in a workspace are listed but never opened or followed, and files not saved as
  UTF-8 (a Latin-1 `.bib`) are not opened for editing ([decision 0037](docs/decisions/0037-host-safety.md)).
- While git is in the middle of an operation in the folder (a rebase, a merge with conflicts), or no
  branch is checked out, nothing is saved: edits wait in the app until it is done. A branch switched
  outside the app moves open files to that branch's version, saving their edits on the old branch.
