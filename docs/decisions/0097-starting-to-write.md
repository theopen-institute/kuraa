# 0097 · Starting to write

*Since [0116](0116-importing.md):* **New file…** in a menu (＋'s, right-clicked; a folder's; the space below the files) asks the file's kind first, then a document's title or a file's name, and makes it at once; ＋ itself and a folder's own ＋ still make an untitled document as below.

**Status: built.** Starting a new document is made as plain as it can be: there is always a page to
write on, and a file is made only when something is written in it. It revises 0086 (＋ a menu of a
new file or folder) and 0044's page for nothing open.

The owner: "Starting a new file should be the most seamless process in the entire application.
Starting to write should always be trivially easy and natural." They asked for four things: new empty
documents not written to the file system until the user writes something; ＋ opening a new Markdown
document directly, with no "add folder / add file" menu; no "Nothing open yet" page, a blank document
instead, with no file until one is made; and a click on the sidebar's empty space leaving the open
file for that blank document.

## What is decided

**A draft: a document with no file yet.** A new document (from ＋, a folder's "New file in…", or the
blank page) is given its name as before (`untitled-xxxxx.md`, in the folder shown or the one asked
for) but nothing is written. It opens in a room the host makes for a file that does not exist
(`GET /api/rooms?path=…&draft=1`; the name checked as a new file's is, and refused where the person
may not write). The room starts empty, and is written to disk the first time its text is not empty, at once (not after
the pause in the typing other saves wait for, so the file list has it while the writing goes on):
the folders it needs made, the file written (in the space new files go to, as a new file made any
other way is), the file list told, then committed as any change is. Left untouched, it leaves nothing
behind: no file, no commit, no row in the file tree. Its name follows its title when it is left, as
before.

**Until it is made, a draft is the browser's alone.** It has no row in the file tree, no name in the
window's title (the workspace's only), and is not remembered as the open file across a reload: a
reload starts a new blank page. Settings › Document says no document is open (a document's settings
kept for a file that may never be made would be left behind). Once the file is made it is an ordinary document, its row marked as
the open file.

**Nothing open is a blank document.** Where the "Nothing open yet" page was, a draft is opened, the
cursor in its title: whenever a workspace is open and neither a document nor a folder view is shown
(at the start, after the open document is deleted, or after the sidebar's space is clicked).

**＋ makes a document at once.** The sidebar's ＋ ("New document") opens a new draft in the folder
shown in the main area, else at the top. Its old menu (a file of another kind, a folder, and what
components add to it, such as Example's) is still there, right-clicked; a folder's own buttons and
the space below the files make folders as before.

**A click on the sidebar's empty space** (the space below the file tree) leaves the open document, or
the folder shown, for a blank page. Its right-click menu is as it was.

## What is not decided here

A draft left with only a title and no body is made (its title is something written). A draft open in
two browsers at once is not possible, as only the browser that made it knows its name.
