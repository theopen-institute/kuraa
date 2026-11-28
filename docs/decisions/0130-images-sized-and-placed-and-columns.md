# 0130 · Images sized and placed, and columns

**Status: built.** Adds to [0040](0040-writing-in-the-editor.md) (images in the editor) and
[0107](0107-rendering-without-podman.md) (what the renderer does to pandoc's tree).

The owner asked for a way to resize and position images that stays within Markdown, "Notion does this
particularly well", and whether Markdown has columns. Offered Pandoc's attributes and fenced divs,
resize handles, a placement bar, columns made by dragging and an export pass that keeps them, they
said: "Yes, do all that".

## In the file: Pandoc's syntax, Quarto's names

Plain Markdown (CommonMark, GitHub's) has neither image sizes nor columns. Pandoc, whose Markdown
documents already are, has both, and Quarto reads the same:

```markdown
![The coast at dusk](report.md.files/coast.jpg){width=60% fig-align=right}

:::: columns
::: {.column width=40%}
Words beside the picture.
:::

::: {.column width=60%}
![](report.md.files/chart.png)
:::
::::
```

- **Width** is a whole percentage of the line (of the column, in a column): the editor writes
  `{width=60%}`. Any width or height Pandoc reads is shown (`300` is pixels, `4cm`, `2in`).
- **Place** is Quarto's `fig-align` (`left`, `right`), for an image alone in its paragraph (Pandoc's
  figure when it has a caption). None is centred, so centring writes nothing.
- **Columns** are Pandoc's and Quarto's: a `columns` div holding a `column` div for each, its
  `width` a share of the line. The editor writes the outer fence one colon longer (`::::`), as
  Pandoc's manual does, values bare where they can be (`width=40%`; Pandoc reads both).
- The rest of an image's or a div's attributes are kept as they were (`attributes.ts` reads and
  writes them, a part at a time).

Other Markdown apps show `{width=60%}` as text and the divs as lines of colons; Obsidian sizes images
another way (`![alt|300](src)`) and GitHub only HTML's `<img width>`. Pandoc's is the syntax every
export here goes through, so it is the one followed.

**An image alone on its line is centred** unless it says otherwise: in the editor (it was at the
left) and in every export, as PDF and Word already centred a figure with a caption. One in a line of
text stays in the line.

## In the editor

- **Resizing.** A selected image has a handle at the middle of each side. Dragging one makes it
  narrower or wider (both sides move when it is centred), its width shown as it goes, and written in
  whole percentages when let go. A height it had goes, so it keeps its shape.
- **The bar.** Above a selected image: **Left**, **Centre**, **Right** when it is alone on its line;
  **Own size** when it has a width or height; **Describe…** (its alt text, as a double-click). The
  handles and the bar are its own, not the editor's: nothing on them moves the cursor or starts a drag.
- **Columns made by dragging.** Something dragged (an image, selected words or paragraphs) and dropped
  near the left or right edge of a paragraph (a fifth of its width, 64 pixels at most) puts the two in
  columns, half the line each; a line shows where it will go. Dropped at the edge of a block in a
  column, it is a column of its own there, and the columns are made even. An image alone in its
  paragraph takes the paragraph with it. Columns are not put in a column, and nothing is put beside
  itself.
- **Widths dragged.** The gap between two columns (a line in it on hover) is dragged to share their
  width otherwise, neither under a tenth, both shown as it goes.
- **Columns tidied.** A column a drop empties goes, the others widened to keep their proportions;
  Backspace in an empty column takes it away; columns down to one are its content again; columns last
  in the document have a paragraph after them, to write below. Backspace at a column's start and
  Delete at its end do nothing else, not joining one column's words onto another's. Only one's own
  changes are tidied: everyone tidies theirs, so two devices never both add the paragraph after.
- **Typed.** `{width=50%}` typed straight after an image becomes its attributes (with those it had),
  as Pandoc reads it there; `::: columns` on a line, then Enter, is two empty columns, the cursor in
  the first (not in a column). For the keyboard, both are in the Markdown and shortcuts sheet.

Read only, images are placed and columns side by side as in the editor, without handles or gaps to drag.
`PANDOC_VERSION` is unchanged: no node or attribute is new (an image's attributes and fenced divs were
already kept), and a device without this shows the columns one after the other and keeps the text.

## When exported

pandoc carries an image's width into every format, but writes `fig-align` only as a class or data in
HTML, and columns one after the other except in slides. So the renderer changes pandoc's tree before
pandoc writes the format (`layout.ts`, `layOut`), as it already points images at their copies:

| | An image placed | Columns |
| --- | --- | --- |
| HTML, EPUB | `text-align` on the figure (no side margins), or on a div around a paragraph of an image alone | `display: flex` on the set, each column `flex: <width> 1 0` |
| PDF (Typst) | a figure under `#show figure: set align(…)` (Typst centres a figure itself, and `#align` around one does nothing); an image without a caption under `#align(…)` | `#grid(columns: (40fr, 60fr), column-gutter: 1.5em, …)` |
| Word | a paragraph style for each place, **Image Left**, **Image Centre**, **Image Right** and **Image Caption Left**/**Right**, which pandoc makes and the renderer then aligns in `styles.xml` (one a Word template already aligns is left as it is) | a table of one row and no header (so none of the Table style's rules), each cell a column's width |

In Word an image's percentage is of the page, not of its cell, so an image in a column is given its
share of the column, and one without a width the column's whole width, as the editor shows it no
wider than its column.

R Markdown documents and PDFs a header asks LaTeX for are rendered where code runs (0107), by the R
image's pandoc, which this pass does not reach: there, widths are kept, and places and columns are as
pandoc writes them (columns one after the other).
