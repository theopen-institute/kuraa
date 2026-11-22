# 0051 · The desktop app updates itself from signed releases; devices say which protocol they speak

Every change to the app meant building it again and getting the new binary to each person. Peer
syncing makes that worse: devices running different versions may not understand each other
([0050](0050-networking-review.md) changed what devices say), and nothing said so.

## Considered

- **Updating the whole app, with `electron-updater`** (chosen). Electron's usual way: the app looks
  for a newer release, downloads it, and puts it in place when it quits.
- **Updating only the app's code** (`main.cjs` and the web client, about 10 MB, downloaded and loaded
  from the app's data). Smaller still, but not instead: Electron (Chromium) needs security updates
  every few weeks, and its native parts and git need the whole app anyway. It would mean loading
  code from outside the signed archive, which the packaged app's fuses forbid on purpose (README, Package the desktop app),
  and checking a signature of our own at every start, versions side by side, and a way back from an
  update that does not start. And the whole-app update already downloads only what changed: a code
  change in a 134 MB build was 5.5 MB (measured from the two builds' blockmaps). Kept for later,
  if that is not small enough.
- **Updates passed between devices.** Fits syncing with no fixed authority, but needs the above
  first.

## What changed

- **`apps/desktop/src/updates.ts`.** `electron-updater` looks for a newer release a minute after the
  app starts, every four hours (at most every ten minutes unless asked), from **Check for Updates…**
  (the app menu on macOS, Help elsewhere), and when a device of a workspace runs a newer protocol
  (below). It downloads in the background, only the blocks that changed where it can (on macOS,
  from the second update on: the first after installing from the DMG has no earlier download to
  compare with), and puts the update in place when the app quits. The page shows "kuraa x.y.z is
  ready" with **Restart now**, which saves every workspace, quits, and starts the new version.
  **Check for Updates…** opens a small window over the app's (`update-window.ts`, a sheet on macOS)
  that stays open and shows how it goes: looking, then downloading with a bar (how much of how much,
  how fast), then **Restart Now** or **Later**; or that this is the latest version, or why it could
  not update. **Hide** closes it while the download goes on (the page still says when it is
  ready); the Dock or taskbar icon shows the bar too. Not
  in a build without a place to look, run from the repository, or a Linux build that is neither an
  AppImage nor installed from a `.deb` or `.rpm`. A package is installed with dpkg or rpm, as root,
  so it asks for an administrator's password: only on **Restart now** (not when the app quits), and
  before anything is stopped, so refusing leaves the app running as it was, and is said.
- **Where it looks is set at build time**, by `KURAA_UPDATES`: `github:<owner>/<repo>` (GitHub
  Releases) or an https URL of a folder (any web server). electron-builder writes it into the app
  (`app-update.yml`), and `release:mac|win|linux` publish the builds, their blockmaps and
  `latest*.yml` there: on GitHub, into one draft release, published by hand once every platform's
  build is in it. Only a higher `version` is taken.
- **Trust is the signature, not the host.** On macOS an update is put in place only if signed with
  the same Developer ID as the app installed; on Windows, only if signed by the same publisher
  (Azure Trusted Signing, `WIN_PUBLISHER_NAME`). A host that is broken into cannot push code. A
  Windows build made without signing takes updates checked only against the checksums in the
  release's `latest.yml`, which comes from the same host.
- **Releases are made on GitHub, from a tag** (`pnpm release <version>`: sets the version, commits,
  tags, pushes). The Release workflow checks (tests, and the tag is the version), makes one draft
  release, builds each platform on its own runner in the `release` environment that holds the
  signing secrets, adds each to the draft, and publishes it once all are in: the app is developed
  quickly by a small group, and a release goes out as soon as it is built. Installed apps look only
  at the latest published release, so a release whose build failed stays a draft and reaches no
  one. Only the owner may push `v*` tags (a ruleset); actions are pinned by commit.
  The macOS build notarizes with an App Store Connect API key, which can be revoked alone, rather
  than an Apple ID's password.
- **Windows: an installer** (NSIS, one click, for the person alone, no administrator) instead of the
  portable `.exe`, which cannot update itself.
- **Devices say which protocol they speak** (`PROTOCOL` in `link.ts`, in the hello; 2 since 0050; a
  hello without it is 1). Two devices that speak different ones do not sync: each turns the other
  away, saying which is to be updated, and **Devices** shows "newer kuraa" or "older kuraa" beside
  it. A device that meets a newer one looks for an update at once (`onNewerVersion`). The protocol
  is raised whenever a change would keep an older device from understanding a newer one.

## Not done

- **Holding a release back** to try it first (a required reviewer on the `release` environment
  approves each build; or publish by hand, without the publish job), for when the app has more
  users.
- **A setting to stop looking for updates** (each look asks GitHub, or the host named, which sees
  the computer's address).
- **Devices of different protocols working together** where they can, instead of not syncing at all.
- Updating only the app's code, and updates passed between devices (above).
