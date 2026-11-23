# 0008 · No toolbar or top bar; formatting comes from typing markdown

The spec's client has a formatting toolbar and a header. The editor is meant to be as quiet as
possible, so neither is shown. Formatting comes from typing markdown, which is converted as it is
typed, and Backspace straight afterwards turns a conversion back into the typed text:

| Type | Get |
| --- | --- |
| `# ` … `###### ` at the start of a line | Heading |
| `> `, `- ` / `* ` / `+ `, `1. ` | Block quote, bullet list, numbered list |
| ```` ``` ```` or ```` ```lang ```` then space or Enter | Code block |
| ```` ```{r label} ```` then space or Enter (R Markdown) | Code chunk |
| ```` ``` ```` on the last line of a code block, then Enter | Leave the block (or ⌘/Ctrl+Enter anywhere in it) |
| `---`, `***` or `___` on an empty line | Horizontal rule |
| `**bold**`, `__bold__`, `*em*`, `_em_`, `~~strike~~` | Strong, emphasis, strikeout |
| `` `code` ``, `H~2~O`, `x^2^`, `$tex$` | Inline code, subscript, superscript, inline math |
| `[text](url)` | Link |
| `[^label]` | Footnote reference; if the note does not exist yet, an empty one is added at the end with the cursor in it |
| `^[text]` | Inline note |
| ⌥⌘F (Ctrl+Alt+F) | A numbered footnote and its note |
| `[@key]`, `[see @a, p. 3; -@b]`, `@key` then a space, `@key [p. 3]` | Citation; typing `@` offers the bibliography's keys ([0040](0040-writing-in-the-editor.md)) |
| `![alt](src)`, or paste or drop an image file | Image (a file is kept in `images/` beside the document) |
| `$$x$$`; `$$` on a line of its own then Enter | Display math, in the line; a display math block |
| `\| a \| b \|` then Enter | Table with those headings (Tab, Shift+Tab, Enter and right-click in it) |
| ⌘F, ⌥⌘O, ⌥⌘N (Ctrl+F, Ctrl+Alt+O, Ctrl+Alt+N) | Find and replace, the outline, the next conflict |

As in Pandoc, an emphasis cue needs text that neither starts nor ends with a space, and an
underscore inside a word does not start one. The keyboard shortcuts stay (⌘B, ⌘I, ⌘E and so on).

The command list in `packages/client/src/commands.ts` is kept and still drives the shortcuts, so a
toolbar, palette or other interface can be added on top of it later.

The workspace name, branch and head moved to the tooltip on the connection indicator. Source,
Save version, History, Sync and Settings are quiet links at the right of the status bar. The
history sidebar starts closed.

**Footnotes behave as in a word processor.** Pandoc numbers notes in the order their references
appear (inline notes included), whatever their labels, so the editor shows those numbers and
treats labels as fixed ids that are never rewritten; cut and paste therefore keeps a reference and
its note together. A new note is put among the notes in number order; notes already there are
never moved by an edit, since moving a note deletes it and puts it back, and someone typing in it
at that moment would lose what they typed ([0075](0075-review-fixes.md)). Notes nothing refers to
are marked "–"; clicking that offers to delete them. (Until 0075 the notes were rearranged into
number order after each of the user's own edits.)

While typing in a note, **Enter goes back to the text**, just after the reference, and
**Shift+Enter starts a new paragraph** in the note (elsewhere, Shift+Enter is a line break). In a
note nothing refers to, Enter behaves as usual.

The label shows on hover. Hovering a reference shows the note; ⌘-click goes to it. Click a note's
number to go back to the reference; double-click to rename the note and every reference to it.
Inline notes (`^[…]`) are chips; double-click to edit. New footnotes (⌥⌘F) are labelled one past
the highest number in the file. The file holds ordinary Pandoc footnotes throughout.

*Revised:* an earlier version left notes where they were and offered a "Renumber notes" command
that rewrote labels. Rewriting labels breaks cut and paste of references, and the command was one
more thing to know about; automatic arrangement replaced it.
