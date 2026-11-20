# 0037 · The host keeps the files safe: links, git outside the app, encodings, failures

A workspace is an ordinary git repository that other programs use too (git itself, RStudio, a text
editor), and that people with the token can push to. The host now assumes as much.

**Links are never followed.** Any path the host reads or writes for the app (the file API, rooms
as they open, write and take outside edits, merges' reads of the working tree, titles) is refused if
any part of it is a symbolic link, and where it really is must be inside the workspace's real
folder (`/var` is `/private/var` on macOS, so the workspace's own path is resolved once). Files
are read with `O_NOFOLLOW` where the system has it. A link may still be in the workspace (pushed,
or delivered by another device): git keeps it as a link, the file list shows it, marked
(`cannotOpen`) and not openable, and it can be renamed or deleted (the link, never what it points
to). A room whose file became a link is not written; saving fails and says so, its edits kept.
What is left is a race: a link made in the moment between the check and the write.

**Reading before writing.** Before a room is written to its file, the file is read. If it differs
from what the host last wrote or saw (an outside save the watcher missed), it is taken in first as
any outside edit (merged three ways, or kept beside as `name.outside-<time>`), then written. A file
an outside program turned into something that is not UTF-8 is kept beside, byte for byte, and the
room written. Writes go to a temporary file that is synced to the disk before it is renamed over
the file; temporary files a stopped write left behind are removed when the host starts.

**Git used outside the app.** The host reads where git is from git's own files (cheap enough
before every write): the branch checked out (`HEAD`), and whether an operation is under way
(`MERGE_HEAD`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, `rebase-merge`, `rebase-apply`).
It looks when the watcher sees those change, and every second while rooms are open.

- *In the middle of an operation, or with no branch checked out* (an earlier version, a rebase):
  nothing is written or committed. Edits wait in their rooms and the room cache; people are told
  (`save-status: paused`). No new room opens while no branch is checked out, file operations from the
  app are refused, and work from other devices or a sync remote waits. Outside changes are taken
  only once the operation is done. Then saving resumes: the rooms take what the operation changed,
  and what waited is written and committed.
- *The branch changed* (`git checkout feature`): rooms are per branch, so a room is never written
  onto another branch's file. **Chosen:** the old branch's unsaved edits are committed onto the old
  branch by its ref (`commitToBranch`: its tree with the file changed, a commit on top, signed when
  syncing with devices, the ref moved only if it has not moved meanwhile); the working tree, now the
  new branch's, is not touched. People with a file open are moved to the new branch's room for it
  (`reseeded`, saying why), or told the new branch has no such file. A room left open on the old
  branch goes on being committed onto that branch the same way. Switching back finds the old
  branch's file as its room last committed it.
- If git switched branches carrying uncommitted changes with it (git does, when the file is the same
  on both), those changes stay in the working tree, as git left them, and the new branch's room
  starts from them: they may then be committed on both branches.
- Left: a git command run in the moment between the host's look and its write.

**Files that are not UTF-8** (a Latin-1 `.bib`, an old `.tex`) are not opened as rooms: the host
says why (415), and the file list marks them (`cannotOpen`), since editing them as text would change
their characters. Merges treat them as binary (one version kept, the other beside it), as git's own
merge of them is not text either. That changes how some merges come out, so the merge version is 2.

**Failures.**

- A write or commit that fails (another program holds `index.lock`, a file that cannot be written)
  keeps the edits in the room, is tried again after a wait that doubles up to a minute, and people
  are told (`save-status: failing`, then `ok`).
- Saving every room (stopping, before a push or merge) tries every room, whatever one of them does.
- Nothing is started and forgotten without its failure being logged. The command line, the desktop
  app and `pnpm dev` have a last resort for any error nothing caught (`lastResort`): it is logged,
  every workspace's edits are saved that can be, and the server goes on; one workspace's error does
  not stop the others. Only errors coming thick and fast stop it (saving first).
- Talking to other computers (Sync's fetch and push, backups' pushes) happens outside the queue
  that saves: what to push is read in its turn, the network is not. Such git commands never prompt
  (`GIT_TERMINAL_PROMPT=0`, SSH in batch mode, no credential manager windows) and give up after a
  while (5 minutes to fetch, 10 to push), stopping what they started.
- A hub's list of workspaces that cannot be read is never taken for an empty one and written over:
  a list that is not valid is set aside beside it, and any other error stops the hub starting.
- Deleting a folder closes the rooms of the files in it.

The client shows `save-status` messages as notes, as it does outside edits.
