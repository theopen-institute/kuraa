# 0127 · A Tauri shell

**Status: built; not yet released.** `apps/tauri` is the desktop app as a Tauri 2 shell: the web client
in the system's webview (WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux), its hub in a Node
the app carries. It does what the Electron app (`apps/desktop`) does. The Electron app stays the one
released until a release hands installed copies over (below).

The owner, weighing the Electron app's size (about 100 MB of Chromium in every download) against a shell
on the system's webview, and given that the web client must work in every browser anyway
([0122](0122-every-browser-engine.md)): *"let's focus on shifting over to Tauri, since that seems like the
correct approach"*; of the steps proposed, *"Yes, move forward with steps 1 and 2"* (the browser tests in
CI; a prototype, measured against Electron); *"Spell check should use native tools wherever possible,
always. I don't want electron's anyway."*; and, the prototype measured: *"Keep developing the Tauri app. I
want full functionality before I merge to main."*

## What it is

- **The hub, in Node** (`src/host.ts`, bundled as `kuraa-desktop.mjs`): what the Electron app's main
  process did with the host, without its windows: the hub started on loopback with the Electron app's
  flags and settings, its edits written and committed when it stops, its log kept in a file
  (0053's rules), the version said to other devices (0099). The shell asks it things over its stdin, one
  JSON line each (`start`, `stop`, `inspect`, `add`, `identity`, `join`, `log`, `quit`); it answers on
  stdout. A pipe, not a signal, so quitting works the same on Windows, and the hub stops by itself if the
  shell goes.
- **Its data is the Electron app's**: preferences, the list of workspaces and the log where the
  Electron app keeps them (`~/Library/Application Support/kuraa`, `%APPDATA%\kuraa`, `~/.config/kuraa`),
  and the same identifier (`org.kuraa.desktop`) and program name (`Kuraa`). Moving from one app to the
  other moves nothing.
- **The shell** (`src-tauri/`, Rust): the window, the Electron app's menus (Settings on ⌥⌘,, Open Folder
  on ⌘O, Reload, the developer tools on ⌥⌘J, zoom, Markdown and Shortcuts on ⌘/, Show Log File, Check for
  Updates…), the system's folder and question dialogs, the launcher, joining a host, saving downloads,
  updating, quitting. The app's own pages (starting, launcher, closing, updates) are the Electron
  app's `static/`.
- **The page and the shell.** The page is the web client served by the hub, at the hub's own address,
  as a browser has it (0047). The ShellBridge (0009) is `window.kuraa` again, put in each page before its
  own scripts (`src/bridge.ts`). Tauri has no synchronous calls, so the connection the client reads at
  start (`config()`) comes in the page's address (`#kuraa-config=…`), taken out at once and kept for the
  tab, so a reload keeps it. What the shell tells the page (the menu's Settings, an update ready) waits
  until the page has loaded and someone listens.
- **Who may ask what.** Each command answers only the pages it is for (as the Electron app's bridge
  answered only its own pages), and Tauri's capabilities say the same: the app's own pages, this app's
  hub's page (at its port), and a joined host's page, which is not this app's code and may only go back
  (`leave`, `home`) and ask the spell checker. The window shows only those pages (and frames' blank
  pages, and files the page made); other web addresses open in the default browser, and it opens no
  other windows.
- **Joining a shared host** shows the host's own pages, as a browser would: the Electron app showed its
  own copy of the client against the host, but a page from the app's own origin would be another origin
  to the host, which lets no other origin in (origins.ts). A host that serves no pages cannot be joined
  from the app; the app says so. App Transport Security allows such a host over plain HTTP, as the
  Electron app did.
- **Spell checking is the system's** (the owner's direction): the webview checks as you type with the
  system's dictionary, in its own right-click menu (on a Mac, set on unless the person turned it off).
  The editor's own menus (a table's) ask the system's spell checker through the shell (NSSpellChecker on
  a Mac); so `Spelling.suggest` (editor-kit) may answer later, and the table's menu opens once it has.
  Elsewhere none yet: the webview's own checking goes on (WebView2's, WebKitGTK's), and the editor's menus
  offer no suggestions.
- **Saving.** A rendered file handed over by the page (`<a download>`) is saved where the person says,
  with the system's save dialog, as the Electron app (Chromium) asked. WKWebView would otherwise drop it.
- **Quitting says so** ([0131](0131-closing-says-so.md)), as the Electron app does: Quit, closing the
  window and Restart now show the Electron app's closing page while the hub stops (the window stays
  until the app has quit); the hub tells the shell once every workspace is saved (`saved`), and the page
  then offers Quit Now, which stops waiting for what is still being sent.
- **Updating itself** with Tauri's updater, as 0051 had it: looked for a minute after starting, every
  four hours, when the menu asks, and when a device runs a newer kuraa (the hub says so); downloaded in
  the background, checked against the key built in, put in place when the app quits or at once
  (Restart now). Check for Updates… shows how it goes, in the Electron app's window (its page and
  `update-view.ts`, drawn from the shell's status). Without `KURAA_UPDATES` at build, it does not look.
- **What it carries** (`scripts/stage.mjs`): the hub, the web client, pandoc's and Typst's WebAssembly
  with Typst's fonts, this platform's native addons, the git the Electron app ships, and Node 24.20.0
  (`scripts/fetch-node.mjs`: nodejs.org's builds, checked against nodejs.org's checksums, for macOS,
  Windows and Linux on x64 and arm64).
