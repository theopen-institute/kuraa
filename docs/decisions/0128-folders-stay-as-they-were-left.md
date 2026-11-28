# 0128 · Folders stay open or closed as they were left

From feedback: every folder in the file tree opened again each time the app did, however it had
been left. The file tree ([0087](0087-navigation-is-made-of-components.md)) kept which folders were
closed only while the page was open.

Now `@kuraa/files` remembers the folders closed in each workspace on this device (`folds.ts`), and
the tree opens with them closed and the rest open, in the browser as in the desktop app (whose page
comes from a file, so its storage lasts from one launch to the next).

- **Where:** the browser's storage, `kuraa:files-collapsed:<workspace name>`, a list of folder
  paths. Next to the sidebar's chosen view (`kuraa:sidebar-view:<workspace name>`), and keyed the
  same way. It is not kept in the workspace: how one person folds their tree is theirs, not
  something to commit or for their collaborators to share, and not something to sync between their
  devices.
- **Closed is what is kept:** a folder never closed is open, as before, so a new folder, or one
  someone else made, shows open.
- **The open document's folder stays closed:** opening the app again with a document open does not
  open the folders it is in. Choosing a document still opens its folders (from search, a link, or
  something made or moved there), as before.
- **What no longer exists is let go of:** when what is kept is written, folders no longer in the
  tree are left out, so the list does not grow. Not while the tree is empty, before its files have
  come. A folder renamed or moved here keeps its state under its new path (as before, for the page).
- **Switching workspace** reads that workspace's folds. What was just read is not written back, so
  a workspace's list is not pruned against another workspace's tree while its files are on their
  way.
- Storage unavailable (a private window): the tree folds for that page only, as before.
