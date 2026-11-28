# 0132 · Deleting several rows of a table at once

From feedback: a table's rows could be deleted only one at a time, a right-click each. A table's
right-click menu ([0102](0102-grid-tables.md)) acted on the cell the cursor was in, and the
right-click itself put the cursor where it landed, so no selection survived to the menu.

Now a selection made over several rows deletes them all at once: drag across them, Shift+click,
or Shift+arrows, then right-click inside it (or Shift+F10) and choose **Delete 3 rows**.

- **Rows:** every row from the one the selection starts in to the one it ends in, the header row
  too (the next row becomes the header, as when it is deleted alone). The cursor goes to the row
  after them.
- **Columns:** a selection over several cells of one row deletes those columns: **Delete 2
  columns**, their alignments and a grid table's widths with them. Over several rows, a text
  selection is not a rectangle of cells, so **Delete the column** stays the column it starts in.
- **All of them:** a selection over every row, or every column, deletes the table, as deleting the
  last row or column did.
- **The right-click keeps the selection** when it lands inside one that spans more than one cell;
  elsewhere it moves the cursor as before. Inside such a selection there are no spelling
  suggestions: the menu is for its rows and columns.
- **The menu says how many:** *Delete 3 rows*, *Delete 2 columns*; *Delete the row* and *Delete
  the column* for one.
- Not added: selected rows deleted by Backspace or Delete. Those keys keep editing the cells'
  text, as a selection over part of two rows is as likely to be text to clear.
- `spanAt(state)` (the rows and columns a selection spans) is exported beside `cellAt`.
