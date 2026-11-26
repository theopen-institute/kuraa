# 0087 · The sidebar is made of components (proposed)

**Status: proposed; nothing is built.** It adds one hook to the feature contract (a **sidebar
view**) and one switch (**on by default**), and moves the file tree out of the core into a feature of
its own, `@kuraa/files`, changing nothing anyone sees. The manuscript ([0088](0088-a-manuscript-is-a-quarto-book.md))
is the second sidebar view.

The owner asked, planning an order of documents of their own choosing (as Scrivener's binder has):

> "I want to keep the core app as framework with most specific functionality defined in components.
> Much of this would be related to the sidebar, which should also be a component rather than part of
> core."

> "Bare list as a fallback is valid for now. Keep the fallback minimal and possibly in a menu."

> "I'd like atomic components as much as possible."

## What is there now

The sidebar is the core's: `FileTree.vue`, placed by `App.vue`, holds the sidebar's header (the
workspace's name, ＋, Search), the tree (folders, files by title, icons, folding, the keyboard,
dragging onto folders), every file action (new file, new folder, rename, delete, move) and their
dialogs, and the right-click menu, to which features add items (`fileMenu`, [0082](0082-annotations.md)).
A feature can add panels beside the document, but nothing on the left.

## What is decided

**The core keeps what every view of the files needs; a view only shows them.** One component does
one thing: a view is a way of seeing the workspace's files, never a second copy of what can be done
with them.

### What stays in the core

- **The sidebar's frame**: its header (the connection light, the workspace's name and menu, with ⚙
  and ⟳; ＋; Search) and, below it, the space a view is drawn in. Where more than one view is on, a
  row of their names above that space chooses between them, and the one chosen is remembered for
  the person in this browser, by workspace.
- **What can be done to a file**: New file, New folder…, Rename…, Delete…, moving, Document
  settings…, Permissions…, with the dialogs they have now; and the **file menu**: the core's items,
  then each feature's (`fileMenu`). A view calls them; it never has dialogs of its own for them.
  Permissions, commits and the rules on names stay where they are.
- **The files as the core knows them**: each file's path, title, type and icon, what fewer read or
  may change (the lock and the pen), its conflicts, its companions folded under it; the folders with
  permissions of their own. A view is given them and told when they change.
- **The fallback**: where no sidebar view is on, **Files…** in the workspace's menu opens a plain
  list of the workspace's files (each by title, with its folder beside it) and a filter above it;
  Enter or a click opens one, Escape closes it. Nothing else: no folders to fold, no dragging, no
  menu. It is how a file is opened with every view off, not a view of its own, and it may later be a
  quick open (⌘P) for everyone.

### The contract: a sidebar view

A feature's client half may bring views for the sidebar (`ClientFeature.sidebar`). Each has an id,
a label (its name in the row of views) and `mount(element, ctx)`, as panels have: it draws itself
into the element and returns how to take itself down. The contract stays free of any framework
([0016](0016-vue-client.md)); a view may use Vue inside its own package, mounting an app of its own.
Its context is the feature's (`FeatureClientContext`), with:

- `files()` and `folders()`: as the core knows them (above); `onFiles(fn)`: told when they change;
- `selected()`: the open file, and `onSelected(fn)`;
- `open(path)`;
- `newFile(folder?)`, `newFolder(parent?)`, `rename(path)`, `remove(path)`, `move(path, folder)`,
  `fileMenu(path, at)`: the core's actions and menu, each as it is from anywhere else;
- `icon(file)`: the file's icon, drawn as the core draws every icon ([0023](0023-file-icons.md)), so
  every view's look alike.

A view may add items to ＋'s menu, after the core's (a manuscript's *New chapter*). The additions are
to the contract, so `FEATURE_API_VERSION` stays 1.

### On by default

A feature is on in a workspace only where `.kuraa/features.json` says so. A feature may now say it
is **on by default** (`HostFeature.onByDefault`): on wherever the workspace says nothing of it. A
workspace that turns it off says `"on": false`, as now; the host's operator and each person can
still turn it off as for any feature. Without it, every workspace would lose its file tree.

### `@kuraa/files`: the file tree, as a feature

The tree moves into a package of its own, a feature with a client half only (its host half has an id,
a label and `onByDefault`, and nothing else): the folders and files as a tree, folding (remembered
as now), the keyboard (arrows, Enter, F2 renames, Delete deletes, Shift+F10 the menu: each the core's
action), dragging a file or folder onto a folder or the workspace's name (the core's move), and a
folder's two buttons (the core's New file and New folder). `tree.ts` and `TreeFolder.vue` go with it;
`FileTree.vue`'s frame and actions stay in the core, as above. Its test ids stay as they are, so the
browser tests of the file list pass unchanged: that is how we know the move changed nothing.

## Why this way

- **Atomic**: the tree is only a way of seeing files. Keeping the actions in the core means a second
  view (the manuscript) or a third (an outliner) does not copy rename, delete and their rules, and
  cannot get them wrong; and the file menu is the same wherever a file is shown.
- **The core never depends on a view to open a file**: the fallback is in a menu, as asked, and is
  small enough not to need a component.
- **Nothing changes for anyone**: the tree is on by default, looks and works as now, and a workspace
  made before this has it without being changed.

## The build order

1. The contract's hook and `onByDefault`; the core's frame, actions and file menu offered through
   it; the fallback.
2. `@kuraa/files`: the tree moved into it, on by default; the tests of the file list unchanged.
3. The manuscript ([0088](0088-a-manuscript-is-a-quarto-book.md)).

Other parts of the core may become components the same way, each in a change of its own when it is
worth it (Search, the Outline, History); none is decided here.
