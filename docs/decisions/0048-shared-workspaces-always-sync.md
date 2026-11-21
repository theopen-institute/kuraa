# 0048 · A shared workspace always syncs; syncing is not a setting

> Supersedes in part [0028](0028-peers.md) (syncing is no longer turned on with `--peer`) and
> [0046](0046-desktop-preferences.md) (the `--peer` row: **Sync every workspace with the other
> computers it is on** is gone from Preferences).

`--peer`, and the preference made from it in 0046, said "sync every workspace with the other
computers it is on". It no longer did anything of the kind. Since invites were made from the app,
a workspace syncs as soon as it is shared: making an invite link shares it, and joining from one
makes a shared copy (its repository has a workspace id and secret, [0028](0028-peers.md)). Shared
workspaces synced whatever the setting said. The setting only changed workspaces on this computer
alone, which have no other computer to sync with: it gave each a workspace identity it did not
need and announced it on the public DHT, where no device could ever find it. That cost a peer node
per workspace and a little exposure, for nothing.

No other way of putting a workspace on a second computer depended on it. A `git clone` does not
carry the workspace's identity (it lives in git config, which is not cloned), and a copied folder
carries it with it, so it is shared and syncs anyway.

## What changed

- **Syncing follows from sharing, and nothing else.** A hub opens a workspace with its peer layer
  when, and only when, its repository has a workspace id and secret. Making an invite (in the app or
  with `kuraa-host invite`), joining, or forking makes it so, for good.
- **`--peer` is gone,** from `kuraa-host` and from the desktop app, with no compatibility: passing it
  is an unknown flag. `kuraa-host join` says to run `kuraa-host --dir <folder>`.
- **`syncDevices` is gone** from the settings (`settings.ts`), the Preferences dialog and the client's
  API. A settings file that still has it is read as for any setting that is no longer one: the value
  is passed over.
- **Preferences' Other computers** keeps a line saying which workspaces sync, and, under Advanced,
  the servers to find other computers through (`--bootstrap`). Joining a workspace now uses those
  servers too; before, it used only the ones given at start.

## Not done

A switch the other way, **pausing** syncing for a shared workspace (on a metered connection, say),
would be a real setting. It is not needed yet.
