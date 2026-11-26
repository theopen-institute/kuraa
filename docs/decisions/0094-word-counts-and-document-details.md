# 0094 · Word counts and document details

**Status: built.** Two components, `@kuraa/words` and `@kuraa/details`, both on by default, and
what the core gives them.

The owner, asking what Kuraa still lacks against Scrivener, chose these first of the list ("Okay, do 1
and 2"): word counts and targets, which writers look at all day and which Kuraa had nowhere; and each
document's details (Scrivener's synopsis, label, status and keywords), which its corkboard, outliner,
collections and compile filters are all made of, and which come before them.

## What is decided

**Words are counted one way everywhere** (`countWords`, `markdownWords` in `@kuraa/kernel`): a word is
a run of letters or digits, with apostrophes and hyphens inside it; in scripts written without spaces
(Chinese, Japanese), a character. A file's words are its prose as a reader sees it: not its header,
code (fenced or inline), HTML comments and tags, links' and images' addresses, footnote and citation
keys. The open document's are counted the same way from what is in the editor (paragraphs' text, not
code nodes or marks, the header, or atoms such as citations), so the two agree but for such rarities as
a word split by an atom.

**The open document's words, along its foot.** A strip along the foot of the open document is where
components keep small things in view: a panel may be a **status** panel, always drawn there while a
document is open, never opened or closed. Words' shows the document's words as they are typed (counted
a moment after each change), of its target with a bar where it has one, and the words written today.
Clicking it, or **Words…** in the ⋯ menu, opens the **Words** panel:

- **A target for the document**, kept in its header as `target-words: 2000`, for everyone who opens it.
- **Today**: each document's words now, less its words when it was first open today, added up: a day's
  change, not keystrokes (what someone else writes in it while it is open counts too). With **a target
  for a day**. Kept in this browser (`localStorage`); a new day starts afresh; **Start counting again**
  begins from now. Scrivener's session target is likewise the writer's, not the project's.

**A book's words, in Compile.** Compile's outline gives each document's words (`bookContents` gives
them, counted from its file), the book's total (what is in it), and **a target for the book**, kept with
the folder's Compile settings (`target-words` in `.kuraa-compile.yml`).

**A document's details**, as Scrivener's inspector has them, in its own header, where pandoc and other
tools read them: `synopsis`, `label`, `status`, `keywords` (pandoc's own field). **Details…** in the ⋯
menu opens the **Details** panel: a synopsis, a label (the labels already used are suggested), a status
(chosen from the workspace's, Scrivener's five where it names none: *To do*, *First draft*, *Revised
draft*, *Final draft*, *Done*; set in Settings › Workspace, under Document details), keywords (separated
by commas; those used are suggested). Each is written to the header as it is left, as one edit everyone
sees and that can be undone. A label has a colour, the same each time for its name; the file tree shows
it as a dot by the document, its label and status said on pointing. The host half reads every
document's details for that (`GET documents`), again as a document is saved and after a rename,
deletion or merge.

**What the core gives** (all additive): a status panel (`status: true`) and the strip it is drawn in;
`header()` for panels, the open document's header fields to read and set (`get`, `set`), the rest of
the header, its comments among it, as it is; a mark's `color`, drawn as a dot; each document's `words`
in `bookContents`.

### Not yet

The corkboard and the outliner (folders' documents as cards or rows, with their synopses, statuses and
words, reordered as the tree is); collections and saved searches by status or keyword; Compile choosing
by status ("only Final draft"); details set for several documents at once, or for a document not open;
labels' colours chosen by hand; a deadline for a book (words a day to reach its target by a date).
