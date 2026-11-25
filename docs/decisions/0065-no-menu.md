# 0065 · No menu: ⚙ is Settings, ⋯ is the document's

*Since [0076](0076-a-quieter-sidebar.md): no ⚙ at the foot of the sidebar: ⚙ and Sync are icons on the open workspace's row of the menu of its name, and the connection's light is beside the name.*

> Follows [0064](0064-four-kinds-of-settings.md), which took the settings out of the menu. Replaces
> the menu ([0044](0044-polish.md), [0054](0054-document-settings.md)).

Once the settings had left it, the menu held only commands, and with no document open hardly any:
Search, Sync, and three buttons opening other windows. The owner:

> "I don't understand why I need to click on the 'workspace settings' button. Isn't this menu
> comprehensive? The one in the image I shared seems kind of pointless now."

Putting settings back in it would undo 0064. So the menu is gone, and what it held went where it
belongs:

- **⚙ at the bottom of the sidebar, and ⌘,** open Settings at what is in front of you: the open
  document's section, else the workspace's (else yours). ⌥⌘, (and the desktop app's Settings…) open
  it at the section last shown, as before. A gear means settings, and ⌘, means settings on a Mac.
- **⋯ in the top-right corner of the open document** (`DocumentMenu.vue`) is what to do with it: its
  views and versions (Source, History, Save version, Preview), writing in it (Find and replace,
  Outline, Insert table, Next conflict), when it was last saved, its code session (Run all,
  Interrupt, Restart, Packages), **Document settings…** and **Markdown and shortcuts**. It opens
  under its button, takes focus as a dialog does, and closes on Escape or a click outside. It is
  there only while a document is open, which is when its commands mean anything. The find bar opens
  over it, in the same corner.
- **Search and Sync** are beside **+** at the top of the sidebar, as the workspace's own actions.
  Sync is there once the workspace has something to sync with (other devices, or an online copy),
  asked as a workspace opens and after inviting people or closing Settings.
- **Who is here** and the connection were already at the bottom of the sidebar. The workspace's
  branch and commit (Details) are in Settings › Workspace.

Two places, then: ⚙ for settings, ⋯ on the document for things to do with it.
