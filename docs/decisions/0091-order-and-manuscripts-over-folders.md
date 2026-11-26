# 0091 · Order and manuscripts over folders

**Status: built.** Replaces [0090](0090-manuscripts-apart-from-folders.md), and the Quarto storage of
[0088](0088-a-manuscript-is-a-quarto-book.md): a manuscript is no longer a book of its own beside the
file tree, but a folder in it, arranged by hand.

The owner, after trying the Manuscript as 0090 left it:

> "The manuscript interface seems really buggy at the moment. I'm confused about how it is supposed to
> work. Are we making this too complicated? What if, instead of being a full parallel system to file
> systems, it was just a metadata layer on top of the file system that would allow for things like
> custom sequences, etc. Wouldn't that more closely match Scrivener's functionality?"

It would: Scrivener's binder is its only structure, its manuscript the Draft folder in it, in the order
it is dragged into, each document with *Include in compile*. On Quarto, asked "is it still
advantageous to use quarto books?": Kuraa renders through pandoc and never runs Quarto, so a book kept
as Quarto's gave nothing inside Kuraa, and its rules (a project renders only what is in its folder)
were where 0090's profiles and home folders came from. The owner agreed to the order and include
switches in the file tree first, then Compile, on pandoc, with Quarto (or bookdown) as an export later.

## What is decided

**Any folder may be arranged by hand.** Its files and folders, together, in the order someone puts
them: dragged in the file tree between two rows (a line shows where; onto a folder's middle, into
it at the end), or moved up and down with **Alt+↑** and **Alt+↓**. Its order is a plain file in it,
`.kuraa-order`, one name per line, which is the core's (not a component's: it is the files', and
every view and Compile reads it):

- it lives where what it orders lives, so it moves and goes with its folder, and is in the folder's
  space (0069), read by whoever reads the folder and changed by whoever may change it;
- what it does not name follows what it does, by name as before (folders first, then documents by
  title), so a file made elsewhere is never lost; a name of nothing there is passed over;
- a rename or move made here is followed (the new name where the old was; out of one folder's order
  and at the end of another's, where that one has an order) in a commit of its own;
- **New file** in an arranged folder goes after the open file, where it is in that folder, else at
  the end; **Sort by name** on a folder's (or the top level's) menu forgets its order.

The host gives the orders with the tree (`GET /api/tree`, `orders`) and keeps one with `POST
/api/order`. Navigation views get `order(folder)`, `place(path, folder, names)` (moved if need be, then
that order) and `sortByName(folder)`. The file tree shows files and folders interleaved, in the order.
Files whose names begin `.kuraa-` are the app's, about their folder, and are not shown.

**A manuscript is a folder marked as one** (`@kuraa/manuscript`, off until a workspace turns it on):
**Make a manuscript** on a folder's menu, **No longer a manuscript** to undo it. Its book is its
documents (Markdown, Quarto's, R Markdown) in the folder's order, its folders' as parts, all but those
left out: **Leave out of the manuscript** on a document's or folder's menu (a folder, with all in it),
**Put back in the manuscript** to undo it. It is said by `.kuraa-manuscript.yml` in the folder: its
title, if it has one besides the folder's name, and what it leaves out, named from the folder.
Renames and deletions of what it leaves out are followed; the folder moving takes it along. One
manuscript is never inside another. A document is in a manuscript by being in its folder, so in one
at most; to put it in, move it there, as in Scrivener.

**Components mark files.** A feature may put a mark on a file or folder wherever navigation shows them
(`marks(path)`: words, an icon, faded or not) and say when its marks changed (`marksChanged`): the
manuscript's book by its folder, and its left-out documents faded and struck through. A feature's
commit messages (`describe`) now cover the files it writes by name, not only its companions.

**What goes:** the Manuscript view, chapters from anywhere, home folders, **New chapter**, **New
manuscript…**, Quarto profiles (`_quarto.yml`, `_quarto-*.yml`) and `.kuraa/manuscripts.json`, and the
setting **Manuscripts keep their files**. Files 0090 wrote stay as they are, ordinary files. `moveFile`
stays in the contract, as any component may want it.

### Not yet

**Compile**: a manuscript joined in order and rendered (Word, PDF, HTML) through the pandoc that renders
documents now, with whatever settings it needs; then a Quarto book or bookdown export, made from the
same order. A title changed from the app; a corkboard or outliner over the same order; a document in
more than one manuscript, as a reference.
