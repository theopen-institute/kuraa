# 0028 · Devices of one workspace sync with each other, without a server

A workspace can live on several devices at once, each running its own host. Hosts connect
directly to each other: git carries what was done apart, and when people on two devices have the
same document open, their rooms join so they edit it together live. Browsers and the app still
talk only to their own device's host, which enforces everything it did before (decision 0018).
No server is needed; one can take part as just another device.

```
 browser ─┐                                        ┌─ browser
 app ─────┤ host A ══ git + live rooms (encrypted) ══ host B ├── app
          └────────────────────── ║ ───────────────────────┘
                     host C: an always-on device (optional)
```

Turned on with `--peer` (kuraa-host, and the desktop app). Off by default; the peer layer, and
Hyperswarm with it, is loaded only when it is on.

## Identity: kept on the device, as git keeps its remotes

Nothing about devices is committed, so copies, forks and merges never carry it:

- the workspace's **id** and **secret**, and this device's **name**: git config (`kuraa.workspace`,
  `kuraa.secret`, `kuraa.devicename`);
- this device's **key pair**: `.git/kuraa/device.json`, readable only by its owner;
- **paired devices** are git remotes whose URL is `kuraa://<device key>`, so `git fetch laptop`
  and `laptop/main` work as for any remote;
- **removed devices**: `kuraa.removed`, never accepted again;
- the **upstream** and **gated branches**: `kuraa.upstream`, `kuraa.gated`.

The first device to use `--peer` or `kuraa-host invite` makes the repository a shared workspace.
**Forking** (`kuraa-host fork`) gives the copy a new id and secret and records the original
(`kuraa.forkedfrom = <id>@<commit>`); its devices stay as remotes to fetch from by hand. A fork
and its origin meet and may fetch from each other, but neither brings the other's work in on its
own.

## Finding and trusting devices

Hyperswarm finds devices by a topic derived from the workspace's secret (only devices that know it
find each other), punches through home routers, and encrypts every connection with Noise; the
other end proves the key it claims. One connection per device is split into channels (protomux):
control messages, rooms, and git streams.

- **Pairing** is the operator's, from the command line: `kuraa-host invite` prints a one-time
  invitation (good for 24 hours; only a hash of it is kept); on the other device, `kuraa-host join
  <invitation> --dir <new folder>` finds the inviting device, presents it, learns the members and
  the upstream, fetches, and checks out the branch. The app only shows devices.
- **Who is let in:** a paired device that has not been removed, or a device presenting an
  invitation. Anyone else is turned away after its hello; removed devices before it.
- **Membership spreads:** a device a member vouches for (in its hello) is paired by the others,
  and so is a removal; with an upstream device, only its word counts. Devices announce changes to
  the members as they happen, and dial newly paired devices directly.
- `kuraa-host devices`, `name`, `remove-device`, `upstream` and `fork` manage the rest.

## Git between devices

- **Only fetching.** A device never writes to another's repository. It fetches each paired
  device's branches into `<device>/<branch>` through a git remote helper (`git-remote-kuraa`, in
  `.git/kuraa/bin`; on the command line, put that folder on `PATH` while the host runs), which asks
  the running host for a stream to the other device's `git upload-pack`. Fetches have a time limit
  and a size limit (2 GiB), and run without hooks or submodules.
- **When:** when a device connects, and whenever a device says its branches moved (after each
  commit or merge).
- **Bringing work in** (`peers/peers.ts`): a fast-forward, or a merge made as every device makes
  it (0025), so two devices merging the same commits make the same commit. The checked-out branch
  moves through the working tree (open rooms take the change); other branches move by their ref.
  A branch only another device has is created here.

## The upstream, by convention

`kuraa-host upstream <device|self|remote|none> [--gate <branch>]`:

- **None:** every device brings in every other's work.
- **A device:** it brings in everyone's work, except on **gated** branches, where other devices'
  work waits as a **proposal** (shown in the app's menu, under Devices, with **Accept**). Other
  devices take the upstream's work; each other's only while the upstream is away, and never on a
  gated branch. When the upstream is in a shared room, it is the one that commits it. Devices learn
  which device is the upstream from the members; only the upstream can change it.
- **An ordinary remote** (GitHub, say): devices also sync with it, 30 seconds after their commits
  and every 5 minutes (fetch, merge, push), as Sync does. Its own rules (branch protection) apply.

## Rooms across devices (`peers/rooms.ts`)

A room is known to other devices by branch, path and type version, and by its seed, the blob it
started from (0027). Devices tell each other which rooms they have open.

- **Same seed:** the two rooms are joined: Yjs updates both ways, and who is in the room (names,
  cursors). Joining exchanges state vectors, so each sends only what the other lacks.
- **Different seeds** (the file differed when each room started): the histories cannot merge, so
  the device whose room has the higher seed takes the other's room, merging its own text in three
  ways from where the two meet (the file at the merge base of the commits each room started from,
  fetched first if need be). People on it are moved to the new room. Every device in the end shares
  the lowest seed, and nothing is lost. Git waits for this before bringing that device's work in.
- **One device commits a shared room:** the upstream if it is in the room, else the device with
  the lowest key. Edits made on other devices are credited (co-authors). The others write the file
  but do not commit it.
- **Only the device that commits a shared room brings changes from git into it.** The others
  leave the room as it is when a merge comes in, write it back to the file, and get the change
  through the room (or through git, from that device). So a change that reaches several devices
  is made in the room once, never twice.
- **Work done apart, on a document open on both:** shared rooms already hold both sides' edits,
  so the merge of the two devices' commits takes the room's text for that file.

## Not yet

- The git remote helper is a shell script: not on Windows yet.
- The DHT's bootstrap nodes are Hyperswarm's public ones unless `--bootstrap host:port` names
  others. They see that a device looks for a topic (a hash), not what the workspace holds.
- Run outputs stay on each device. Branch deletions are not passed on.
- Membership without an upstream is a convention every device follows: a removal reaches a device
  only through devices that know of it.
