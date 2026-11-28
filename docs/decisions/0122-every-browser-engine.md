# 0122 · The web client in every browser engine

**Status: built.** The browser tests run in Chromium, WebKit and Firefox. Two bugs found that way,
which people using Safari or Firefox would have met, are fixed: what is typed with a dialog open
could go into the document behind (WebKit), and closing a dialog put the caret at the top of the
document (Firefox), as did ⌘↑.

The owner, weighing a Tauri shell against Electron (a system webview: WebKit on macOS and Linux,
WebView2 on Windows): *"this will also be a web app, so we need a functioning page across a diversity
of browsers already"*, then: *"let's focus on shifting over to Tauri, since that seems like the correct
approach. Create tests for safari and firefox. We need to support diverse browsers anyway"*, and to
fix what failed.

## What is decided

**Three projects, one list of tests** (`playwright.config.ts`): `web` (Chromium: Chrome, Edge,
Windows' WebView2), `webkit` (Safari, and the webview a Tauri app gets on macOS and Linux; Playwright's
WebKit on Linux is close to WebKitGTK) and `firefox`, each running the same web client tests (`WEB`).
`pnpm test:e2e` runs all three, and the desktop and dev tests; `--project web` (or `webkit`,
`firefox`) runs one. Each takes its own browser, installed once (`npx playwright install chromium
webkit firefox`). Run beside another, a run takes its own `--output` folder too: two runs sharing
`test-results/` overwrite each other's traces.

**Tests use what each platform uses** (`tests/e2e/env.ts`, `KEYS`): on a Mac, ⌘← and ⌘→ for the start
and end of a line and ⌘↑ for the top, not Home and End, which scroll there (Safari and Firefox do as
the Mac does; Chromium had let the tests by). In code (CodeMirror), Home and End stay: it binds them
itself. A paste is made with the data set on the event (`Object.defineProperty(event, 'clipboardData',
…)`), since Firefox empties what a page gives the `ClipboardEvent` it makes. A test waits for what it
measures (the editor's scroll area, in `click.spec.ts`), and a test of a dialog's heading names which
(the dialog's own, level 2).

**A dialog clears the selection behind it** (`trapFocus`, `focus.ts`): WebKit sends typing to the
selection, not to what has focus, so with Settings open and its tab button focused, what was typed
went into the paragraph behind. Taking focus, a dialog removes any selection outside it.

**Focus goes back with its caret** (`focusPlace`, `focusBack`): a dialog, or a panel beside the
document (`useReturnFocus`), keeps where the caret was in the text being edited and puts it back with
focus. Focusing an editable element alone puts the caret at its start in Firefox, which ProseMirror
took as the person's move: an image added from its dialog went in, and what was typed next went into
the first heading.

**⌘↑ (Ctrl+Home) goes to the start of the text** (`titlePlugin`, `header.ts`), with Shift extending
the selection there. Left to the browser, Firefox put the caret in the title above the text, where
ProseMirror does not follow it, so what was typed went partly into the title. ↑ at the start of the
text still goes up into the title.

## Found on the way

- `polish.spec.ts` expected a folder's menu without **Delete…**, which a folder's menu has had since
  it was added (1625de0); the test now expects it.
- A test that stops part-way can leave a workspace feature on in the shared test workspace (coding by
  `#`, the example feature), and the tests after it then fail too (menus with *Say hello (example)*,
  `#` opening the code box). Most of the first runs' failures in WebKit and Firefox were that, behind
  one test stopped by `End`.
- Ten specs opened browser contexts of their own and never closed them: six against the shared host
  (collab, find, notes, run, source, versions), four against hosts of their own, which they stopped
  (conflicts, devices, rules, spaces), leaving pages trying to reach them again for the rest of the
  run. Each now closes its contexts after each test (`ownContext`). With them all left open, late in
  a WebKit run pages stopped answering (a click waiting until the test's time was up, in tests that
  passed on their own), and its run took 12 to 15 minutes; with them closed, nothing stops, and it
  takes about 5, as Chromium's and Firefox's do.

**In CI** (`.github/workflows/browsers.yml`): on every push to main and every pull request, a job
for each engine, on Linux, each installing its browser and keeping a failure's trace for a week. A
workflow of its own, not part of Check: a release waits for Check alone, so a browser test failing
does not hold one up, until they have shown they can be relied on. The desktop and dev tests are
not run there. One test (Chromium's accessibility tree, `polish.spec.ts`) reads what only Chromium
opens to the tests, so that part of it runs in Chromium alone.

## Not yet

- The browser tests do not yet hold up a release.
- Spell-checking's own dictionary (*Add to dictionary*) is Chromium's (the desktop app's). The owner:
  *"Spell check should use native tools wherever possible, always. I don't want electron's anyway."*
  A webview has the system's; the Tauri shell is to use it.
- *Nothing open is a blank document* (`newfile.spec.ts`) fails now and then in a full Chromium run,
  never on its own: after a reload, nothing has focus (the page itself), with the title there and no
  dialog open. The editor's "start in the title" (`focusTitle`, `Editor.vue`) gives up for good if
  the editable title is not there when it looks (it then focuses the view, and says it is done), so
  a page slow to load can miss it. Not fixed here.
