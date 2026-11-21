# 0052 · The server, released on its own, updates itself

The desktop app updates itself ([0051](0051-the-app-updates-itself.md)), and carries the server
and the web client inside it. A server run on its own (for browsers, or as an always-on device of
shared workspaces) ran from a checkout of the repository, updated by hand: and once the protocol
devices speak changes, such a server stops syncing with updated apps until someone notices.

## What changed

- **Each release carries the server on its own** (`scripts/build-server.mjs`, the Release
  workflow's `server` job): `kuraa-server-<version>.tar.gz`, one folder holding `kuraa-host.mjs`
  (`packages/host/src/server.ts` and all it uses, bundled), the web client, and Hyperswarm's native
  parts for every platform the app ships on, as in the desktop app. It needs Node 24 and git (and
  Podman to run R), and serves the web client it came with.
- **Signed with a release key.** An Ed25519 key (`scripts/server-signing-key.mjs`; the private half
  is the `release` environment's secret `SERVER_SIGNING_KEY`) signs the archive, and its public half
  is built into each server, which takes an update only if signed with it: GitHub, or whoever
  breaks into the repository's releases, cannot push code to servers without the key. A server
  built without a key checks only the checksum GitHub lists for the archive. Losing the key
  means servers stop updating, and must be installed again by hand.
- **Installed in a folder of its own** (`kuraa-host install [--to dir]`, default
  `~/.kuraa/server`): `versions/<version>/` for each, `current` naming the one to run, and
  launchers (`kuraa-host.mjs`, `kuraa-host`, `kuraa-host.cmd`) that run what `current` names and
  never change. `--service` writes a service that runs it with `--auto-update` and the flags after
  `--`, starts it at boot and again whenever it stops, with an access code of its own kept in the
  service, so it stays the same across restarts: a systemd user unit on Linux, a launchd agent on
  macOS (readable only by the user). It says how to start it; it starts nothing itself.
- **`--auto-update`** (`selfupdate.ts`): a few minutes after starting and every six hours, the
  server asks GitHub for the latest published release (never a pre-release), and if it is newer,
  downloads it, checks it, unpacks it beside the one running, names it in `current`, and keeps the
  one before (older ones go). Then it stops, saving every workspace, for its service to start the
  new one: at night, between 3 and 5 local time, so no one is cut off while working; or at once
  when a device of a workspace runs a newer kuraa (0051), as the two do not sync until then. Run
  from the repository, or built without a place to look, it says so and does not update.
- **`kuraa-host update`** takes the latest by hand, for the next start; **`--version`** says which
  runs.

## Not done

- **Going back** to the version before, if a new one does not start: it is kept, and naming it in
  `current` by hand does it; the server does not yet notice by itself.
- **Saying in the app** that a newer server is available, for servers not run with `--auto-update`.
- A service for Windows (run it under whatever restarts it), and a container image.
