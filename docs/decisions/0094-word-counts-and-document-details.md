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

**The open document's words, at the foot of its ⋯ menu** (*revised* twice: at first along the
document's own foot, then an item of the menu; "Don't put wordcount the footer yet. Put it in the ...
menu", then "Put the word count in the footer, below the saved status. Keep it simple, just `Word
count: xxx`. Then, in the same line: `(Words today: +xxx)`", and "Instead of words today do 'total
today', to show it's across all documents"). Below when it was saved, one line, counted as the menu
opens: `Word count: 1,234 (Total today: +312)`, the total your net words today in every document. A
component adds such a line with `documentFooter`. **Words…** in the menu opens the **Words** panel.
(The core keeps the strip along the document's own foot, unused for now: a **status** panel, always
drawn there, never opened or closed. What components add to the ⋯ menu is made as it opens, given the
document's live view and its `header()`.) The panel has:

- **A target for the document**, kept in its header as `target-words: 2000`, for everyone who opens it.
- **Today, and the last seven days, from the history** (*revised*: at first a count kept in the
  browser, of documents opened there, which saw nothing written on other devices or in other editors).
  The owner asked: "Is there a reliable way to reconstruct words per day in git merges, even in multiuser
  workspaces?" There is, because Kuraa saves often (30 seconds after typing stops, every 5 minutes
  while it goes on) and never squashes: every commit on the branch **but merges** is counted on its own,
  each document it changed (renames followed) compared with its parent; merges are passed over, as they
  only bring together work counted in the commits on each side, so what was written on another device
  counts **on the day it was written**, whenever it arrived. Its day is the commit's own (its author's
  date, where it was made). "In sessions with several people, credit everyone credited on the commit":
  each person named as a co-author (an automatic save names whoever changed the document since the
  last one) is given all of it; a commit naming none, its author. "For words written, show net and
  added as separate text": **net**, how many more words there are, and **added**, the words written,
  each word counted as many more times as it appears now than before, so a rewrite counts and a move
  does not (`wordChange` in the kernel). What is typed and not yet committed, in documents open on this
  host, is added for today, for whoever typed it. A commit never changes, so what it counts is kept
  (`.git/kuraa/words.json`) and counted once. The host gives it as `GET /api/words?since=`; components,
  `host.wordsByDay(since)`. The menu's foot says your total today (net); the panel, yours (net and added)
  and everyone's today, and your last seven days. **A target for a day**, in words added, is yours,
  kept in this browser, as Scrivener's session target is the writer's.
  What it cannot see: a folder only some read is kept in its own space (0069), off the branch, and is
  not counted; a file made through Kuraa is saved naming no one (it is empty until written in, in its
  room, where saves name who typed).

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
