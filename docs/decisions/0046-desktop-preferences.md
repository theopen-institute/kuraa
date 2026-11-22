# 0046 · The desktop app's Preferences set what a host's flags set; what stays a flag, and why

*Since [0063](0063-settings-keep-what-you-change.md): the launcher has no **Join**; `--join`/`--token` remain.*

> Superseded in part by [0047](0047-browser-equals-desktop.md): Preferences are one model in the hub
> (`packages/host/src/settings.ts`), the same dialog in a browser and in the desktop app wherever the
> host listens only on this computer, applied by the hub reopening its workspaces in place. The
> Podman program is a flag again, `--allow-invites`, `--manage-online` and `--manage-person` are gone,
> and `pnpm host` alone serves your workspaces as the desktop app does.
>
> Superseded in part by [0048](0048-shared-workspaces-always-sync.md): `--peer` and its preference
> are gone; a shared workspace always syncs, and one that is not has nothing to sync with.

A host is configured by flags ([0018](0018-untrusted-users.md)): whoever starts it is its operator,
and people using the app cannot change what it allows. The desktop app is the one case where the
person using the app *is* the operator: its hub runs on their own computer, for them, on the
loopback address. Nobody double-clicking an app should need a terminal, so its **Preferences**
window sets everything a host's flags set that makes sense for one person's own computer. A flag
given when starting the app still wins over its preference (tests, people who use a terminal), and
the window says which preferences a flag has overridden.

**Moved to Preferences.** Each is kept in `preferences.json` with the app's data
(`apps/desktop/src/preferences.ts`), validated when saved (a wrong value is refused with what is
wrong, and the window stays open), and applied by restarting the hub, which commits first.

| Flag | Preference | Where |
| --- | --- | --- |
| `--peer` | Sync every workspace with the other computers it is on | Other computers |
| `--bootstrap` | Servers to find other computers through | Other computers › Advanced |
| `--format` | Kinds of documents (one checkbox each; at least one) | Kinds of documents |
| `--engine` | Run R code in documents | Running code |
| `--env` | Where code runs (shown only when more than one environment is loaded) | Running code |
| `--allow-installs` | Let documents install packages and download tools (on) | Running code |
| `--memory`, `--cpus`, `--disk` | Limits for each document's code (empty: the default, shown) | Running code › Advanced |
| `--allow-write`, `--allow-network` | What a workspace may ask for, each with what it risks | Running code › Advanced |
| `--r-image` | Other base images a workspace may use for R | Running code › Advanced |
| `--podman` | The Podman program (empty: found automatically) | Running code › Advanced |
| `--data-dir` | Where packages and tools are kept | Running code › Advanced |
| `--workspaces` | Where new workspaces go | New workspaces |
| `--flush-ms`, `--commit-ms` | Seconds without typing before edits are written, and before a version is saved | Saving › Advanced |

The ones most people need are in view, and the others are under **Advanced**. A preference naming
an environment or a format the app no longer has is passed over, not an error at every start.

**Not needed in the desktop app**, because there the person is the operator: `--allow-invites`,
`--manage-online` and `--manage-person` are always on.

**Actions, not settings.** `--dir` and `--init` (serve one folder, making it a git repository) are
**Open a folder…**, which asks before initialising. The desktop's own `--open` and
`--join`/`--token` are **Open a folder…** and the launcher's **Join**. The options of the device
commands are in the app: an invite's expiry and whether it is for one person or anyone (`--hours`,
`--forever`, `--anyone`) are in **Invite people…**, and a device's name (`--name`) is
**Rename this computer…**.

**Command line only, and why.**

- **`--port`, `--host`, `--token`, `--static`: serving other people.** The desktop app's server is
  private to it: the loopback address, a free port, a random access code only the app holds, and the
  client from inside the app. Letting others on the network connect would make the computer a server
  for people it does not trust ([0018](0018-untrusted-users.md)). That is what `pnpm host` is for,
  run deliberately by whoever takes that on. People share with someone using the desktop app through
  invite links ([0038](0038-equal-peers.md)), which need none of these. Offering "share on this
  network" in the app would be a new feature with its own design, not a flag moved.
- **`--component`: loading code that runs with your rights.** A run component is a JavaScript
  module the host loads into itself. It runs with everything the person's account can do, outside
  any sandbox. A preference would make that one file choice away, with no way yet to know who wrote
  the module or whether it was changed: there is no signing or trusted publisher for components the
  host loads ([0045](0045-tools.md) leaves that undecided). Until there is, loading one stays a
  deliberate act at a terminal.
- **`--allow-unsandboxed`: turning off the sandbox.** It lets code in documents run on the computer
  itself, removing the one boundary that keeps a document's code from the person's files and network
  ([0018](0018-untrusted-users.md), [0019](0019-engine-and-environment-components.md)). No
  environment that needs it ships, so it only matters together with `--component`, and it should be
  as hard to reach as that.
- **`pnpm dev`'s flags** (`--dir`, `--workspaces`, `--port`, `--allow-write`, `--allow-network`)
  belong to developing the app, not to using it.
- **Environment variables for tests:** `KURAA_USER_DATA`, `KURAA_HIDDEN_WINDOWS`, `KURAA_TIMINGS`
  (which still wins over the saving preferences, so tests can be fast), `KURAA_PERSON` and
  `KURAA_E2E_PORT`. `KURAA_TOKEN` and `KURAA_PODMAN` are other spellings of `--token` and `--podman`.

**One command without an app equivalent.** `pnpm host fork` makes a copy of a workspace its own
workspace, with a new identity. It is a repair for a folder copied with its device key, one of the
weaknesses [0038](0038-equal-peers.md) leaves to the coming redesign of membership, so it waits for
that redesign rather than getting a button now.
