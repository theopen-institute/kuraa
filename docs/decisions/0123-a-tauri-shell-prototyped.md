# 0123 · A Tauri shell, prototyped

**Status: a prototype, on macOS (Apple silicon).** `apps/tauri` is the desktop app as a Tauri 2
shell: the web client in the system's webview (WKWebView), the host as released run by a Node the
app carries. It is not released and changes nothing in the Electron app, which stays the desktop app
until the shell does everything it does.

The owner, weighing the Electron app's size (about 100 MB of Chromium in every download) against a
shell on the system's webview, and given that the web client must work in every browser anyway
([0122](0122-every-browser-engine.md)): *"let's focus on shifting over to Tauri, since that seems like
the correct approach"*; then, of the steps proposed, *"Yes, move forward with steps 1 and 2"* (the
browser tests in CI, 0122; and this prototype, measured against Electron), and: *"Spell check should
use native tools wherever possible, always. I don't want electron's anyway."*

## What it is

- **The shell** (`src-tauri/src/main.rs`, about 150 lines of Rust): a window on a loading page; the
  host started as `node kuraa-host.mjs --port 0 --token <random> --settings … --workspaces …`, its
  data in the app's own folder (`~/Library/Application Support/org.kuraa.tauri-prototype`), never the
  Electron app's; when the host prints its address, the window goes there, with the access code. The
  window shows only the host's pages and the loading page; other web addresses open in the default
  browser. Quitting sends the host SIGTERM, which writes and commits pending edits, and waits up to
  15 seconds.
- **No bridge yet.** The page is the web client as a browser has it (0047): Preferences, Open a
  folder… (the page's folder picker), identity and the personal backup work, as on any loopback host.
  The Electron app's ShellBridge (0009: its menus, folder dialogs, Restart to update, the context
  menu) is not there.
- **What it carries**, gathered by `scripts/stage.mjs`: the host as released (`scripts/build-server.mjs`:
  `kuraa-host.mjs`, the web client, pandoc's and Typst's WebAssembly, the native addons, this
  platform's only, without the source map), the git the Electron app ships, and Node 24.20.0
  (`scripts/fetch-node.mjs`, nodejs.org's build, checked against its SHA-256, only the `node`
  program), as Tauri's `externalBin` beside the shell.
- **The host's git, by environment** (`KURAA_GIT_DIR`, read by `@kuraa/host`'s cli.ts): the git a
  shell ships, run instead of the computer's. `useGitFolder` (git.ts) is what the Electron app did
  itself; both now call it.

`pnpm --filter @kuraa/tauri build` builds the host, fetches git and Node, stages them, builds the app
and makes its downloads (`scripts/package-mac.mjs`). Rust is needed (`rustup`).

## What was measured

Against the Electron app's v0.12.0 release, both on an M-series Mac, each with an empty workspaces
folder of its own, showing the first-run page:

| | Electron 0.12.0 | Tauri prototype |
| --- | --- | --- |
| zip (what updates download) | 158.9 MB | **87.2 MB** |
| DMG | 164.7 MB | **97.8 MB** |
| Memory, all its processes (`footprint`) | ≈169 MB (main and host 87, GPU 36, renderer 38, network 8) | ≈161 MB (shell 26, host 42, WebKit content 70, GPU 15, network 8) |
| Launch to host ready, warm | ≈400 ms | ≈360 ms |

The download is 45% smaller; memory and starting are about the same. In the Tauri zip, compressed:
Node 37.4 MB, pandoc.wasm 16.2, git 13.7, typst.ts 10.4, Typst's fonts 6.1, the shell 1.3, the host's
code 0.7, the web client 0.6. Node is now the largest part, as Chromium was.

## Found on the way

- **App Transport Security** stops WKWebView loading the host's page (plain HTTP on loopback)
  without a word: the window stayed on its loading page. `src-tauri/Info.plist` allows local
  networking (`NSAllowsLocalNetworking`) and nothing else without TLS.
- **Tauri's bundler copies a symbolic link as the file it points at.** Git's 148 links in
  `libexec/git-core`, each to the 3.5 MB git, became 148 copies: a 749 MB app. `package-mac.mjs` makes
  them again in the app after bundling; a release would then sign and notarize it, and make its
  downloads, itself.
- **The page needs nothing of Chromium's.** It loaded, connected and showed its first-run page in
  WKWebView as it does in Safari (0122's WebKit tests).

## Not yet

In the order proposed:

- **The bridge** (0009's ShellBridge, through Tauri's commands, offered only to the host's pages):
  the native folder dialog, menus (Open a folder…, Preferences, Help, Check for updates), Restart to
  update.
- **Spell check, the system's** (the owner's direction): misspelled words left to the webview's own
  menu and the system's dictionary, not suggestions rebuilt in the app's context menu.
- **Updates and moving over**: Tauri's updater, signed; one last Electron release that hands
  installed apps to the Tauri one, with the data in `…/kuraa` (preferences, workspaces, identity) carried
  over.
- **Signing and notarizing**, the Node beside the shell included.
- **Desktop tests**: Playwright drives Electron, not Tauri, and Tauri's WebDriver has no macOS driver;
  WebdriverIO's Tauri service embeds one.
- **Windows (WebView2) and Linux (WebKitGTK)**, and an x64 Mac.
- A smaller Node (a build with less of ICU, say), now the largest part.
