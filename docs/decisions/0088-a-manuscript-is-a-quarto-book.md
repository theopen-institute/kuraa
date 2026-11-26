# 0088 · A manuscript is a Quarto book (proposed)

**Status: replaced** by [0091](0091-order-and-compile-over-folders.md): folders are arranged by hand (a `.kuraa-order` file) and compiled through pandoc, not kept as Quarto books (Quarto comes back as an export). As it was built: It adds a feature, `@kuraa/manuscript`:
documents in an order of the writer's choosing, kept as a Quarto book's chapters in `_quarto.yml`,
shown as a navigation view ([0087](0087-navigation-is-made-of-components.md)), in whatever layout is
on.

The owner, comparing Kuraa with Scrivener, chose first what the rest of Scrivener's way of working
rests on: a long work kept as many documents in an order of one's own, which the file list (always
sorted by title) cannot give. On where to keep the order:

> "What existing standard is most robust for custom sequencing? I want to use something that will
> work for pandoc and the like."

> "Quarto books seems like a good structure, and learning the qmd markdown extensions is also
> valuable for this purpose and generally."

## Which standard

No standard is both read by pandoc itself and able to hold parts:

- **A pandoc defaults file** (`input-files:`, `pandoc -d book.yaml`) is the only one pandoc reads,
  but its list is flat, and pandoc joins the files into one before reading them, so where two
  metadata blocks set a field the second wins: each chapter's `title:` (where Kuraa keeps a
  document's title, [0055](0055-title-in-the-page.md)) would become the book's, the last one's, and no
  chapter would have a heading. R Markdown would not be knitted.
- **bookdown's** `_bookdown.yml` (`rmd_files:`) is flat and for R alone, and Quarto is taking its
  place.
