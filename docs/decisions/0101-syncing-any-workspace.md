# 0101 · Syncing any workspace from the workspaces' menu

**Status: built.** Every workspace in the menu at the upper left (0087) that syncs, open or not,
has the sync icon on its row.

The owner asked to see whether their other workspaces were synced, and to sync them, from that menu,
without switching to each one. Until now only the open workspace's row had the icon.

## What is decided

**Asked as the menu opens.** A hub serves all its workspaces at once (`/w/<id>`), so the client asks
each one that is not open, as the menu opens, how it syncs: its devices and its online copies, as it
asks the open one every few seconds (`loadWorkspaceLink`). The rows are drawn again as the answers
come in, and as the open one's changes while the menu is open. No host route is added.

**The icon says how it stands.** Where a workspace syncs with something (other devices, an online
copy), its row has the sync icon: with how many saves its online copy lacks beside it, turning while
it syncs, in the warning colour if the last sync of its online copy failed. Pointed at, it says what
it does (*Sync now*, *Sync now (3 saves not on the online copy yet)*, *Syncing…*) and how the
workspace syncs, a line each, in the words the connection light uses for the open one (*Syncing with
1 of 2 devices*, *Online copy: up to date*). A workspace that cannot open has none.

**Clicked, it syncs that workspace** (`POST /w/<id>/api/sync`), and says how it went, with the
workspace's name. The open workspace's is as before. ⚙ stays on the open workspace's row alone.
