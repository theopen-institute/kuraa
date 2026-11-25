# 0080 · What a tester found: rooms of files gone, case renames, syncing on quit, and smaller things

> Changes [0076](0076-a-quieter-sidebar.md) (no Sync button; the light grey with no document
> open), [0056](0056-new-files-at-once.md) (New file beside the open file, as `untitled.md`) and
> [0039](0039-online-copy.md) (what is pushed when).

A tester using two computers on one workspace reported fifteen things. These are what was wrong, and
what changed. (A cursor that leans in italics, also asked for, is not done: the cursor is the
browser's own.)

## A file renamed or deleted elsewhere is never written back

A new document was renamed after its title, `untitled.md` to `feature-requests.md`, and two seconds
later a commit from the other computer made `untitled.md` again, from a room it still had open; the
renamed copy was then deleted, and the document kept the name `untitled.md`. Earlier the same day,
a new `untitled.md` got the header of the document that had had that name a moment before, from
another device's session of it.

- **A room whose file a commit took away closes** (`Host.checkOutside`, which every way work comes
  in ends with: a merge from a device, a push, git outside the app). Its people are told where the
  file went (`gone`, with the new path for a rename), and the app opens it there, or nothing. A
  room with edits not yet in a commit keeps its file, as before: edits are not lost to a delete.
- **A rename or delete here tells whoever has the file open** in the same way (`dropRoom`).
- **New file names a document `untitled-` and five letters by chance**, never plain `untitled.md`
  again and again: a name given back to a new file could meet the session another device still has
  of the file that last had it. It is renamed after its title when left, as before.

## Renaming in case alone

`drama` to `Drama` was refused as "already exists" on a Mac (and on Windows), whose file systems
take the two for one name. Now a rename to the same file in another case goes through a name of its
own; `git.stage` takes a path whose folder has it only in another case as gone, and takes paths out
before adding; and such a commit is made from an index of its own, as `git commit -- <paths>`
cannot record it where git ignores case.

## Syncing

- **The online copy gets the last saves as the host stops.** It was closed first, then the open
  rooms were saved: those saves, and any push still waiting its half minute, went only at the next
  start. Now the rooms are saved, then whatever the copies lack is pushed (waiting 8 s at most;
  the rest at the next start), then they close.
- **The online copy says how many saves it lacks** (`pending`, from its remote-tracking branches).
- **Sync now is back**, in the workspace's menu, where the workspace syncs with devices or an online
  copy; it says how many saves the online copy lacks. People could not tell whether their work had
  gone, and wanted to make sure. No "sync every minute" setting: every save is pushed already.
- **The light is the host's when no document is open**: green while it answers (it syncs with the
  devices and the copy then too), red when not; its tooltip says, either way, how many devices are
  connected and whether the online copy is up to date. Grey read as "not sharing".

## Starting

- **The relay is offered once it is up, never waited for.** A host offering itself as a relay
  waited for the DHT before its workspaces opened; on a network that blocks it (a school's) that
  is many seconds, and the window stayed white. The desktop app now shows a starting page at once
  (with a note after five seconds that such networks make starting slower), its window has the
  pages' background colour, its pages load one after another (one started while another loaded
  cut it short: the `ERR_ABORTED` the tester saw), and the hub is started once however many things
  ask for it meanwhile.
- **The workspace last open opens again.** It was remembered under the host's address, and the
  desktop app's host takes another port each time it starts; a host on this computer is now
  remembered by its name alone.

## Writing

- **Dragging from the empty space beside or below the text selects**, as in the text, and
  Shift-click there extends the selection. Before, a click there only placed the cursor.
- **Backspace at the start of a list item takes it a level out** (out of the list at the top),
  as Enter in an empty item does, not into the item before it. Joined to it, a heading typed next
  went inside the last item of the list above (indented in the file) with nothing to show it.
- **⌘K adds a link** (⌘⇧K still does), and in a link changes its address, or takes the link away
  (the address emptied). **⌘-click opens a link**: a web address in the browser, a file of the
  workspace in the app. `workspacePath` is editor-kit's now, for the client to resolve links with.
- **No ligatures while writing**: in Iowan, ff and fi join, and the cursor between them was drawn
  through the joined letters.
- **Adding a field** in Document settings: the button is filled, the search box drawn as one, and
  the fields in boxes of their own, so the list no longer blends into the window.

## Smaller

- **New file (＋ at the top of the sidebar) makes the document at the top level**, never beside
  the open file unasked: a folder's own New file is for that. People did not notice which folder
  they had open.
- **Developer Tools is ⌥⌘J** in the desktop app's View menu: its usual ⌥⌘I is the page's own (a
  new R chunk), which the menu took first.
- **Kuraa, capitalised**, wherever people read it: the app's name (`productName`, so `Kuraa.app`),
  its window, its pages and messages, release titles. What is not read as a name stays lowercase:
  the package and program (`kuraa`, `executableName` on Linux), the app's data folder (pinned to
  `…/kuraa`, so Linux, whose names keep their case, does not leave it behind), `Documents/kuraa`,
  `.kuraa`, `kuraa://`, `kuraa-invite:`, git's `kuraa.*` settings, and the words devices hash or
  send each other.
