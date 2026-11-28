# 0114 · Export… is the one item

**Status: built.** Revises [0100](0100-export.md). The open document's ⋯ menu has a single item for
Preview, **Export…**. The separate **Preview** item is gone.

The owner asked what the difference was between **Preview** and **Export…**, since both opened the
same panel. Told that **Preview** opened it and rendered the page, while **Export…** opened it at its
formats and rendered nothing, they said: "Combine the two, and call it 'Export...'".

## What is decided

- **Export…** (Preview's `export` command, test id `menu-export`) opens the panel and renders the
  page, as **Preview** did. It also focuses the first of its **Export as** formats (PDF…, Word…,
  HTML…) and marks the row of them for a moment, as in 0100. The `menu-preview` item is no longer on
  the menu.
- **The panel's heading is Export** (the panel's label), so the menu and the panel say the same
  thing. This label also appears on the Markdown and shortcuts sheet beside ⇧⌘R.
- **⇧⌘R is unchanged.** It opens the panel, or renders again while it is open, and leaves the focus
  where it is, so you can keep typing after it.
- **A format chosen while the page renders keeps the status.** Export… starts the page's HTML render
  as it opens. If you choose a PDF a moment later, its progress, and the offer of LaTeX where it is
  needed ([0045](0045-tools.md)), is what you asked for. So a page render that finishes while another
  format is being rendered or waits to be saved does not take the status line from it.
- **The component is still Preview** (`@kuraa/preview`, `preview`), under that name in Settings ›
  Components. Only what the menu and the panel say changed.
