# 0017 · The Components panel

*Since [0064](0064-four-kinds-of-settings.md): the Components dialog is gone. The server's engines, environments, formats and tools are in Settings › Server; your editing behaviour in Settings › You.*

> Changed by [0018](0018-untrusted-users.md): the host's components are set by flags only. The panel
> first let the owner of a host switch them; it now only shows them.

**Components…** in the menu lists three kinds of component:

- **Running code**: the engines (R, and any loaded with `--component`) and the environments, whether
  each is on, whether an environment is sandboxed and available. Read-only (`--engine`, `--env`).
- **Document formats**: Pandoc markdown, R Markdown, Text file, whether each is on. Read-only
  (`--format`). A file whose format is off opens as the next type that claims it: the Text file
  type claims `.md`, `.Rmd` and `.qmd` at its low priority, so they open as text with markdown
  highlighting while their own formats are off.
- **Editing, just you**: each format's editor module (`FormatEditor`), such as markdown cues with
  footnote ordering, or chunk fences. Each person turns these on and off for themselves; kept in
  their browser (`localStorage`), affecting no one else. Footnote ordering acts only on your own
  edits, so turning it off leaves others' notes alone, and theirs tidy yours on their next edit.

`GET /api/components` describes them; nothing in the API changes them.

**Contracts.** `Engine`, `Environment` and `DocumentType` have an optional `description`, and
`FormatEditor` an optional `label` and `description`, for the panel.
