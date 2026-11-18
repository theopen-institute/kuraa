# 0017 · Turning plugins on and off

**Plugins…** in the menu lists three kinds of plugin, each with a box to turn it on or off:

- **Running code**: engines (R) and environments (Podman, Local, and any loaded with `--plugin`),
  with the default environment among those that are on.
- **Document formats**: Pandoc markdown, R Markdown, Text file. A file whose format is off opens
  as the next type that claims it. The Text file type claims `.md`, `.Rmd` and `.qmd` at its low
  priority, so they open as text with markdown highlighting while their own formats are off.
- **Editing, just you**: each format's editor module (`FormatEditor`), such as markdown cues with
  footnote ordering, or chunk fences. Kept in this browser (`localStorage`); no one else is
  affected. Footnote ordering acts only on your own edits, so turning it off leaves others' notes
  alone and theirs tidy yours on their next edit.

**Who changes the host's plugins.** Run plugins decide what runs on the host's computer, and Local
is not sandboxed. There is no admin role (anyone with the token edits), so the host's plugins can
be changed only on a host its owner alone can reach: one started with `pluginSettings` (the
desktop app, `pnpm dev`, `--allow-plugin-changes`), which the host refuses unless it listens on
the loopback address. Elsewhere the panel shows them read-only, and `PUT /api/plugins` answers 403.

**Where the choices live.** In `plugins.json` in the host's data folder (with the package cache):
per computer, for every workspace, never in a workspace, so a repository cannot turn on what its
owner turned off. They win over `--engine` and `--env`, which say what is on until a choice is
made. The desktop app's Run Code menu is gone; the panel replaced it.

**Live.** A change applies at once. Running sessions stop (the next run starts in what is now on).
Everyone with a file open gets a `plugins` room message and reloads the workspace's description.
A file that now opens as a different type has its room written, committed and closed first, and
its editors reopen it as the new type.

**Contracts.** `Engine`, `Environment` and `DocumentType` gained an optional `description`, and
`FormatEditor` an optional `label` and `description`, for the panel. All optional: existing
plugins keep working, and the run plugin API version is unchanged.
