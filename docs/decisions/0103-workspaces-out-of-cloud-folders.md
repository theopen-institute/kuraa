# 0103 · Workspaces out of cloud storage folders, and a hub that answers at once

**Status: built.** New workspaces go in **Kuraa Workspaces**, in the home folder, not in Documents. A
workspace whose folder iCloud Drive, Dropbox, Google Drive or OneDrive keeps says so, and the app
offers to move it out. The hub answers as soon as it listens, and its workspaces open meanwhile.

The owner's app often stayed on its starting screen for close to a minute (37, 28, 81, 63 and 54
seconds in a day), and asking a workspace for anything, an invite link for a server say, took tens
of seconds. The starting screen blamed networks that block connections between computers. It was not
the network. On that Mac, as on many, iCloud keeps Desktop and Documents in sync, and so kept
`Documents/kuraa`, every workspace's `.git` folder with it. iCloud holds back reading a file while it
deals with it: reading one 184-byte object of a workspace's git history waited more than four
minutes. A workspace that syncs writes small files in `.git` all the time (its records, its rooms,
its commits), so iCloud was always busy with them. Moved out of iCloud, the same three workspaces
opened in 0.3 seconds. iCloud also left a workspace's `.kuraa/features.json` empty and a document
missing from its folder, neither done by the app, and copies a file it finds changed in two places
beside it (`HEAD 2`), which git does not understand.

## What is decided

**Where new workspaces go.** By default, `~/Kuraa Workspaces` (`defaultWorkspacesFolder`), for the
desktop app and `kuraa-host` alike, unless Settings or `--workspaces` name a folder. Not `~/Kuraa`,
which on a disk that ignores case is any folder called `kuraa` (a checkout of Kuraa, say). Workspaces
already listed stay where they are: the lists keep each one's whole path.

**Which service keeps a folder** (`cloud.ts`). On macOS the system marks the top of each folder a
service keeps (`com.apple.file-provider-domain-id`: Desktop and Documents when iCloud keeps them,
everything in `~/Library/CloudStorage`); the folder and each above it are asked. Anywhere, and for
the older ways these services kept folders, a folder in the home folder called `Mobile Documents`,
`iCloud Drive`, `Dropbox`, `OneDrive`, `OneDrive - …`, `Google Drive` or `Box` is one. The list says
which service keeps each workspace (`cloud`), learned as it opens.

**Said, and moved.** The workspaces' menu names the service after the workspace (`(in iCloud
Drive)`). Opening such a workspace shows a warning, with **Move it…** where this person may add
workspaces (the owner, on a hub of many): asked first, naming where it goes, the workspace's host is
closed (its edits written and committed), its folder moved into the folder for new workspaces
(renamed, or, on another disk, copied and then removed), the list kept, and the workspace opened
again from there (`POST /hub/api/workspaces/<id>/move`). Its devices go on finding it: what it is
and who is in it are in its repository, which moves with it. One no service keeps is not moved; nor
is one when the folder for new workspaces is kept by a service too (the app says to choose another
in Settings first). The R packages its code uses are installed again on its next run, as they are
kept by the folder's path.

**The hub answers at once.** It used to open every workspace before it listened, so the slowest held
up the window and every other workspace. Now it listens first, and each workspace opens on its own:
the list says which are still opening (`opening`, shown as `(opening…)`) and the app reads it again
each second until none is. Anything asked of a workspace still opening (a request, a room) waits
until it has opened, or answers why it could not. Taking one off the list, moving one, and applying
Settings wait for the workspaces opening; so does closing the hub. A server (0099) still opens its
workspaces first: no one waits on it, and what it lists is then how each stands. So does a hub of
one folder, which has nothing to serve if it cannot open.

**The starting screen** no longer blames the network: it says the app is still starting, that the
files are safe, and that Help › Show Log File says what it is waiting for.

## Not decided here

Keeping a workspace's documents in a cloud service's folder, with its history elsewhere (git can keep
a repository apart from its files), for people who want their documents there. Two copies would then
sync the same documents, the service's and the workspace's own, and that needs deciding first.
