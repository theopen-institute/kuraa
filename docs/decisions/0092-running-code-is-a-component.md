# 0092 · Running code is a component

> Moves the open document's code session out of the client's core, as
> [0087](0087-navigation-is-made-of-components.md) and [0089](0089-preview-search-and-outline-are-components.md)
> moved navigation, Preview, Search and the Outline. Builds on [0091](0091-the-feature-runtime-commands-and-places.md).

The owner, after a review that named Running code as the first part of the core worth making a
component: "Move forward with everything."

**`@kuraa/code`** is a feature, on by default, named **Running code** in Settings. It has:

- **The code session's part of the document's ⋯ menu**, as before: how the session stands
  ("R ready · in a Podman container"), why code cannot run here if it cannot, **Run all**,
  **Interrupt** while something runs, **Restart**, and **Packages…**.
- **Packages**, the workspace's packages for the document's language, as before, in a dialog.
- **In Settings › Workspace**, under its switch: what the packages are, and **Packages…**. It opens
  over Settings, which stays open beneath it (before, Settings closed first).

**What stays the core's.** Running a chunk from the document (its ▶ Run, Stop, outputs, staleness:
the formats' node views, through the client's chunk runner), the session on the host, and the run
components that run it ([0011](0011-running-chunks.md), [0019](0019-engine-and-environment-components.md)).
With Running code off, chunks still run from the document; what goes is the menu's session part
and the way to the packages.

## What the contract gains

- **The host's `code` service** ([0091](0091-the-feature-runtime-commands-and-places.md), *Services*):
  `session()`, the open document's code session or null, and `onSession(fn)`. A `CodeSession` says
  how it stands (`status()`: the language, the session's state, where code runs, why it cannot,
  whether something runs, whether the document has chunks to run, the language whose packages the
  workspace keeps, whether installs are allowed, the latest word on packages) and is told of changes
  (`onChange`); it runs all, interrupts and restarts, and lists, installs and removes packages. The
  client makes it from its chunk runner (`packages/client/src/code.ts`).
- **A panel's place `dialog`**: over the whole page, modal. The client draws its window (the
  backdrop, the focus kept in it, Escape and a click outside closing it) and the panel all inside
  it; `holdOpen(true)` keeps it open while something it started is under way (an install).
- **Menu entries may be lines of words** (`{ note, className, title }`, in the ⋯ menu only) and
  items may be `disabled` and have a `title`.

Its strings, its look (the session line's colours, the dialog's layout) and the test ids
(`r-state`, `run-unavailable`, `menu-run-all`, `menu-interrupt`, `menu-restart`, `menu-packages`,
`packages`, `settings-packages`) moved with it.
