# 0039 · One online copy, pushed to and fetched from

> Changed by [0059](0059-online-copy-is-a-component.md): the online copy is a component
> (`@kuraa/sync-git`), set up in **Components…**, not the menu; `backups.ts` is its `online.ts`.

Supersedes the sync remote (0032) and backups (0036). People met two settings for one git server,
with different rules (one fetched and merged on Sync, the other only pushed to), and had to choose.
Now there is one: an **online copy** (GitHub, GitLab or any git server, or a folder).

- **Each save is pushed to it,** a while after the last (half a minute), and everything at start.
- **It is fetched from and merged** on **Sync** and every five minutes: its branches come in by
  the same deterministic merges as another device's (0025), and the result is pushed. So devices
  that cannot reach each other directly still meet through it.
- **A push refused because the copy moved** (another device pushed first) is followed by: fetch,
  merge, push, a few times at most. **Never forced.**
- **The person's own git credentials** (an SSH key, a credential helper for https); never a
  prompt (SSH in batch mode), and each fetch and push has a time limit.

The network calls are in one place (`backups.ts`, `OnlineCopies.network`), outside the host's
queue of git work; only bringing the fetched branches in runs in the queue (`Host.bringInFrom`,
`Host.bringBranch`, which the peer layer uses too).

Kept in the repository's git config: `kuraa.online` names the remotes; one added by address gets
a remote of its own (`online-<owner>-<name>`), removed with it; an existing remote named as one
(by name, or by its address) stays when removed. Several may be added; the app leads with one.
It is set per device: each device that should meet the others there adds it.

**Who sets it up.** It syncs with the credentials of whoever runs the host, so adding and removing
it is theirs: in the app's **Online copy** section where the host allows it (`--manage-online`:
the desktop app, and `pnpm dev`), or `kuraa-host online add <address> | remove <name>` (`backup`
is another name for it). Everyone using the app sees it, and Sync uses it.

**No sync remote.** `kuraa.syncremote`, `kuraa-host sync-remote` and taking `origin` for one are
gone: a clone's `origin` is synced with only once it is added (`kuraa-host online add origin`).
