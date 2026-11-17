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

As in Pandoc, an emphasis cue needs text that neither starts nor ends with a space, and an
underscore inside a word does not start one. The keyboard shortcuts stay (⌘B, ⌘I, ⌘E and so on).

The command list in `packages/client/src/commands.ts` is kept and still drives the shortcuts, so a
toolbar, palette or other interface can be added on top of it later.

The workspace name, branch and head moved to the tooltip on the connection indicator. Source,
Save version, History, Sync and Settings are quiet links at the right of the status bar. The
history sidebar starts closed.

**Footnotes.** The editor shows each reference and note with the number a reader will see:
Pandoc numbers notes in the order their references appear (inline notes included), whatever
their labels, so the labels in the file are left alone and an edit never relabels other notes.
The label shows on hover. Hovering a reference shows the note; ⌘-click goes to it. Notes show
below a rule with their number in the margin: click it to go back to the reference, double-click
to rename the note and every reference to it. Inline notes (`^[…]`) are chips; double-click to
edit. New footnotes (⌥⌘F) are labelled one past the highest number in the file.

**Renumber notes** (in the status bar, shown only when it would change something) is the one
deliberate edit that tidies the source: it relabels notes 1, 2, 3 in order of first reference
(references inside notes included), moves the top-level notes to the end of the document in that
order, and puts notes nothing refers to last. The file holds ordinary Pandoc footnotes throughout.
