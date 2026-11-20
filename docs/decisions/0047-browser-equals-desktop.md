# 0047 · The browser is the desktop app's equal

> Supersedes in part [0018](0018-untrusted-users.md) (people using the app may now configure a host
> listening only on their own computer) and [0046](0046-desktop-preferences.md) (Preferences are no
> longer the desktop app's alone, and the Podman program is no longer one of them).

Until now, people using the app in a browser were assumed untrusted ([0018](0018-untrusted-users.md)):
a host's configuration was flags only, and only the desktop app, whose user is its operator, had
Preferences ([0046](0046-desktop-preferences.md)). The owner's direction:

> "For now, assume that the website deployment is identical in function and scope to the desktop
> app, run by a single individual on their own device. Likewise, make it so there is as much parity
> between the desktop app and the website as possible. That said, keeping component and
> allow-unsandboxed to runtime flags makes sense, as those could allow for malicious code (not just
> fragile settings)."

A server for many people, with roles and permissions, will need a design of its own. None is built
here.

## The owner's features follow loopback

Whoever has the access code of a hub listening only on this computer (`--host 127.0.0.1`, the
default; the desktop app always does) is its **owner**, in a browser as in the desktop app. They have:

- **Preferences…** (`GET` and `PUT /hub/api/settings`);
- **Open a folder…**: any folder on the computer (`POST /hub/api/workspaces/open {path, init}`), chosen
  in the page's **folder picker** (`GET /hub/api/folders?path=`: folders only, starting at home, with
  the one above; hidden ones only when asked for; links never listed or followed);
- their **identity** (the host's person API, which `hostPerson.ts` uses in both shells);
- the **online copy** (adding and removing it, with this computer's git credentials).

When `--host` names a network address, these are off, and the app says why, in plain words, in the
menu (the hub's listing carries the sentence; `OWNER_OFF` in `hub.ts`). Invites and devices are always
on, on every hub: every member has the same say ([0038](0038-equal-peers.md)). Adding new workspaces
and joining from a link stay as before (a hub of many, not `--dir`).

A folder that is not yet a git repository is opened only once the person agrees: the hub answers 409
with its name and how many items are in it, the client asks in the words the desktop app's dialog
always used, and sends `init: true`. The desktop app's own folder dialog replaces the folder picker
there (`Shell.chooseFolder`), and its ⌘O and ⌥⌘, menu items ask the page (`onOpenFolder`,
`onPreferences`, like Help's `onHelp`): both shells then use the same hub API.

## One settings model, in the hub

The model moved from the desktop app into `packages/host/src/settings.ts`: the fields, the lenient
read (a field of the wrong kind is its default) and the strict save (a value that is wrong is refused,
400, with what is wrong), and their tests. The code says "settings"; the app says "Preferences".

The hub owns a `SettingsStore`: a JSON file, and the flags given at start, which win and are reported
as `fromFlags`. Where it is kept:

- the desktop app: `userData/preferences.json`, as before, so preferences carry over;
- `pnpm host`: `settings.json` in the app data folder (`defaultDataDir()`), or the file `--settings`
  names (tests always name one, so they never touch real data);
- `pnpm dev`: `.dev-workspaces/settings.json` (beside `--workspaces`, if given).

**Applying** is the hub's: it closes every workspace's host, each writing and committing its edits,
and opens them again with the new options. The address and access code do not change; the page then
reloads. The desktop app no longer stops and restarts its hub, nor reloads the window itself.

The folder for **packages and tools** (`dataDir`) must be new, empty, the app's own data folder, or one
already used for them: accepted folders get a small marker file, `.kuraa-data`. A folder with other
things in it is refused, so a mistaken choice cannot be filled (or later cleared) by the app.

`allowInstalls` is on by default everywhere, as a setting (`--no-allow-installs` turns it off as a
flag). Running R is on by default too, where the R engine is loaded.

**`pnpm host` alone is "your workspaces"**, like the desktop app: with neither `--dir` nor
`--workspaces`, new workspaces go in the settings' folder (default `~/Documents/kuraa`), and the list
is kept beside the settings file (`host-workspaces.json`, not the desktop app's `workspaces.json`, so
the two never open the same list at once), so choosing another folder keeps it. `--dir` still serves
exactly one folder, and `--workspaces` still names the folder and wins over the setting.

## What was removed

- **`--manage-person`, `--manage-online` and `--allow-invites`.** Owner features follow loopback,
  and invites are always on. The host refuses the old flags, saying why.
- **`podman` as a setting.** The Podman program is a flag again (`--podman`, `KURAA_PODMAN`), in the
  desktop app too: it names a program the host runs with the owner's rights, so it is in the same
  class as `--component`. Someone with the access code could push an executable into a workspace and
  point the setting at it. A `podman` in an old preferences file is passed over.
- The desktop app's Preferences window (`preferences.html`), its IPC, and its separate person bridge
  (`shell.person`, IPC `kuraa:person*`). The host's person API does it all; what the desktop's
  `personChanged()` did (each syncing workspace says so to its other devices now) the hub does when
  your identity changes through any workspace's API.

## What stays a flag, and why

- **Code that runs with your rights:** `--component` (a module loaded into the host),
  `--allow-unsandboxed` (code in documents running on the computer itself) and `--podman` (a program
  the host runs). A page served by the server must not be able to choose these.
- **How the server is reached:** `--port`, `--host`, `--token` and `--static`. A page served by the
  server cannot sensibly change the address it was loaded from; and `--host` decides whether there is
  an owner at all.
- **What the server is started for:** `--dir` (one folder; **Open a folder…** adds one to your
  workspaces instead) and `--settings` (where the settings themselves are).

## What stays the desktop app's own

- its native menus (which ask the page for Preferences, Open a folder and Help);
- the spelling suggestions and Add to Dictionary in its right-click menu;
- the git it ships;
- the launcher, and joining another server;
- native save dialogs (a browser downloads instead);
- `managesHost`: the server address and access code are left out of Settings, as it holds them.

Its own folder dialog is used where it has one, but a browser has the folder picker, so that is not
a difference in what either can do.