- **Git's links become scripts.** Tauri's bundler copies a symbolic link as the file it points at, on
  every platform: git's 148 links (each to the 3.5 MB git) made a 749 MB app. Each is staged as a
  two-line script that runs what it pointed at (`exec "$(dirname "$0")/git" fetch "$@"`); git runs its
  own commands as `git <command>` anyway.
- **Signing, on a Mac** (`scripts/package-mac.mjs`): inside out, with the hardened runtime: every
  program and library in its resources (git's, the native addons), Node (allowed to compile as it runs:
  `entitlements.mac.plist`), then the app; notarized and stapled when Apple's credentials are there.
  Without a Developer ID, ad hoc and without the hardened runtime, which would stop Node loading addons
  of no team.

## The downloads

`pnpm --filter @kuraa/tauri build` makes, on a Mac, a DMG, the zip the Electron app's updater
downloads with its `latest-mac.yml`, and the `.app.tar.gz` Tauri's updater downloads with its signature
and this platform's part of `latest.json` (`scripts/updater-manifest.mjs` merges the platforms' parts);
on Windows an NSIS installer for the person alone, on Linux a .deb, an .rpm and an AppImage (Tauri makes
their update files itself).

Measured against the Electron app's 0.12.0, on an M-series Mac, idle on the first-run page: the zip
87 MB against 159, the DMG 98 against 165; memory (`footprint`, every process) about 161 MB against 169;
launch to the hub ready about 360 ms against 400. Node is now the largest part (37 MB of the zip), as
Chromium was.

## Tested

`tests/e2e/tauri.spec.ts` (the `tauri` project), the Electron app's desktop tests for this app, on
macOS, Windows and Linux (on a Mac the app in its bundle; elsewhere the program as built, with what it
carries beside it, as `--test` leaves it). Playwright drives Electron, not the system's webview, and Tauri's WebDriver has no macOS driver, so
a build with the `test-control` feature (`build:test`, never released; `src/testing.rs`) takes a test's
requests on loopback, with a code: work something out in a page, choose from the menu, answer the
dialogs ahead of time, read the title, quit (`tests/e2e/tauri-app.ts`). They open a folder, edit, reload
and quit with what is pending committed; join a shared host; open folders with the dialog from the
page, the menu and the launcher (and decline one); render with the pandoc and Typst it carries and save
the file where the dialog says; take the flags; keep the window on its own pages; show the updates
window and a ready update; apply and keep preferences; run git-remote-kuraa with the Node it carries;
make you from your name; ask the system's spell checker; open the Help sheet.

Updating was tried end to end by hand, with a throwaway key and a release served on loopback
(`KURAA_UPDATES=http://127.0.0.1:<port>` is allowed for that): found, downloaded with its progress shown,
checked, said ready in the window and the page, put in place by Restart now, and started again.

The Tauri workflow builds it and runs these tests on macOS, Windows and Linux (on a display of its own,
Xvfb), then packages it on Windows and Linux, on every push to main and every pull request; no release
waits for it. `apps/tauri/scripts/test-linux.mjs` runs the Linux tests from any computer with Podman, in a
container (`apps/tauri/linux/Containerfile`) with WebKitGTK and a display, the checkout copied in as it is.
The spell checker's suggestions are a Mac's only, so elsewhere the tests expect none. Run so, the Linux
tests (WebKitGTK, arm64) pass as the Mac's do.

Linux found a bug in the host, older than this app (the Electron app on Linux, and servers, had it too):
Node's recursive file watching there watches each file itself, and once the host saves a file (a
temporary file renamed over it) it goes on watching the old one, so edits other programs made to that
file afterwards were never seen. `packages/host/src/watch.ts` watches each folder instead on Linux
(which tells of any change to a name in it), following folders as they come and go, and not looking
into git's own folders inside `.git`; macOS and Windows keep the system's recursive watching.

Windows found another, as old: a folder named in its short form (`C:\Users\RUNNER~1\…`, as a temporary
folder is, opened as given) was watched, its changes came under the long name, and libuv stopped the
whole hub (an assertion in `fs-event.c`). The watcher takes the folder's full name first. (WebView2 also
says a page in a hidden window is visible, so the tests ask the shell whether its window is shown.)

## Not yet

- **Handing installed copies over.** One last Electron release whose update is this app: its zip and
  `latest-mac.yml` are made for that, and the same identifier, program name and data folder make it a
  drop-in for Squirrel.Mac once signed with the same Developer ID. On Windows, the Electron app's NSIS
  installer and Tauri's install in different places (`%LOCALAPPDATA%\Programs\kuraa`, and Tauri's): the
  handover there needs an installer that removes the old copy. On Linux an AppImage or a package of the
  same name replaces the old. Untried until a signed release.
- **The release workflow** (release.yml) still builds the Electron app; building, signing and
  publishing this one there (with `latest.json` merged from every platform) is the switch.
- **Windows** is built and tested by CI only (all the tests pass there, and its installer is made),
  never yet run by a person. Windows signing is given to Tauri as a command (`KURAA_WINDOWS_SIGN_COMMAND`).
- **Spell suggestions on Windows and Linux** in the editor's own menus (the system's spell checker
  there: ISpellChecker, Enchant).
- **An icon** (as the Electron app, it has none of its own; the placeholders are the system's).
- A smaller Node (a build with less of ICU, say), now the largest part.