- **mdBook's and GitBook's** `SUMMARY.md` nests, but nothing of pandoc's reads it.
- **A Quarto book** (`_quarto.yml`, `project: type: book`) lists chapters in order, in parts (a title,
  or a file with the part's title and an introduction) and appendices; a chapter's title may be its
  header's `title:`, as Kuraa's are; Quarto renders it with pandoc to PDF, Typst, Word, EPUB and
  HTML; RStudio, Positron and VS Code know it.

**A manuscript is a Quarto book.** A pandoc defaults file can be made from its list when someone
wants one (an export), never kept as a second copy of the order.

What it costs: Quarto requires `index.qmd` as the first chapter (its documentation names no other);
Word and EPUB leave parts out (HTML, PDF and Typst have them); and a folder with `_quarto.yml` is a
Quarto project to the tools that know Quarto, which is mostly what is wanted.

## What is decided

### The file

A folder with a `_quarto.yml` whose `project: type:` is `book` is a **manuscript**; a workspace may
have several, each in a folder of its own. Its order is the file's `book: chapters:` and `book:
appendices:`:

```yaml
project:
  type: book
book:
  title: "Tidal notes"
  chapters:
    - index.qmd
    - part: "The coast"
      chapters:
        - chapters/arrival.md
        - chapters/the-harbour.Rmd
    - part: parts/inland.qmd
      chapters:
        - chapters/fields.md
  appendices:
    - appendices/sources.md
```

Paths are relative to the folder `_quarto.yml` is in. **Kuraa reads and writes only those two
lists** and leaves everything else in the file as it is, comments and layout included (the `yaml`
package's documents, as the header is kept, [0021](0021-document-header.md)), so a book's other
settings are the writer's and Quarto's.

**Making a manuscript** (a folder's menu: *Make a manuscript*) writes a `_quarto.yml` with the
folder's documents as chapters, in the order of their paths (*revised*: no `index.qmd` is made, as
a feature writes no document). Kuraa shows a manuscript without an index file as it is, and says
nothing of it (*revised*, the owner: "I don't understand what I'm supposed to do about it"): Quarto
requires one only to render the book, and has no setting to do without it, so rendering a manuscript
(not built yet) will put one in where the book has none, and nobody need know of it.

### The view

**Manuscript**, a navigation view (in the sidebar, as a tab beside the file tree): the manuscript's documents in order, by title, each part a heading
that folds, the appendices after them; drag to reorder, into a part or out of it. Below, **Not in the
manuscript**: the folder's other documents (Scrivener's Research), to drag in. With several
manuscripts, the view names the one shown and chooses between them. A chapter the list names but
that is not there (renamed outside the app) is shown as missing, to remove or to point at its file.

In the file menu (0087's): **Add to manuscript** and **Remove from manuscript** (which never deletes
the file). Among what the view adds to a layout's ＋: **New chapter**, made after the one selected, as New file makes
a document.

### The feature's host half

It declares the `_quarto.yml` files it writes, and follows renames, moves and deletions made in the
app (the feature events, 0082): a chapter renamed is renamed in the list, in a commit of its own
after the rename's. Who may change a `_quarto.yml` may reorder its manuscript; anyone else sees the
order and cannot change it, as with any file. Two people reordering apart merge as the YAML's text
merges, a conflict shown as in any text file.

What the contract lacks, to be added as it is built:

- **Declaring files by name** wherever they are (`_quarto.yml`), not only by the workspace's
  settings (`files(settings)`).
- **Writing a file open in a room**: a feature's write to a file someone has open must reach the
  room as an outside edit does ([0025](0025-merging.md)), never write past it.

## Not decided here

- **Quarto documents** (`.qmd`): editing them as documents, and how Markdown, R Markdown and Quarto
  are kept as one family, closely related as they are. A record of its own; until then `.qmd` files
  open as text ([0010](0010-text-format.md)), `index.qmd` among them.
- **Rendering a manuscript** as one book (Scrivener's Compile), in the rendering pipeline
  ([0041](0041-rendering.md)) with Quarto where code runs.
- **A synopsis, a status and labels** for each document, in its header, and views that show them (an
  outliner, a corkboard); several documents edited as one (Scrivener's Scrivenings).
- Reading bookdown's `_bookdown.yml` and pandoc defaults files as manuscripts.

## Built

- **Off until a workspace turns it on** (Settings › Workspace, under Features), as annotations are:
  a workspace with no book would otherwise have an empty Manuscript beside its file tree. With it on,
  the sidebar shows **Files** and **Manuscript** in a row above them.
- **The view**: the manuscript's chapters by title, each part a heading over its chapters, the
  appendices, then **Not in the manuscript** (the folder's documents not listed, outside folders
  starting `.` or `_`). Nothing is shown above the chapters but, with several manuscripts, the list
  that chooses one (*revised*: no title). Parts' headings stand out (bold, a line above each). While
  a row is dragged, a line shows where it lands, at the level it lands at: before a row, or below a
  part's heading when a chapter is dropped onto it (into the part). Drag a row before another, onto a part's heading (into it), onto the
  appendices, or down to Not in the manuscript (out); **Alt+↑** and **Alt+↓** move a row where it
  is. **Add a part…** asks for its title. A chapter listed but not found is struck through, with
  **Take it out**. With several manuscripts, a list above chooses one (remembered in this browser).
  Click opens; right-click is the core's file menu.
- **The menus**: a folder's **Make a manuscript** (where it has none; features now add to folders'
  menus too, their paths ending in `/`); a document's **Add to manuscript** or **Remove from
  manuscript**, where it is in a manuscript's folder. So the menus know the manuscripts before a
  right-click, a client half may now **activate** when it comes into use for a workspace (and stop
  when it goes), to start what it keeps; the manuscript asks for its books then, and again when the
  host says one changed.
- **The host half** writes files **named** `_quarto.yml` wherever they are (`names`, a contract
  addition), committed as whoever asked; follows renames, moves and deletions made in the app; tells
  the views when a book changes, here or in a merge. **While a `_quarto.yml` is open in a room, a
  feature's write to it is refused** (409, "close it to change it from here"), rather than written
  past the room: reaching the room as an outside edit does is left for later.
- **Not yet**: **New chapter** in ＋ (made after the one selected), a part's title changed or a
  part removed from the view (edit `_quarto.yml` for now), renaming a part's file into a title.
