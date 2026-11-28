# 0040 · Writing in the editor: citations, images, math, tables, find, the outline

*Since [0106](0106-images-in-git.md): images pasted or dropped are shown in a dialog first (their size
as kept, smaller sizes, their description), and every image is kept with its details removed (where it
was taken, the camera, when, who, thumbnails, what is appended); the 20 MB limit is on the image as kept.
Since [0107](0107-a-documents-own-files.md): they are kept in the document's own folder, `report.md.files/`, not `images/`.*

The editor had the schema for citations, images, tables and display math, but nothing to make
them with, and typing `[@smith2020]` saved `\[\@smith2020\]`. This adds what a researcher writing
a paper reaches for, keeping [0008](0008-markdown-cues.md): no toolbar, everything from typing,
keys and the menu. Each is in the Pandoc editor module ([0012](0012-format-editor-modules.md))
unless it is generic (find, the outline), which is the client's.

**Citations** (`format-pandoc/src/editor/citations.ts`). A citation is a node holding its markdown
as written, so the file always gets back exactly the Pandoc citation: `[see @a, p. 3; -@b]`,
`@a`, `@a [p. 3]`. Typing makes one: the closing bracket of a bracketed citation, a space or
punctuation after an in-text key, the closing bracket of a locator after an in-text citation, or
Enter. Backspace straight afterwards turns it back into text, which is written escaped (`\@a`), as
Pandoc then reads it. This is the rule: what the editor shows as a citation is what Pandoc will
read as one, and text it shows as text stays text. An `@` after a letter or digit is never a
citation (emails are left alone), as in Pandoc. Keys may contain any letters (`@müller2019`), as in
Pandoc; the parser and the escaping now agree on that, and the parser reads `@a [p. 3]` as one
citation rather than a citation and a bracket.

Typing `@` (alone or inside brackets) opens a picker of the document's bibliography: the files
`bibliography:` in the header names (one or a list, relative to the document), and `references:` in
the header itself. Entries show as "Author (Year) Title", found by key, author, title or year;
arrows choose, Enter or Tab takes, Escape closes. Inside brackets a pick completes the key, and the
bracket is closed by typing; elsewhere it makes the citation at once. The readers
(`format-pandoc/src/bibliography.ts`) are small and forgiving: BibTeX and BibLaTeX (key, family
names, year or date, title; `@string` macros, braces and common TeX accents), CSL JSON and CSL
YAML. An entry they cannot read is skipped. The bibliography is read when the document opens, when
the header changes, and again when the picker opens after a while.

Citations show as chips naming what they cite, "Smith 2020", "(see Smith 2020, p. 3; 2019)", with
the entries in the tooltip; double-click edits the markdown. A key the bibliography does not have is
marked, but only when a bibliography was read: without one, keys are shown as written.

**Images** (`editor/images.ts`, the host's `writing.ts`). `![alt](src)` typed becomes an image. An
image file pasted or dropped is uploaded (`POST /api/images?doc=…&name=…`, the bytes as the body)
and kept in `images/` beside the document, under a safe filename (lowercase words and dashes) not
yet taken (`plot-2.png`); the same image again reuses its file. It is committed with the person as
co-author. Only PNG, JPEG, GIF, WebP and SVG are taken, known by their bytes, not their name, and
none larger than 20 MB; nothing is added while git is busy outside the app (0037). Images display
by fetching the file from the host (`GET /api/raw?path=…`, with the token in the header, never in
an address) and showing it from an object URL; web addresses show as they are, anything else
([0018](0018-untrusted-users.md)) not at all, and a missing file says so. `/api/raw` serves a
workspace file with its type (`nosniff`; a type it does not know is a download), inside the
workspace only, never through a link (`host.resolvePath`), and never anything but a plain file. An
SVG is only ever an `<img>`, never put in the page, so nothing in it runs.

**Display math.** `$$` on a line of its own, then Enter, starts a display math block (the
`math_display` node, written `$$ … $$`), edited as LaTeX like a code block; `$$x$$` within a line
is display math there. Inline `$x$` is unchanged.

**Tables** (`editor/tables.ts`). Pipe tables, as the schema had them: a header row, then rows.
`| a | b |` then Enter makes a table with those headings and a row to type in; **Insert table** in
the menu makes an empty one. Tab and Shift+Tab move between cells (Tab in the last cell adds a
row), Enter moves down (adding a row at the bottom), ⌘Enter leaves the table. Right-click a cell
(or Shift+F10) to add a row above or below, a column left or right, or delete the row, the column
or the table. prosemirror-tables was not used: it needs cells with spans and widths and a separate
header-cell node, which pipe tables cannot express and which would change the schema. Every change
rebuilds the table, so the first row is always the header and the alignment keeps a letter per
column; each is one ordinary edit.

**Find and replace** (`client/src/find.ts`, `FindBar.vue`). ⌘F (Ctrl+F) opens a bar over the
page, starting from the selected text: the count ("2 of 7"), next and previous (Enter, Shift+Enter,
⌘G), case, and Replace or Replace all. Matches are found in the text, not in code blocks (they
have their own editors) nor across a chip, and highlighted with decorations only this view sees.
Replacing is an ordinary transaction, so it reaches everyone like typing, and the matches are found
again after every change, whoever made it. In the Source view, ⌘F opens CodeMirror's own search
and replace (`@codemirror/search`), whose replacements are ordinary source edits.

**The outline** (`client/src/outline.ts`, `OutlinePanel.vue`). ⌥⌘O (Ctrl+Alt+O), or **Outline** in
the menu, shows the document's headings in a small panel over the page, indented by level, the one
the cursor is under marked; it follows the document as anyone edits it. Click (or arrows and
Enter) goes to a heading. Escape closes it.

**Conflicts.** Clicking a file's "N conflicts" in the sidebar opens it at its first conflict;
⌥⌘N (or **Next conflict** in the menu) goes to the next one, round to the first. A version's label
says who and when ("Ada, 3 November at 14:05"): the commit's date, asked of the host
(`GET /api/commits/<hash>`), with the short hash until it answers or if it cannot. The conflict
block itself is unchanged, so merges stay the same on every device.

**The contract.** `EditorContext` gained `path` (the document's) and `files` (`WorkspaceFiles`:
a file's text, an image's address, uploading an image, a commit's author and date), absent for a
past version; `EditorUi` gained `notify`. `FormatEditor` gained `commands(ctx)`, named commands the
client offers in its menu (`insertTable`, `nextConflict`). The menu shows **Find and replace…**,
**Outline**, **Insert table** and, where there are conflicts, **Next conflict**.

**Not done.** Citations are not checked against the citation style (they show author and year
whatever the CSL); a bibliography in a format other than BibTeX and CSL (EndNote, RIS) is not read;
tables have no alignment control in the editor (alignment written in the file is kept); images
cannot be resized; find does not search inside code blocks or the header.
