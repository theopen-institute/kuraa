# 0093 · Order and Compile over folders

**Status: built.** Replaces [0090](0090-manuscripts-apart-from-folders.md), and the Quarto storage of
[0088](0088-a-manuscript-is-a-quarto-book.md): there is no manuscript beside the file tree any more.
Folders are arranged by hand in it, and any folder is compiled into one book.

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

A first cut kept a "manuscript" as a folder marked as one (a book by its name, documents left out of
it). Asked "What purpose does declaring a document a 'manuscript' now do?": none until Compile, which
can take any folder, so the marking was a step that only switched other things on. It went: Compile is
on every folder's menu, and what is left out is left out of any compile.

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
Files whose names begin `.kuraa-` are the app's, about their folder: not shown, not searched.

**Any folder is compiled into one book** (the core's render of a folder; `@kuraa/compile`, on by
default, asks for it). **Compile…** on a folder's menu opens its panel: the book's title (the folder's
name at first), Word, PDF or HTML, **Compile**; the book is saved when it is made. Its folders and documents
(Markdown, Quarto's, R Markdown) in the order the file tree shows them, through its folders, are joined
into one Markdown document, in the render's scratch (the workspace is not touched), the book's title as
its header. **How deep something is in the tree is its heading's level**: in the folder compiled, a
folder's name and a document's title are `#` headings, one folder down `##`, and so on; a document's
own headings go below its title (a document without a title: below its folder's); its header is left
out; past `######`, a heading stays at `######`. The owner asked first whether folders could be headings
"all the way down to ######", then, of the switches and settings that came with it, "What's the
simplest way to handle it, comparable to what scrivener does?": this one rule, the folder's name as the
tree shows it (rename the folder for another heading), and one thing more, asked for with it:
**No heading in Compile** on a folder's menu (**Heading in Compile** to undo it; a struck H by its
name), for a folder that only organises: it adds no heading and no level, what is in it going on at the
level it is at, as Scrivener's section layouts let a level go untitled. A folder with no documents in the
book has no heading either. That is rendered as a document is (pandoc, with
Typst or LaTeX for PDF), finding images in each document's folder. R Markdown's chunks are not run in a
compile, and show as code. A folder's title and format are kept for next time, and it is marked with a
book.

**Leave out of Compile** on a document's or folder's menu (a folder, all in it), **Put back in Compile**
to undo it: left out of every compile that would have it, as Scrivener's *Include in compile* is the
document's own; faded and struck through in the file tree. It stays left out when renamed or moved.

Compile keeps these in a plain file in the folder, `.kuraa-compile.yml`: its title and format, whether
its name is a heading (`heading: false`), and what in it is left out, by name, as `.kuraa-order` names
them.

The host renders a folder as it renders a document: `POST /api/renders` with a path ending in `/` (the
top level `/`), what to leave out (`exclude`), the folders with no heading (`noHeading`) and the title;
a renderer may be told the folders where what it refers to is found (`resources`). Components get it as
`host.render(folder, format, { exclude, noHeading, title })`.

**Components mark files.** A feature may put a mark on a file or folder wherever navigation shows them
(`marks(path)`: words, an icon, faded or not) and say when its marks changed (`marksChanged`). A
feature's commit messages (`describe`) now cover the files it writes by name, not only its companions.

**What goes:** `@kuraa/manuscript` (the Manuscript view, chapters from anywhere, home folders, **New
chapter**, **New manuscript…**, Quarto profiles, `.kuraa/manuscripts.json`, **Manuscripts keep their
files**). Files 0090 wrote stay as they are, ordinary files. `moveFile` stays in the contract, as any
component may want it.

### Not yet

A folder's top level as real parts in a LaTeX PDF (`--top-level-division=part`); a heading other than
the folder's name; R Markdown's chunks run when compiled; a book's other
settings (author, a table of contents, numbered chapters, a Word template); a Quarto book or bookdown
export made from the same order; a corkboard or outliner over the same order; a document in more than
one book, as a reference.
