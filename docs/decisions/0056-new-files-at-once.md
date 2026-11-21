# 0056 · New file makes a document at once; Rename… chooses the kind

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
