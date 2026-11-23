# 0074 · The document's ⋯ menu is a menu

> Changes how [0065](0065-no-menu.md)'s ⋯ shows what is in it. What is in it is as before.

The owner's direction:

> "Make the ... document menu be a more conventional menu. The buttons are confusing."

The ⋯ menu was a panel of buttons in rows, each row a kind of thing, with headings and facts among
them: buttons that toggled (Edit the source / Show the document, History / Hide history) looked like
those that act, and nothing said what each row was. It is a menu now, as the file list's right-click
menu is (`role="menu"`):

- **One item a line**, in groups with a line between: the views (**Source** and **History**, ticked
  when shown, `menuitemcheckbox`; **Preview**); writing (**Find and replace…**, **Outline**, **Insert
  table**, **Next conflict**); **Save version…**; the code session (its state above its items, **Run
  all**, **Interrupt**, **Restart**, **Packages…**); the document's own (**Permissions…**, **Document
  settings…**, **Markdown and shortcuts**).
- **Each item's keys** at its right, where it has any.
- **When it was last saved** and kept in the history, in a quiet line at the foot, not an item.
- **Arrow keys, Home and End** move between items; Escape, a click outside or choosing one closes it,
  focus going back to ⋯.

The document's name is no longer its heading: it is open in front of you (the menu is named for it,
for screen readers).
