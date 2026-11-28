# 0134 · A late answer does not move the page

> Follows [0122](0122-every-browser-engine.md) (⌘↑, Ctrl+Home, to the start of the text) and
> [0097](0097-starting-to-write.md) (nothing open is a blank document).

**Status: built.** The Browsers workflow (0122) failed for v0.13.0 and v0.13.1 in all three
engines, on Linux only: the title not focused in a blank document, a document left coming back,
words typed into the start of the title, and words typed just after a new document's title lost.
The owner asked why, then to fix it. Three things were wrong in the app, which anyone on a slow host,
or with Podman slow to answer, could meet; and the tests pressed a Mac's key on Linux.

## What changed

- **A late tree refresh opens nothing.** `refreshTree(select)` asks the host for the workspace and
  the files, then opened `select`, however long that took. A file action, or a move, that began
  while one document was open would, answered late, take the person back to it from the one they
  had gone to meanwhile: from a new blank document to the one just written in, its editor closed
  before its title could take the cursor. Now it opens `select` only if the document open when it
  was asked still is, and file actions (`FileActions.vue`, `changed`) only if the one open when
  they began still is, as `followGone` already did.
- **What the host runs is told to the open document, not opened again for.** The workspace's
  answer says what runs code and where (`run`), with whether that is available now, which the host
  learns by asking Podman: slow at times, so it could come after a document opened. Any change to
  it closed the editor and opened it again, losing what was typed meanwhile (the Enter and *Body.*
  after a new document's title). Now a document that may have code to run always has its
  `ChunkRunner`, running nothing until it is told otherwise (`setInfo`), and shows its chunks as
  they then stand; its session is in the document's menu, and its outputs loaded, once code runs.
- **A paragraph up stops at the start of the text.** Ctrl+↑ off the Mac (⌥↑ on it), from the first
  block, was left to the browser, which put the caret in the title above, where ProseMirror does not
  follow it: what was typed went to the start of the title. Now it goes to the start of the text
  (Shift extending the selection), and from there, as ↑ does, into the title (`titlePlugin`).

The tests had used `ControlOrMeta+ArrowUp` for the start of the text, which is ⌘↑ only on a Mac;
they use `KEYS.docStart` now, and `KEYS.paragraphUp` is tested in `header.spec.ts`.

## How it was found

Only in CI at first: the same tests pass on a Mac. Run in Playwright's Linux image under Podman
(`mcr.microsoft.com/playwright`, the version the repository uses), the header tests failed every
time and the blank document's now and then; logging where focus went, and each `select`, showed the
late refresh. The lost typing showed itself on a Mac too, the engines run one after another sharing
the host (as `pnpm test:e2e --project web webkit firefox` does), the workspace's answer then
coming after the new document opened.
