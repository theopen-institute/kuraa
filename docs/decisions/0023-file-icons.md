# 0023 · File icons are defined by document types

Each file in the sidebar has a small icon, and its document type defines it: `DocumentType.icon(path)`
(`@kuraa/kernel`) returns a `FileIcon`, a few strokes in a 16×16 box as SVG path data. The client
draws every icon alike (thin lines in the muted text colour, no fill, a little stronger on the open
file), so a format added later fits in without styling of its own, and an icon is data, never
markup put into the page.

- Pandoc markdown: a page with lines (`DOCUMENT_ICON`; `createPandocType` takes another).
- R Markdown: a page with a line and a code chunk.
- Text files: by what the file holds, from the text format's file rules (`FileRule.icon`,
  `textIcons`): braces for scripts and programs, a prompt for shell scripts, a table for data,
  sliders for settings, an open book for bibliographies and citation styles, a sigma for LaTeX,
  angle brackets for markup, lines for plain text.
- A file no type opens: a dot.
