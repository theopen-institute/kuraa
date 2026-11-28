# 0100 · Export…

*Since [0114](0114-export-is-the-one-item.md): **Export…** is the menu's only item for Preview, and it renders the page too; the panel is headed **Export**.*

**Status: built.** The open document's ⋯ menu has **Export…**, in Preview's group under
**Preview**.

The owner reported that exporting a document as a PDF seemed to have gone. It had not: since Preview
became a component ([0089](0089-preview-search-and-outline-are-components.md)), saving a document as
a PDF, Word or HTML file was **Preview** on the ⋯ menu, then **Save as** in its panel, and nothing on
the menu said so any more. Asked to choose between an item for each format and one **Export…**, the
owner chose one.

## What is decided

**Export…** (a command of Preview's, `export`) opens the Preview panel at its formats, now headed
**Export as** (PDF…, Word…, HTML…), the first one focused and the row of them marked for a moment, so
the choice is made there, with the keyboard or the pointer. It renders nothing for the page as it
opens (Preview, or ⇧⌘R, does), so choosing a format starts its render alone. What follows is as
before: the render, the offer to download LaTeX for a PDF that needs it (0045), the file saved,
named after the document.

The panel's own **Render** and *Update when saved* are unchanged; **Save as** is renamed **Export
as**, so the menu and the panel say the same thing.
