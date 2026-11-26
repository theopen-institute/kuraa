# 0090 · Manuscripts apart from folders

**Status: replaced** by [0091](0091-order-and-compile-over-folders.md): folders are arranged by hand and
compiled into books, and nothing of what follows is built any more.

> Revises [0088](0088-a-manuscript-is-a-quarto-book.md): a manuscript was a folder's `_quarto.yml`,
> its chapters that folder's documents.

The owner asked:

> "My goal would be to allow manuscripts to be a completely separate abstraction layer, with no
> necessary connection to file hierarchies. At the same time, that could get really messy for people
> who prefer working in manuscript view. What do you recommend? Manual control but sensible
> defaults?"

> "In principle, would it be possible for the same file to appear in multiple manuscripts?" … "Okay,
> implement that. It might still need some work, but this is a start."

And then (*revised*, the same day):

> "Actually, for now, remove the ability for the same file to be in multiple manuscripts. It's
> conceptually confusing. We'll add it later with some sort of duplicate/reference concept."
>
> "For now, manuscripts should remain abstracted from file folders, but there should be a setting
> that allows manuscripts to manage file locations."

## What is decided

**A manuscript's chapters may be any of the workspace's documents.** Its order is its own: reordering
never moves a file, and moving a file never changes the order (a rename is followed). **A document is
in one manuscript at most** (*revised*: it was in as many as anyone liked, which was confusing; a
document in two books comes back later as a duplicate or a reference, a concept of its own). The host
refuses one already in another manuscript (409, naming it); the views offer it to none. A book made
elsewhere that lists a document another book lists is read as it is, and keeps it. Taking a document
out leaves the file; deleting the file takes it out.

**Manuscripts keep their files** is a setting of the workspace's (Settings › Workspace, under
Manuscript; off at first, in `.kuraa/features.json` as `manageFiles`). On, each chapter is moved into
its manuscript's home folder, a part's chapters (and its file) into a folder of the part's name inside
it (`novel/the-coast/`), the appendices into `appendices/`, as they are added, made and moved between
parts, and every manuscript's at once when it is turned on. Names stay as they are, so reordering moves
nothing; taking a document out leaves it where it is; a file that cannot go (one is there already,
someone may not move it) stays, and is said once. The moves are the file tree's (a component asks the
core to move a file, `moveFile`, as a rename by hand is made), so permissions, companions and anyone
with the file open follow, and the books follow the renames. Off, files stay wherever they are.

**Each manuscript has a home folder** (a sensible default, for whoever works in the Manuscript and not
the file tree): where **New chapter** makes its documents. Set when it is made (the folder it was made
of, or a folder named after it), changed with **Change folder…**. **Nothing is added unasked**: a
document made in the tree, synced from another device or written in another editor waits under **Not
in the manuscript** (its home folder's documents, or with **All**, any) until someone adds it.

### Where they are kept: Quarto's project profiles

Quarto renders only what is in a project's folder, so books whose chapters may be anywhere are kept
at the top of the workspace, and several of them as Quarto's **project profiles**, one book of
several from one project, as Quarto's own documentation shows:

- `_quarto.yml` at the top: `project: type: book`, and its profiles as one group of which one is
  rendered at a time (`profile: group: - [novel, a-thesis]`, the first by default). Made where there
  is none; kept as it is otherwise, but for the group.
- `_quarto-<name>.yml` for each manuscript: `book: title:`, `chapters:`, `appendices:`, paths from
  the top. Rendered with `quarto render --profile <name>`. `<name>` is made from the title.
- `.kuraa/manuscripts.json`: each manuscript's home folder (Kuraa's, as Quarto has no place for it).

A folder's own `_quarto.yml` that is a book (a Quarto book made elsewhere, or by 0088) is still a
manuscript, its chapters that folder's (Quarto's rule for it); so is a top-level `_quarto.yml` with a
chapter list of its own, beside which no profiles are made (Quarto would join their chapter lists to
its own: **New manuscript** says why it cannot).

### What is done

- **New manuscript…** (in the Manuscript, and when there is none) asks its title; **Make a
  manuscript** on a folder's menu makes one of that folder's documents, its home that folder.
- **New chapter** (in the Manuscript, and ＋'s menu while the Manuscript is shown) makes a document in
  the home folder, put after the chapter open (where that is in it) or at the end, and opens it with
  the cursor in its title.
- **Add to** a manuscript on a document's menu (each by name where there are several), where it is in
  none; **Remove from** its manuscript, where it is in one.
- **Renames and deletions** are followed into the manuscripts, and homes with them; a chapter moved
  out of a folder-book's folder is taken out of it; a manuscript's file deleted leaves the group.

The contract gains: names a feature writes may have `*` (`_quarto-*.yml`), a navigation view's
`newFile` gives the path it made, and `moveFile`, a file moved or renamed as the file tree does.

### Not yet

A document in several manuscripts (as a duplicate or a reference); renaming or deleting a manuscript from the view (its file can be renamed or deleted in the tree);
moving a manuscript's chapters into its home folder ("Tidy files", only ever when asked); a part's
title changed from the view; and anything about rendering (an index file where the book has none,
references to chapters another book leaves out).
