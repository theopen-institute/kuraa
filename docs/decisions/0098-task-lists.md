# 0098 · Task lists

**Status: built.** Markdown's checkboxes (`- [ ] To do`, `- [x] Done`, as Pandoc and GitHub write
them) are edited as checkboxes in a Markdown or R Markdown document.

The owner asked whether the editor supported them, and if not, to make it. It half did: a task was
read from the file and written back as it was, but drawn as a plain bullet, its box neither shown nor
to be ticked, and there was no way to make one but in the Source view.

## What is decided

**A box where the bullet was**, before each task item, ticked and unticked by a click (the editor's
cursor staying where it was), the change saved as any other. A task done has its text quieter. Where
the document is read only, the boxes are shown but cannot be clicked. The box is drawn by the editor
(a widget before the item's content), not part of the document: the item keeps its `checked`
attribute (`null` for an ordinary item), as before.

**Typed.** `[ ] ` (or `[] `) or `[x] ` at the start of a list item makes it a task, not done or done;
so `- [ ] ` at the start of a line makes a list of tasks. Typed in an empty task (the one Enter just
made), it is ticked or not as typed. Elsewhere it is text, as in the file.

**Enter** in a task makes a new task, not done, whether the one before is done or not (at the very
start of a task, the new empty one before it is the one not done). Enter in an empty task leaves the
list, as in any item.

**Backspace** at the start of a task takes its box away, the item kept as an ordinary one; Backspace
again then takes it out of the list, as before. Just after a cue is typed, Backspace gives back the
cue's text, as for every other cue.

**Pasted**, a task stays one: from Kuraa (`data-checked`), or with a checkbox in the item (GitHub's,
or another page's).

The shortcuts sheet (⌘/) lists the cue, under Blocks.
