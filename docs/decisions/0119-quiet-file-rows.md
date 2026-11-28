# 0119 · Quiet file rows

A file's row in the file list showed two buttons on hover, ✎ Rename and ✕ Delete
([0044](0044-polish.md)). They came up under the pointer on every pass over the list, over the end
of the name and the row's marks, and put a delete one click from a stray one. They are gone:

- **A file is renamed and deleted from its right-click menu** (Rename…, Delete…), or with F2 and
  Delete (⌘⌫ on a Mac) on the focused row, as before.
- **A folder's row keeps its buttons** (＋, a new file in it), on hover and while it has focus.
- A file with conflicts no longer needs its buttons hidden to keep the count clickable.

The synopsis box on a corkboard card had a resize grip, though the card's height is set by the
grid, so dragging it did nothing. It has no grip now (`resize: none`).
