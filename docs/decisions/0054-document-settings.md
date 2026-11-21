# 0054 · Document settings: the open document's own panel of the menu; a file's right-click menu is about the file

The menu had grown a section for the open document (views, versions, saving, writing, its code
session) above the workspace's and yours, and the header was a dialog of its own. The menu is now
for the workspace and for you; what belongs to one document is in one place, **Document
settings**.

**Document settings** is a panel of the menu, as the Server panel is (`MenuPanel` in `Menu.vue`).
It is opened by **Document settings…** in the menu (under the document's name, the only thing about
the document left there) or by right-clicking a file in the sidebar, which opens the file and the
menu at the panel. It has:

- the document's views and versions: **Edit the source** / **Show the document**, **History**,
  **Save version…**, **Preview**; **Find and replace…**, **Outline**, **Insert table**, **Next
  conflict**; when it was last saved and kept in the history;
- its code session (Run all, Interrupt, Restart, Packages…), for a document with code to run;
- its **header**, for a format that declares one ([0021](0021-document-header.md)): the same fields
  and YAML as the Header dialog had (`HeaderForm.vue`), with **Save header**. Saving closes the
  menu; closing it without saving drops what was changed.

Escape leaves adding a header field, then goes back to the menu (or closes it, when it was opened
at the panel). The panel is wider than the menu when it has a header, for the fields' label column.
The editor no longer draws the header: it exposes its view and a count of changes to the document,
which the form uses to write the header and to tell it was changed meanwhile.

**The sidebar's right-click menu.** A file has **Document settings…** (for a file kuraa opens),
**Rename…** and **Delete…**. **Open** is gone (a click, or Enter, opens a file), and so are **New
file here…** and **New folder here…** (a folder's menu, or the space below the files, makes them)
and **Move to…** for files and folders: moving is by dragging. A folder has a new file or folder in
it, and **Rename…**; the top level, a new file or folder.

This takes back two things [0044](0044-polish.md) added for the keyboard: moving a file without
dragging, and reaching the top level's New file from a file's menu (the space below the files still
takes focus and has its menu when there are no files).
