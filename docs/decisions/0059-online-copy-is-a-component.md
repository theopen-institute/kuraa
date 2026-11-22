# 0059 · The online copy is a component

*Since [0064](0064-four-kinds-of-settings.md): the online copy is set up in Settings › Workspace.*

The online copy ([0039](0039-online-copy.md)) was built into the host: `Host` made an
`OnlineCopies` from `backups.ts` for every workspace, `/api/online` was fixed in the routes, and
the menu always had an **Online copy** section. It is now a component, like engines,
environments and tools: the host knows none by name, and a host started without it has no
online copy.

**A fifth kind of run component: syncs.** A `RunComponent` may list `syncs` beside `engines`,
`environments` and `tools`. A sync is a place the workspace keeps a copy of itself beyond its own
devices, and syncs with. It is not about running code, but it is loaded the same way (`--component`,
`loadRunComponents`, the standard list), so its contract is in `@kuraa/run-kit`, with only
optional members added: `RUN_API_VERSION` stays 1. A `Sync` has an id, a label, a description,
an example address and a line of help for adding one, and `open(ctx)`, which gives a
`SyncSession` for one workspace: `add`, `remove`, `list`, `names`, `changed` (after a commit),
`sync`, `syncAll`, `start`, `close`.

Unlike the other kinds, a sync runs in the host with the host's rights and its person's git
credentials, and is given the workspace's repository (`SyncContext.git`: `run` only), not a
process to start. The host keeps what must stay its own: the environment for git that never
prompts (`nonInteractive`), its queue of git work (`serial`), and bringing fetched branches in by
the merges every device makes (`bringIn`, `Host.bringInFrom`). Absent `bringIn` (the command
line), fetched work is left for a running host.

**`@kuraa/sync-git`** is the online copy, moved from `packages/host/src/backups.ts` unchanged in
behaviour, with the words the app shows (its description, `git@github.com:you/notes.git`, how to
make an empty repository). `@kuraa/run-components` includes it, so the command line, the desktop
app, `pnpm dev` and every hub's hosts have it as before. A lint rule keeps the host from
importing `@kuraa/sync-*`, and sync packages to `@kuraa/run-kit`.

**The API** is `GET /api/syncs` (`canManage` and each sync with its targets), `POST
/api/syncs/<id>` (`{ target }`) and `DELETE /api/syncs/<id>/<name>`, which replace `/api/online`.
Who may add and remove is unchanged: the host's owner (`manageOnline`, 0047). **Sync** syncs with
every sync's targets.

**In the app,** the online copy is set up in **Components…** (for now), one section per sync
loaded, named and described by its component; the menu no longer has an Online copy section.
Where the host is not managed from the app, the section says so. `kuraa-host online` is
unchanged; the command line hands the standard components to it.

**Not decided here.** Turning a sync off with a flag, as `--engine` and `--format` do; for now,
loaded means on. Whether its settings stay in Components or move back beside Devices once there
is more than one kind.
