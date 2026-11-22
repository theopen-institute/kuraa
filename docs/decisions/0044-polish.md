# 0044 · Polish: the app teaches itself, says what is happening in plain words, and works from the keyboard

A review of the app as a first-time researcher meets it found it quiet to the point of silent: no
way to learn the markdown cues but the README, feedback that was a small footer label or nothing,
git's words and command-line flags in the main interface, dialogs that let focus wander behind
them, and a file list only a mouse could use. This is the pass that fixes those.

## Help and shortcuts

- **An empty document says how to start**: "Type # for a heading, - for a list, @ to cite… Press
  ⌘/ for all shortcuts" (`placeholder.ts`). It is a decoration only this view draws, on the one
  empty paragraph, or a line below the header when there is nothing else (clicking it makes the
  paragraph). Nothing is added to the document until someone types.
- **Markdown and shortcuts** (`HelpSheet.vue`), from ⌘/ (Ctrl+/), the menu, the empty state and the
  desktop app's **Help** menu. It lists the typing cues of 0008 and 0040, each format's keys, and
  the client's own (⌘F, ⌘G, ⌥⌘O, ⇧⌘F, ⇧⌘R, ⌘,, ⌘/, ⌘Z, ⇧⌘Z, the run keys ⇧⌘↩ and ⌘↩, and the file
  list's keys), shown for the system (⇧⌘F on a Mac, Ctrl+Shift+F elsewhere: `keyLabel` in `keys.ts`).
- **It cannot drift.** `FormatEditor` gained `help` (`HelpItem`: a group, what to type or the keys in
  ProseMirror's spelling, what it does). The Pandoc editor's key bindings are built by one function,
  `pandocKeys`, and a test checks that every key with a modifier it binds is in `PANDOC_HELP` and that
  the help names no key that is not bound; R Markdown adds its chunk cue and ⌥⌘I through
  `PandocEditorExtension.help`. The client's keys are one table, `APP_KEYS`, which its handlers match
  with (`keyMatches`), the chunk editor binds, and the sheet lists. The typing cues are data beside
  the input rules; they are not derived from the regular expressions.
- **First run.** The first dialog is a short welcome, "Welcome to kuraa · What should we call you?",
  with name, email and colour, and the server's address and access code only if nothing brought them
  (the desktop app and `pnpm dev` supply them, as does a link with `?token=`). **Start writing** saves.
- **Nothing open** shows "Nothing open yet" with **New document…** and the shortcuts, instead of a
  line of grey text.

## Feedback

- **Connection.** While the document's connection is lost (after a second, so a blink shows
  nothing), a banner says "You are offline. Your changes are kept and will be sent when the
  connection returns", with how many changes are not yet sent and **Try again now**
  (`RoomConnection.reconnect`, which starts Hocuspocus's attempts again at once).
- **Access code turned down.** Where the shell runs the server (the desktop app, `pnpm dev`), this is
  never the person's doing: the banner offers **Reconnect**, which loads the workspaces again with the
  shell's current address and code (`Shell.reconnect`; the desktop app's `home`, else a reload).
  Elsewhere it offers **Change the access code…**, which opens the menu at its Server panel.
- **Saving** (0037): paused or failing is a banner that stays while it lasts, in the host's own plain
  sentence ("Saving is paused while git is in the middle of an operation…"; failing adds that kuraa
  keeps trying, which it does, with growing waits). When it is over, a note says so. Restoring a past
  version still waits while saving is paused.
- **Sync** says how it went: "Up to date" or "Brought in 3 changes" (the host now returns `brought`,
  commits new on the branch not counting merges, and `conflicts`, the conflicts their merges kept; the
  rest of the response is as it was). With no online copy and no other device, the menu does not offer
  Sync and says why ("Nothing to sync with yet: add an online copy, or invite people…").
- **Errors** (`errors.ts`, `ErrorBanner.vue`). Messages from the server and git are matched against
  the common cases (cannot reach the server or the online copy, access code, git busy or mid-operation,
  sign-in to the online copy refused, the online copy ahead, permissions, a full disk, a missing file,
  a name taken, not UTF-8, a link) and said in plain words with what to do next; what was actually said
  is behind **Details**. A message that already reads as a sentence (most of the host's) is shown as it
  is; output that does not (a stack, `fatal:`, error codes) becomes "Something went wrong." with
  Details. Used for the app's banner, a document that cannot open ("Could not open notes.md." and the
  reason), and the panels and dialogs.
- **An outside edit that conflicted** (0037) is a note with **Open** and **Compare**: both show the
  copy kept beside the file in the past-version view (`PastVersion.vue`, which now takes either a
  commit or that copy), reading it or compared with the document now, and **Use this version…** makes
  the document read as it, as an undoable edit, like restoring a version (0043).
- **Run and Preview** where code cannot run (Podman missing or stopped): a chunk's Run is shown but
  disabled, with the environment's own message as its tooltip (`ChunkRunner.unavailable`; once beside
  it too, which cluttered the chunk); the menu's Code
  section says the same and disables Run all. The Preview panel already disabled Render and Save as
  with the reason; Update when saved is disabled too.

## Plain words, with details for experts

