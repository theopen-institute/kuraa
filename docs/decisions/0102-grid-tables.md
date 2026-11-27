# 0102 · Several lines in a table's cell: grid tables

**Status: built.** A table's cell may hold several lines: Shift+Enter breaks a line in it, as it
does in a paragraph. A table with such a cell is written as a Pandoc **grid table**.

The owner asked for cells with more than one line. Kuraa wrote every table as a pipe table
(`| a | b |`), whose cells are a line each: a line break typed in a cell was written as a space (a
backslash and a space, in fact: a non-breaking space to Pandoc), so it was lost on the way to the
file. Asked whether a table may change form in the file once a cell has a line break, the owner
chose the grid table, the more robust and more flexible of Pandoc's tables.

## What is decided

**Written.** A table is written as a pipe table, as before, unless a cell has lines: a line break,
or text over several lines (as a grid table read from a file has). Then it is a grid table:

```
+------+-------+
| Site | Notes |
+======+=======+
| Kew  | wet\  |
|      | cold  |
+------+-------+
```

Each line of a cell in its column, a line break ending its line with `\` (Pandoc's hard line break),
the first row the header (`=` under it, with `:` for its columns' alignment, as a pipe table has
them). A break at the very end of a cell, or a line with nothing on it, has no markdown form there
and is not written. Columns are counted as Pandoc counts them (an East Asian character two wide).

**Read.** A grid table is read as a table where the editor can hold it: one header row, no cell
spanning rows or columns, no footer, each cell a paragraph at most (its lines and line breaks kept).
Each cell is read as a small document of its own, so a cell that needs the rest of the document to
be read as Pandoc reads it (a footnote's reference, a link to a reference given elsewhere) keeps the
table as it is written. Any other grid table stays as it is written (raw, as before). A caption
before or after it is kept with it, as a pipe table's is.

**Widths kept.** Pandoc makes a grid table's columns as wide, relative to each other, as their dashes
are. So the table keeps the widths it was read with (`widths`, a new attribute of `table`), and is
written with them: a column widens only when a line no longer fits it. A table read from a grid table
is written as one again, line breaks or not. An unchanged table is written back byte for byte, as
every unchanged block is.

**Elsewhere.** Adding or deleting a column keeps the other columns' widths. The places of a grid
table's text in the file are found in order (`sourceMapOf`), and a cell's lines are not in order in
the file (a row's lines run across its columns), so an annotation in a cell of several lines may be
put a little out. The format's version is 4 (`PANDOC_VERSION`): devices of another version merge
grid tables differently, and do not share rooms.

**Found on the way.** A file starting with its YAML header and holding a simple or multiline table
further down was read as raw from the header to that table: the header's opening `---` was taken for
a multiline table's first rule. The header is now passed over when looking for those tables. And a
heading's closing `#`s before its attributes (`## Title ## {#id}`) are no longer kept as text, as in
Pandoc.
