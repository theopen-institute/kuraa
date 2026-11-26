# 0087 · Navigation is made of components (proposed)

**Status: proposed; nothing is built.** The core stops drawing navigation. It adds two hooks to the
feature contract, **layouts** (where navigation goes in the window) and **navigation views** (ways of
seeing the workspace's files), and one switch (**on by default**). Today's sidebar becomes two
features, `@kuraa/sidebar` (a layout) and `@kuraa/files` (the file tree, a view), changing nothing
anyone sees. Where no layout is on, the core shows a small menu at the upper left, and nothing else.
The manuscript ([0088](0088-a-manuscript-is-a-quarto-book.md)) is the second view.

The owner asked, planning an order of documents of their own choosing (as Scrivener's binder has):

> "I want to keep the core app as framework with most specific functionality defined in components.
> Much of this would be related to the sidebar, which should also be a component rather than part of
> core."
>
> "I'd like atomic components as much as possible."

And, having read a first draft in which the core kept the sidebar's frame:

> "I don't want core to keep the sidebar frame, because some layouts may not use a sidebar at all. I
> agree that there needs to be *some* way to access settings (and possibly files) if no layout
> components are on. Could these minimal core-critical features just be in a upper-left dropdown
> menu, visible only if no navigation-functional components are on?"

## What is there now

The sidebar is the core's: `FileTree.vue`, placed by `App.vue`, holds the sidebar's header (the
connection light, the workspace's name and menu with ⚙ and ⟳, ＋, Search), the tree (folders, files by
title, icons, folding, the keyboard, dragging onto folders), every file action (new file, new folder,
rename, delete, move) and their dialogs, and the right-click menu, to which features add items
(`fileMenu`, [0082](0082-annotations.md)). A feature can add panels beside the document, but nothing
that finds one.

## What is decided

**The core gives navigation what it needs, and draws none of it.** What there is (the files, the
workspaces, who is connected) and what can be done (open a file, rename it, switch workspace, open
Settings) are the core's, given to components as data and actions with no place on the screen. Where
they are shown is a component's to say. One component does one thing:

- a **layout** puts navigation somewhere in the window (a sidebar, a bar along the top), with the
  workspace, its connection, Settings and the views in it;
- a **navigation view** is one way of seeing the workspace's files (a tree, a manuscript), drawn
  wherever a layout gives it room.

A view never names a layout, nor a layout a view: the core gathers every view that is on and gives
them to the layout that is on, so no component depends on another.

### What stays in the core

- **What can be done to a file**: New file, New folder…, Rename…, Delete…, moving, Document
  settings…, Permissions…, with the dialogs they have now; and the **file menu**: the core's items,
  then each feature's (`fileMenu`). A view calls them; it never has dialogs of its own for them.
  Permissions, commits and the rules on names stay where they are.
- **The files as the core knows them**: each file's path, title, type and icon, what fewer read or
  may change (the lock and the pen), its conflicts, its companions folded under it; the folders with
  permissions of their own.
- **The workspace and its connection, as data**: the workspaces there are (to switch between and add
  to), the open one's name, whether it is connected and who else is here, what the online copy lacks;
  with the actions on them (switch, add, sync now, invite, Settings at a section). The banners for a
  lost connection, saving that fails and errors stay the core's, as they are about the app, not
  navigation.
- **The document and what is beside it**: the editor, History, Preview, Search and the features'
  panels. Search keeps its keys (⇧⌘F); a layout may also offer a button for it. Whether the right side
  is a layout's to arrange too is not decided here.
- **The fallback menu**: where no layout is on, a single button at the upper left opens a menu of what
  the app cannot be used without: the workspaces (to switch to, and **Add a workspace…**), **New
  file**, **Files…** and **Settings…**. **Files…** is a plain list of the workspace's files (each by
  title, with its folder beside it) under a filter; Enter or a click opens one, Escape closes it. No
  folders to fold, no dragging, no menu. The button is not drawn at all while a layout is on. Settings
  is where layouts are turned back on (Settings › Host and Workspace, under Features).

### The contract

**A layout** (`ClientFeature.layout`) has an id, a label, and `mount(element, ctx)`: it is given the
window's navigation area (the left of the window, as wide as it asks, or none) and returns how to take
itself down. It says it **gives navigation** (`navigation: true`) only if it offers the workspaces and
Settings itself; while one that does is on, the core's fallback menu is not drawn. One layout is used
at a time: where more than one is on, each person chooses theirs (Settings › You), the first by
default. Its context is the feature's (`FeatureClientContext`), with:

- `views()`: the navigation views that are on, from every feature, each to `mount` where the layout
  chooses; `onViews(fn)`: told when they change;
- `workspaces()`, `workspace()`, `connection()` and `onWorkspace(fn)`; `switchWorkspace(id)`,
  `addWorkspace()`, `syncNow()`, `invite()`, `openSettings(section?)`, `openSearch()`;
- the file actions, as views have them (below), for a ＋ of its own.

**A navigation view** (`ClientFeature.views`) has an id, a label (its name where a layout lists
views) and `mount(element, ctx)`. Its context is the feature's, with:

- `files()` and `folders()`: as the core knows them; `onFiles(fn)`: told when they change;
- `selected()`: the open file, and `onSelected(fn)`; `open(path)`;
- `newFile(folder?)`, `newFolder(parent?)`, `rename(path)`, `remove(path)`, `move(path, folder)`,
  `fileMenu(path, at)`: the core's actions and menu, each as it is from anywhere else;
- `icon(file)`: the file's icon, drawn as the core draws every icon ([0023](0023-file-icons.md)), so
  every view's look alike;
- `newItems?()`, from the view: what it adds to a layout's ＋ (a manuscript's *New chapter*).