The interface says **saved**, **version**, **online copy**, **server** and **access code**. Commit
ids and branch names moved behind **Details** (the menu's document line is "Saved 14:05 · In the
history 14:05", the workspace line its connection; the version's id and the branch are in Details).
The default version name is the document's title and the date, not "Update notes/ch1.md". The
Components dialog says the host's components are set by whoever runs it, with the flags behind
Details; the Packages dialog says the workspace keeps a list of its packages, with the file's name
behind Details. "Host URL" and "Access token" are **Server address** and **Access code** (the
launcher too); "Host and token…" is **Server and access code…**. A version mismatch says the app and
the server read the format differently and to update one, with the version numbers behind Details.
The desktop app asks "Use “notes” as a workspace?" before making a folder a repository, saying every
version is kept inside the folder.

The host's messages that people read lost their flags ("Installing packages is turned off on this
server; whoever runs it can turn it on"), and say *server* for itself; the API's shapes are
unchanged, and its log lines stay technical.

## Accessibility

- **Dialogs** share one mechanism (`focus.ts`): a stack of modal dialogs, of which only the top one
  takes Tab (kept inside it, round from last to first) and Escape (closes it, or goes back a step),
  with focus moved in when it opens and given back to where it was when it closes. Vue dialogs use it
  through `useDialog` (`vue.ts`); the plain-DOM questions (`ask.ts`) push onto the same stack, so a
  question asked over the menu closes on its own. Every dialog has `role="dialog"` (a yes/no question
  `alertdialog`), `aria-modal` and a label from its heading: the menu, Markdown and shortcuts,
  Settings, Components, Packages, Header, Invite, New file, Rename, Add a workspace, and the questions.
  The menu (⌘,) now takes focus when it opens, so typing no longer edits the document behind it. The
  page's own keys (⌘,, ⌘/, ⇧⌘F, ⇧⌘R, ⌘F, ⌥⌘O) wait while a dialog is open, except the one that closes
  it. The Search and Preview panels are not modal: Escape inside them closes them, and focus goes back
  where it was.
- **The file list** is a tree: `role="tree"`, `treeitem` and `group`, `aria-expanded` on folders,
  `aria-level`, and `aria-current="page"` on the open file. One row is in the Tab order (the last
  focused, else the open file, else the first); ↑ ↓ Home End move, → opens a folder or goes into it,
  ← closes it or goes up, Enter (or Space) opens, F2 renames, Delete (⌘⌫ on a Mac) deletes, Shift+F10 or
  the menu key shows the right-click menu by the row (`treeKey` in `tree.ts`, tested on its own). The
  row's buttons show on hover and while it has focus, and stay out of the Tab order (the menu has the
  same). Files no format opens are rows like any other: focusable, renamable, deletable, just not
  opened. **Move to…** in the right-click menu moves a file or folder by naming its folder: the
  keyboard's way to do what dragging does. A file's menu also has **New file here…** and **New
  folder here…**, so the top level is reachable from the keyboard (all three since taken out of the
  menu: [0054](0054-document-settings.md)); the space below the files (right-click
  for the top level) is a stable target (`tree-space`) and takes focus itself when there are no files.
  The right-click menu gives focus back to its row when it closes.
- **Contrast** (WCAG AA): muted text is #635f58 (light) and #a5a198 (dark), at least 4.5:1 on every
  background it sits on, the selected row's included; file icons lost their 0.7 opacity (icons need
  3:1; the open file's is the text's colour); `--tok-comment` is #69645a (dark #a39e93), and the
  number and builtin colours were darkened to pass on the code background; line numbers and the
  inline note's prefix are no longer faded below 4.5:1. The launcher and Preferences windows use the
  same muted colours. Disabled buttons stay faded, as WCAG allows.

## ⌘, belongs to the page

⌘, was both the desktop app's **Preferences…** and the in-app menu. **Chosen:** ⌘, (Ctrl+,) is the
in-app menu everywhere, since that is where a person's own settings are and it works the same in a
browser. In the desktop app, Preferences stays in the menu bar (the app menu on a Mac, File elsewhere)
with ⌥⌘, (Ctrl+Alt+,), and the in-app menu's You section has **App preferences…**, which opens the same
window. The Help menu shows ⌘/ for Markdown and Shortcuts without taking the key from the page
(`registerAccelerator: false`).

## The string catalogue

Every word the client shows is in `packages/client/src/strings.ts`: one object, `S`, by area, of
plain strings and small functions for those that take values; Vue templates and the plain-DOM code
(`ask.ts`, `nodeviews.ts`, `runs.ts`, `upstream.ts`, `header.ts`) read it. Counts use
`Intl.PluralRules` (`count(n, 'file', 'files')`), never `=== 1 ? '' : 's'`. There is no i18n
framework: a translation would be another object of the same shape, chosen at start. The desktop
app's main process has its own small catalogue (`apps/desktop/src/strings.ts`). Spelling is British,
as the docs are (colour, behaviour, initialise).

Not moved: the format editor modules' own words (their `label`, `description` and `help`, the citation
picker, a table's menu, a conflict block's labels) stay in their packages, which cannot import the
client; they reach the client as data through the editor-kit contract. The launcher and Preferences
pages are static HTML with their words in place.

## Tests

`packages/client/test/polish.test.ts` (errors in plain words, plurals, key labels and matching, the
tree's keys, the help sheet), `packages/format-pandoc/test/editor-help.test.ts` (every bound key is in
the help, and only those), `tests/e2e/polish.spec.ts` (the placeholder and the help sheet, the offline
banner with a connection cut by the test and Try again, the keyboard file tree with Move to…, dialogs
keeping and returning focus, the menu taking it). Specs whose words changed were updated, and the
sidebar test right-clicks the `tree-space` element, scrolled into view, instead of a point near the
bottom of the list (which other tests' files could push off screen or cover).

**Not done:** whole-word search in the help sheet; a retry button for a failing save (the host already
retries on its own, with growing waits); translations themselves.
