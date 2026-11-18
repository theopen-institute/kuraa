# 0022 · Documents are known by their title; filenames are made from it

Every document (Pandoc markdown, R Markdown) has a title: the `title` field of its header. The
sidebar, the window and the menu show it; text and source files are shown by filename. A document
is created with a title, and its filename is made from the title.

**Titles.**

- A document type says it has titles with `DocumentType.title` (`@kuraa/kernel`): `read(text)`
  and `write(text, title)`. Pandoc's (`pandocTitle`, shared by R Markdown) reads the header's
  `title` without parsing the whole document, and writes only that field, first when it is new.
- The host lists files with their titles (`GET /api/tree`: `title` for documents, null if one has
  none). An open document's title comes from its live text; others' from the file, read again
  only when the file changes. The open document's title updates in the sidebar as it is edited.
- A document without a title (one made elsewhere) is shown by its filename, dimmed. The Header
  dialog always has a Title field, first if it was missing, and does not save without one.

**Filenames** are made once, when the document is created (`filenames.ts`):

- lowercase ASCII letters and digits, words joined by hyphens: accents dropped (é → e, ß → ss),
  apostrophes dropped, other punctuation a word break;
- at most 60 characters, cut at a word;
- never a name Windows reserves (`con`, `nul`, `com1`, …), never a leading dot or hyphen;
- unique in the folder whatever the extension or case (a number added: `notes-2.md`);
- `untitled` for a title with no Latin letters or digits.

Why: case-insensitive file systems (macOS, Windows) cannot hold names that differ only in case,
and git then sees two files; macOS and Linux store accented names differently (NFD and NFC), which
git treats as different files; spaces and punctuation need quoting in shells and URLs, and
underscores are special in LaTeX; Windows reserves some names and limits paths to 260 characters.
`notes.md` and `notes.Rmd` would both render to `notes.html`, so the number is per name, not per
extension.

**Changing a title does not rename the file.** Links to the file from other documents, includes,
R code that reads it, and git history keep working. **Rename…** on a document shows its title and
its filename: while the filename is the one its title makes, it follows the title as it is typed;
otherwise it stays as it is, and **Match the title** makes it follow. Both change in one commit
(`PATCH /api/files` with `title`; with `to` equal to `from`, only the title). A new title for a
document that is open reaches everyone editing it as an ordinary edit.

Text and source files are created and renamed by filename, as before; typing a known extension
chooses the type.
