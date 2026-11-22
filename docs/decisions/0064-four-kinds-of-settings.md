# 0064 · Four kinds of settings, in one window

> Changes where settings are shown: Settings ([0060](0060-one-settings-window.md)), Document
> settings ([0054](0054-document-settings.md)), Components ([0017](0017-components-panel.md),
> [0059](0059-online-copy-is-a-component.md)) and the menu ([0044](0044-polish.md)). What each
> setting is, who may change it and how it is saved are as before ([0063](0063-settings-keep-what-you-change.md)).

The owner's direction:

> "The settings panels are kind of a mess. I'd like it to be very clear that there are document
> settings, workspace settings, server settings, and user settings… Eventually, they may all be
> triggered from different locations, but it's cluttered and unclear right now."

Settings were in four places, each mixing kinds: the menu (the workspace's devices and invites,
renaming and removing it, a way to Components, you), its Document settings panel (mostly commands:
views, history, find, outline; and the header), Settings (you, and this computer's server), and
Components (the server's engines, environments, formats and tools; the workspace's online copy;
your editing behaviour). Document formats were in both Settings and Components.

## Sorted by who a setting applies to, and where it is kept

| Section | Applies to | Kept in | Holds |
| --- | --- | --- | --- |
| **You** | you alone | this browser (your key: this computer) | name, email, colour; your key; how each kind of document is edited for you; the server and access code, when joined with `--join` |
| **Document** | everyone who opens it | the file | its header |
| **Workspace** | everyone in it | the workspace | its name; its packages; its devices and invite links; its online copy; removing it from this server's list |
| **Server** | everyone using it, every workspace on it | the server's settings | other computers, kinds of documents, running code, new workspaces, saving (its owner's to change); what it runs (engines, environments) and the tools it downloads, shown to everyone |

Each section opens with one line saying who it applies to and where it is kept ("Everyone in
"Field notes". Kept in the workspace."). The Components dialog is gone: everything in it has a
section. Document formats are in Server once (turned on and off by its owner, shown to others).

## One window, opened at a section

Settings is one window (`SettingsWindow.vue`): the four sections in a list on the left, each with
what it is about now beneath (your name, the document, the workspace, "This computer"), and the one
chosen on the right; on a narrow window the list is a row of tabs. Each section is its own component
(`SettingsYou`, `SettingsDocument`, `SettingsWorkspace`, `SettingsServer`), and all four stay as
they are while another is shown, so going between them loses nothing. One window keeps one place
to look and one way of saving (0063: closing keeps what was changed; Done says when server changes
will reopen the workspaces).

Every way in opens it at a section, so the separate triggers the owner expects are each one line:
the menu's **Document settings…** and right-clicking a file (Document), **Workspace settings…**
(Workspace), **Settings…** and ⌥⌘, (the section last shown, You at first). A section with nothing
to change now stays in the list, quieter, and says why ("Open a document to change its settings.";
"This kind of document has no settings of its own."), so the window is always the same four.
**Server** is shown to everyone: its settings only to its owner (anyone else sees why), what it runs
and its tools to all, as Components showed them.

Things done in a dialog of their own from Workspace (inviting people, packages, removing the
workspace) close Settings first, keeping what was changed in it.

## The menu holds no settings

The menu's Document settings panel is gone: its commands (Source, History, Save version, Preview,
Find and replace, Outline, Insert table, Next conflict), when it was last saved, and the code
session are in the menu's section for the document, with **Document settings…** beneath. The
workspace's section keeps Search, Sync and who is here, with **Workspace settings…**; Devices,
Rename and Remove moved to Workspace. **Components…** is gone; **Markdown and shortcuts** is in the
section for you, beside **Settings…**.

## Not yet

Moving the commands out of the menu (to the document's toolbar or right-click menu, and a short
app menu), and the triggers of their own (the workspace's name, your name, the document's ⋯), come
next, each opening this window at its section.
