# 0106 · A book's own settings, and EPUB

**Status: built.** Compile ([0093](0093-order-and-compile-over-folders.md)) makes EPUB as well as
Word, PDF and HTML, and a book has settings of its own: a subtitle and an author, a table of contents,
numbering, what goes between scenes without titles, a Word template and a cover. So does a single
document's **Export…** ([0100](0100-export.md)), which now offers EPUB too.

The owner, asking what came next for parity with Scrivener, was offered Compile filled out first:
the gaps a writer meets the first time they compile a whole book. Scrivener's compile formats give
the title page, the front matter, a table of contents, chapter numbers ("Chapter One") and a scene
separator ("#") between scenes that have no titles. Its outputs include ePub. The owner: "continue
developing compile in this way".

## What is decided

**EPUB is a fourth format**, everywhere a document or folder is rendered (`RenderFormat` gains
`epub`; `application/epub+zip`). Pandoc makes it (EPUB 3, math as MathML, images inside). An R
Markdown document is knitted to it as to the others, its chunks run, or rendered with the output
format its header names (`bookdown::epub_book`).

**A book's own settings are kept with the folder**, in its `.kuraa-compile.yml`, beside its title and
format. Each is saved as it is changed in the panel, as one edit everyone sees. The host half runs one
change at a time, since each reads the file, changes it and writes it, and two at once lost one.

| In the panel | In `.kuraa-compile.yml` | What the book gets |
| --- | --- | --- |
| Subtitle, Author | `subtitle`, `author` | its title page (pandoc's, in every format) |
| Table of contents | `toc: true` | pandoc's `--toc` |
| Numbering: Chapters | `numbering: chapters` | its top-level headings as *Chapter 1: …*, *Chapter 2: …* |
| Numbering: Every heading | `numbering: sections` | pandoc's `--number-sections` (1, 1.1, …) |
| Between documents without titles | `separator: "#"` | see below |
| Word template (Word only) | `reference-doc: templates/house.docx` | its styles (pandoc's `--reference-doc`) |
| Cover image (EPUB only) | `cover-image: art/cover.jpg` | the EPUB's cover |

*Chapters* counts the book's top-level headings, whatever made them (a folder's name, a document's
title, a document's own `#`), outside code. A heading marked unnumbered (`{-}`, `.unnumbered`) is
skipped, as pandoc skips it. The word is English, as the app is.

**A Word template or cover is a file in the workspace**, chosen from those there (the workspace's
`.docx` files; its PNG, JPEG, GIF, SVG and WebP images: Compile's `GET files`), and named by its
path in the workspace. Renamed or moved, or the folder it is in, it is followed there. Deleted, it is
forgotten. The host copies it beside the joined book in scratch (`reference.docx`, `cover.<ext>`),
as the workspace is read-only to the render. One that is gone when the book is compiled stops the
compile, saying so.

**A folder's documents may have no titles** (`titles: false` in its own `.kuraa-compile.yml`; the
**Titles** switch on its row in Compile's outline, beside **Heading**; for the folder compiled, a
switch below the outline when it has documents of its own). This is Scrivener's novel layout: a
chapter folder whose name is its heading, and scenes that run on under it. Such a document gives no
heading and no level (the outline shows `–`). Its own headings go below its folder's.

**Between two documents with no heading between them**, the book's separator: nothing (as before),
a rule where it is one in Markdown (`* * *`, `---`, `___`), or any other text, centred, as it is
typed (`#`, `~`; its Markdown escaped). The text is a paragraph in a div of class `scene-break`
with the Word style *Scene break*, which a Word template may define.

**The renderer reads these from the joined book's header**, as Quarto has them at a header's top level
for every format: `toc`, `number-sections`, `reference-doc` and `cover-image` (beside the document).
So a single document's header may say them too. Before, only `output:` (R Markdown) and `format:`
(Quarto, by format) did. `RenderRequest` is unchanged. The host's compile is asked for them
(`POST /api/renders`: `noTitles`, `subtitle`, `author`, `toc`, `numbering`, `separator`,
`referenceDoc`, `cover`; components: `host.renders.render(folder, format, CompileRequest)`). It gets
the format, to copy only what that format uses.

All of this is additive. An older app reads a `.kuraa-compile.yml` with these fields and passes over
them, and drops them when it next writes the file.

### Not yet

- Front matter other than the title page, such as a dedication or an epigraph kept apart from the
  chapters. A document whose heading is marked `{-}` comes nearest.
- A top level as real parts in a LaTeX PDF (`--top-level-division=part`).
- Numbers written as words (*Chapter One*), or a chapter's number and title on separate lines.
- A PDF template, or LaTeX and Typst settings (margins, fonts) chosen in the panel.
- Kindle's own formats. Amazon takes EPUB.
