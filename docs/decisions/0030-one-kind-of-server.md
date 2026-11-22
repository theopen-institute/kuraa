# 0030 · One kind of server: every server is a hub

*Since [0063](0063-settings-keep-what-you-change.md): the workspace menu holds the workspaces, then **Add a workspace…** (where opening a folder now is); inviting and removing are in the menu.*

There used to be two: a host served one folder (`kuraa-host --dir`), and a hub served many
(`--workspaces`, 0029). The app looked different on each: on a hub the sidebar's header was a menu
of workspaces with **Add a workspace…**; on a host it was a plain name. People met the difference
without a reason for it (`pnpm dev` was a host, the desktop app a hub).

**Now every server is a hub.** `kuraa-host --dir <folder>` starts a hub of that one folder: its
only workspace, at `/w/<id>` like any other, nothing added or taken off the list from the app,
and no list kept on disk. `--workspaces <folder>` is as before. The difference is a permission,
not a kind of server: `GET /hub/api/workspaces` answers `{ workspaces, canAdd, canInvite }`, and the
hub refuses to add or remove (403) where `canAdd` is false. Whether people may invite others stays
the operator's to decide (0018): `--allow-invites` for one folder, always for a folder of
workspaces. If the one folder cannot open, the server does not start.

**The app always shows the workspace menu.** It lists the server's workspaces and offers **Add a
workspace…**, **Open a folder…** (desktop) and **Remove from this list…** only where `canAdd`.
A server that answers as a host itself (a host started on its own with `startHost`, as the
tests do) is shown as a list of one that nothing is added to, so the app looks
the same whatever it talks to.

**`pnpm dev`** serves a folder of workspaces, `.dev-workspaces/` (or `--workspaces`), as the
desktop app does; the first time it starts with a Scratch workspace. `--dir` serves one folder.

**What changed for people using a server of one folder:** its git URL is `/w/<id>/git`, not
`/git` (the host prints it). `startHost`, the building block, is unchanged: a hub runs one per
workspace.
