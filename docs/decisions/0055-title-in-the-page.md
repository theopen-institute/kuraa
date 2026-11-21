# 0055 · A Pandoc document's title is shown, and typed, in the page

The header stays out of the page ([0021](0021-document-header.md)), but its **title** is the page's
top heading: what the sidebar and the window call the document is what you see first, and you
change it where you read it.

- **Drawn by the header's node view** (`headerView` in `format-pandoc/src/editor/header.ts`): the
  `front_matter` block, once drawn as nothing, is drawn as an `h1.doc-title` holding the title. The
  heading is not part of ProseMirror's document: it is an element of its own that can be typed in,
  whose events ProseMirror leaves alone. The block itself still keeps the cursor out, and typing in
  the page still cannot change it.
- **Written to the `title` field alone** (`writeTitle`): each change sets the header's title with the
  same YAML code as the sidebar's rename (`withTitle` in `title.ts`: comments, order and quoting
  kept), and replaces only the characters that changed, as a deliberate edit, so another person's
  edit to another field merges with it. While the heading is being typed in, changes from elsewhere
  do not overwrite it; it takes the header's title again when it loses focus.
- **No header yet**: an empty heading (a widget at the top, saying "Title") to type in; the first
  character makes the header, holding only the title, and the cursor stays in the heading.
- **Keys**: Enter, Tab or ↓ in the title goes to the start of the text; ↑ at the start of the text
  goes up to the title. Pasting puts in plain text on one line.
- A header that is not a list of fields shows its title, if any, but it cannot be typed in (Document
  settings, or the Source view, can fix the YAML). Read-only views (past versions) show the title and
  nothing more.

Clearing the title writes `title: ""`: the sidebar shows the filename again, and Document settings
asks for a title before saving there.
