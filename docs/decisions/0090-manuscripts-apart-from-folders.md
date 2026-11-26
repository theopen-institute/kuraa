# 0090 · Manuscripts apart from folders

> Revises [0088](0088-a-manuscript-is-a-quarto-book.md): a manuscript was a folder's `_quarto.yml`,
> its chapters that folder's documents.

The owner asked:

> "My goal would be to allow manuscripts to be a completely separate abstraction layer, with no
> necessary connection to file hierarchies. At the same time, that could get really messy for people
> who prefer working in manuscript view. What do you recommend? Manual control but sensible
> defaults?"

> "In principle, would it be possible for the same file to appear in multiple manuscripts?" … "Okay,
> implement that. It might still need some work, but this is a start."

## What is decided

**A manuscript's chapters may be any of the workspace's documents.** Its order is its own: reordering
never moves a file, and moving a file never changes the order (a rename is followed). **A document may
be in several manuscripts**, once in each: a chapter shared by a thesis and a paper. Taking it out of
one leaves it in the others, and the file; deleting the file takes it out of all of them.

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
- **Add to** and **Remove from** a manuscript on a document's menu, each manuscript by name where
  there are several. A chapter in other manuscripts too is marked (`+1`, naming them when pointed at).
- **Renames and deletions** are followed into every manuscript, and homes with them; a chapter moved
  out of a folder-book's folder is taken out of it; a manuscript's file deleted leaves the group.

The contract gains: names a feature writes may have `*` (`_quarto-*.yml`), and a navigation view's
`newFile` gives the path it made.

### Not yet

Renaming or deleting a manuscript from the view (its file can be renamed or deleted in the tree);
moving a manuscript's chapters into its home folder ("Tidy files", only ever when asked); a part's
title changed from the view; and anything about rendering (an index file where the book has none,
references to chapters another book leaves out).
