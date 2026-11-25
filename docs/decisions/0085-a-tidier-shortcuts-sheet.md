# 0085 · Markdown and shortcuts: one row for each thing

> Changes how the Markdown and shortcuts sheet ([0044](0044-polish.md)) is laid out and how its
> lines are written. Where its contents come from is as before: each editor module's `help`, built
> beside its key bindings, and the client's `APP_KEYS` ([0008](0008-markdown-cues.md),
> [0040](0040-writing-in-the-editor.md)). The test that every bound key is named still holds.

The owner's direction:

> "The cmd-/ menu for shortcuts and markdown is a hot mess. Tidy it up dramatically. Make it
> clearer and easier to read."

The sheet listed what to type and what to press in different sections: `**bold**` under Typing,
⌘B under Keys, and so on for a dozen things. Lines were sentences with their exceptions in
brackets. Seven groups of different lengths sat in an auto-fit grid, each table sizing its own
columns, so nothing lined up and the sheet scrolled for about 1,700 pixels.

## One row for each thing

A `HelpItem` may now have both a cue (`type`) and `keys`, and one line says what the thing is, in
a word or two (**Bold**, **Block quote**, **Footnote**). Each row reads across: what it is, what
to type for it, and the keys for it. A cue that takes effect with Enter says so with `enter`, and
the sheet shows it as `` ``` `` *then* ↵ rather than writing "then Enter" into the cue. What used
to go in brackets is a `note`, shown quietly under the name (*in a table; or right-click*). A note
may name a key in braces (`{Mod-Click}`), which is shown for the system (⌘Click, Ctrl+Click).
Headings 1 to 3 show their keys as one, ⌥⌘1–3.

Pandoc markdown's lines are in four groups: **Text** (bold, italic, struck through, code, link,
sub- and superscript), **Paragraphs** (headings, plain paragraph, lists, quote, code block, the
line across the page), **Notes, citations, math** (footnotes, inline notes, citations, images,
math, tables) and **Editing** (keys that work in lists, notes, code blocks and tables, and the next
conflict). The Backspace line went: the sheet's opening line says it once ("Backspace straight
after turns it back").

The client's keys are in **Finding your way**, **Code chunks**, **Undo, settings, help** and
**File list**. A module's line whose group has the title of one of the client's is listed in it,
first: R Markdown's **New R chunk** (`` ```{r} `` then ↵, ⌥⌘I) is with the keys that run chunks,
under Code chunks, instead of in a group of its own.

## Two columns, aligned, and a filter

Writing (the editor modules' and features' groups) is in the left column and the app's keys are
in the right. Each column is one table, so its columns line up from group to group. Rows are ruled
lightly. The heading stays in place while the body scrolls. Below 760 pixels the columns stack.

A **Filter** box, focused when the sheet opens, narrows the rows to those whose name, note, cue,
keys (as shown) or group has every word typed. Groups with nothing left are hidden, and the
columns keep their places. Escape still closes the sheet, and focus goes back where it was.
**Close** moved from the foot of the sheet to its heading.

## Where it is

`HelpItem` in `packages/editor-kit/src/index.ts`; `PANDOC_HELP` in
`packages/format-pandoc/src/editor/index.ts`; R Markdown's line in
`packages/format-rmarkdown/src/editor/index.ts`; `clientHelp`, `helpSheet` and `helpMatches` in
`packages/client/src/help.ts`; the sheet in `packages/client/src/HelpSheet.vue`. Tests:
`packages/client/test/polish.test.ts`, the two `editor-help.test.ts` files, and
`tests/e2e/polish.spec.ts` (one row with both cue and key, the filter, Escape).