The contract stays free of any framework ([0016](0016-vue-client.md)); a layout or view may use Vue
inside its own package, mounting an app of its own. The additions are to the contract, so
`FEATURE_API_VERSION` stays 1.

### On by default

A feature is on in a workspace only where `.kuraa/features.json` says so. A feature may now say it
is **on by default** (`HostFeature.onByDefault`): on wherever the workspace says nothing of it. A
workspace that turns it off says `"on": false`, as now; the host's operator and each person can
still turn it off as for any feature. `@kuraa/sidebar` and `@kuraa/files` are on by default, so
every workspace, made before this or after, looks as it does now.

### The two features the sidebar becomes

- **`@kuraa/sidebar`**, a layout that gives navigation: the left pane as it is now, its header (the
  connection light, the workspace's name and menu with ⚙ and ⟳, ＋ with the core's New file and New
  folder… and each view's items, Search) and, below, the views: where there is more than one, a row of
  their names above them chooses one, remembered for the person in this browser, by workspace.
- **`@kuraa/files`**, a navigation view: the folders and files as a tree, folding (remembered as
  now), the keyboard (arrows, Enter, F2 renames, Delete deletes, Shift+F10 the menu: each the core's
  action), dragging a file or folder onto a folder or the top (the core's move), and a folder's two
  buttons (the core's New file and New folder).

`tree.ts` and `TreeFolder.vue` go to `@kuraa/files`; `WorkspaceSwitcher.vue`, `ConnectionLight.vue`
and the header to `@kuraa/sidebar`; `FileTree.vue`'s actions and dialogs stay in the core. Test ids
stay as they are, so the browser tests of the file list and the workspace menu pass unchanged: that is
how we know the move changed nothing. Each has a host half with only an id, a label and
`onByDefault`.

## Why this way

- **Atomic**: a layout only places things, a view only shows files. Keeping the actions in the core
  means a second view (the manuscript) or a third (an outliner) does not copy rename, delete and their
  rules, and cannot get them wrong; the file menu is the same wherever a file is shown; and a layout
  with no sidebar (a bar, a writing mode with nothing around the page) uses the same views.
- **The core never depends on a component to be used**: with every layout off, its menu at the upper
  left still opens files, makes them, changes workspace and reaches Settings, where layouts are turned
  back on. It is small enough not to need a component, and out of sight otherwise.
- **Nothing changes for anyone**: both features are on by default and look and work as now.

## The build order

1. The contract's hooks and `onByDefault`; the core's data and actions offered through them; the
   fallback menu.
2. `@kuraa/files` and `@kuraa/sidebar`: today's sidebar moved into them, on by default; the browser
   tests unchanged.
3. The manuscript ([0088](0088-a-manuscript-is-a-quarto-book.md)).

Other parts of the core may become components the same way, each in a change of its own when it is
worth it (Search, the Outline, History, the arrangement of the right side); none is decided here.
