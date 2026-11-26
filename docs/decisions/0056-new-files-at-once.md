# 0056 · New file makes a document at once; Rename… chooses the kind

*Since [0080](0080-tester-fixes.md):* the sidebar's ＋ makes it at the top level, not beside the open file, and names it `untitled-` and five chance letters, not `untitled.md`.

The New file dialog asked for a kind of file and a title before there was anything to type in.
Now that the title is typed in the page ([0055](0055-title-in-the-page.md)), New file asks nothing.

- **New file** (＋ in the sidebar, a folder's ＋, **New file in …** in a folder's right-click menu,
  **New document** when nothing is open) makes `untitled.md` (`untitled-2.md`, … if taken) in that
  folder (or beside the open file), empty, commits it, opens it, and puts the cursor in its title.
  The dialog (`NewFileDialog.vue`) is gone.
- **Its filename follows its title**: a document New file made keeps the name it was made with
  until it is left for another file of the same workspace; then, if it has a title, it is renamed
  to the filename its title makes (as a document made with a title was before: [0022](0022-titles-and-filenames.md)).
  Only documents made by New file in this window are renamed so, and only once; one renamed by
  hand (Rename…) is not. Left for another workspace (or with the window closed), it keeps its name.
- **Rename… has the file's kind** (`RenameDialog.vue`), for every file of a kind kuraa opens:
  Markdown, R Markdown, a text file. Another kind changes the filename's extension; a document's
  kind asks for its title, a text file's only for its name. The text is kept as it is.
- **A text file renamed to a document gets its first title**: the host checks the title against
  the kind the file will be (`checkTitle(path, title, as)`), and writes it into the header after
  the rename, as it does for any title.

## Named after its title whenever it is left (revision)

A document New file made kept its `untitled-…` name for good if the app was closed (or the page
loaded again) while it was open: which documents it had made was kept only while the window was.
Now **any document with a name New file gives** (`untitled-` and five letters or digits, a number
added if taken) is renamed to the filename its title makes when it is left for another file of the
same workspace, if it has a title: made in this window or before the app was last opened, here or
on another device. One named by hand (Rename…), even to such a name, is kept as named.
