# 0061 · One name for a workspace

Until now a workspace's name was each device's own: the hub's list of workspaces kept a label for
each folder, given when it was made, opened or joined. Whoever joined from an invite link was asked
"what to call it here", so the people in one workspace could each call it something else, which
made talking about it confusing. The owner's direction:

> "There should be a central name for the workspace. That should be decided by the workspace
> creator, and there should be a mechanism to rename the workspace (for everyone)."

## The name is in the workspace

A workspace keeps its name in its repository, in `.kuraa/workspace.json`: one line of JSON,
`{"name":"Field notes"}`. Being a file in the workspace, it reaches every device the way every
change does (by the branch, through other devices and the online copy, and in a `git clone`), its
history says who named it what and when, and no new kind of message or record between devices is
needed. The sidebar does not show `.kuraa` ([tree.ts](../../packages/client/src/tree.ts)).

- **Making a workspace names it.** A new workspace's first commit holds the name given (the hub's
  `create`; a folder made a workspace with **Open a folder…** or `--init`, by its folder's name).
- **Joining does not.** The join dialog no longer asks for a name: once the workspace is copied, the
  hub's list takes the name in it. The folder it is copied into is `shared-workspace` (or `-2`, …),
  chosen before anything of the workspace is known; only the name is shared. (An invite link does not
  carry the name: its fields are positional and signed, and the name arrives with the copy anyway.)
- **Anyone in it may rename it** (every member has the same say, [0038](0038-equal-peers.md)): **Rename
  workspace…** in the menu's workspace section, `PATCH /api/workspace/name {name, by}`. The host
  writes the file and commits it, "Rename the workspace to “…”", crediting who renamed it, and it
  syncs like any commit. A name is spaces tidied, not empty, at most 100 characters.
- **Each device follows.** A host reads the name at start, after a rename made on it, after merging
  what another device sent, and when asked for the workspace (`GET /api/workspace`, which also says
  `named`), and tells its hub (`onName`), which keeps it in its list of workspaces, so the list says
  it even while the workspace is closed. Whoever has a file open is told the files changed (as for
  any change merged in), so the page reads the workspace's name again, and the list of workspaces
  with it.

## Workspaces made before

A workspace made before this has no name file, and goes by what each device calls it, as before.
It is named the first time someone invites to it from the app (`POST /api/peers/links`): the device
making the link commits the name it calls it by, "Name the workspace “…”", so whoever joins gets
that name. A workspace already shared before this is named by whoever first renames it, or next
invites someone. Nothing is written into a folder only for opening it: a folder opened with **Open
a folder…** that is a git repository already is not changed until it is shared or renamed.

## Two renames at once

The name file is one line, so two renames made apart conflict on that line, and the merge (made the
same on every device, [0025](0025-merging.md)) keeps both between conflict markers. Reading the file
takes the first name in it, so every device shows the same one, until someone renames it again,
which writes the file whole. No change to merging is needed, and `MERGE_VERSION` stays.
