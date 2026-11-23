# 0028 · Devices of one workspace sync with each other, without a server

*Since [0038](0038-equal-peers.md): one kind of invite link (for one person or anyone) replaces invitations and subscription links, every member's work and changes to the members are taken, and a shared room is committed by the lowest key in it. The sync remote is now the online copy ([0039](0039-online-copy.md)). Since [0048](0048-shared-workspaces-always-sync.md): there is no `--peer`; a shared workspace always syncs. Since [0049](0049-joining-on-slow-networks.md): a device joining in the app goes on with the join's connection, and devices find each other again by saying whom they are connected to, with one lookup of the workspace while one is missing. Since [0050](0050-networking-review.md): members relay for each other, devices find each other on the local network too, a link carries a topic of its own and not the secret, the secret is made anew when a device is removed, and hellos carry a hash of the records, not the records. Since [0077](0077-one-leader-per-room.md): rooms across devices are sessions with one leader, which alone writes, commits and brings git's changes in; sessions never combine, and meet in git.*

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
- whose work it accepts on its own, by branch, and whose membership changes: `.git/kuraa/accept.json`
  (0032; this replaced an upstream device and gated branches).

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

- **Pairing** is the operator's, from the command line, and from the app where the operator
  allows it: a hub allows it for its workspaces (0029), and a host of one workspace with
  `--allow-invites`. In the app, **Invite people…** (the menu's Devices section, and the workspace
  menu on a hub) makes either kind, shows it to copy, and lists the links made there to revoke.
  Making one turns syncing on for the workspace if it was off (a hub remembers that). The dialog
  says what an invitation gives: a copy that syncs, to read and change everything. Two ways:
  - **An invitation** (`kuraa-host invite`): good once, for 24 hours, with the device that made
    it (only a hash of it is kept there), which must be running when the other joins.
  - **A subscription link** (`kuraa-host link [--hours 168 | --forever]`): good for anyone, any
    number of times, until it expires or is revoked. The device that made it signs it (its id,
    expiry, the workspace, its rules, and the devices it came into the workspace through, with its
    key), so any member can check it and let someone in; the device that made it need not be
    there. (Before 0032, with an upstream device, only links it made counted.)
    `kuraa-host links` lists a device's links; `kuraa-host revoke-link <id>` revokes one, and the
    revocation spreads like a removal (`kuraa.revokedlinks`). Devices that joined by it stay. A
    link carries the workspace's secret, as an invitation does: anyone who has it can find the
    workspace's devices, though only a good link or invitation lets them in.

  Either way, on the other device **Add a workspace… → Join from an invitation** (0029), or
  `kuraa-host join <invitation or link> --dir <new folder>`, finds
  a device that lets it in, learns the members from it, fetches, and checks out
  the branch. It joins only through a device it can trust: by an invitation, the inviting device;
  by a link, the link's maker or a device its pairing records (signed `add`s, 0031) trace back to
  the maker or the devices the maker came in through, each record signed by a device already
  traced. Anyone else who knows the workspace's secret (from an expired or revoked link, say) can
  find the joining device, but is not the one it joins through. (Before, a joining device paired
  with any device of the workspace that answered. A removed device whose removal the joining
  device has not heard of can still be traced: the joining device drops it once a member tells
  it, as every device does.) A device turned away (a revoked or expired link, an invitation used up) says why
  within seconds, unless another device lets it in meanwhile. A device that joined by a link keeps it (`.git/kuraa/joined-link`) and shows it to
  devices it meets that do not know it yet, so they pair with it too.
- **Who is let in:** a paired device that has not been removed, or a device presenting an
  invitation this device made or a good subscription link. Anyone else is turned away after its
  hello; removed devices before it. A device's hello carries the membership records only to
  devices it is paired with: one it does not know learns nothing from it.
- **Membership spreads:** a device a member vouches for (in its hello) is paired by the others,
  and so is a removal (before 0032, with an upstream device, only its word counted; since, each device chooses whose membership changes it takes). Devices announce changes to
  the members as they happen, and dial newly paired devices directly.
- `kuraa-host devices`, `name`, `remove-device`, `accept`, `sync-remote` and `fork` manage the rest.

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

## The upstream, by convention (replaced by 0032)

*Since 0032 a device is never an upstream: each device decides whose work it accepts, by branch.
What follows is how it was.*

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
- **One device commits a shared room** (since 0032: the lowest key among those whose work every
  other device there accepts on its branch); before, the upstream if it is in the room, else the device with
  the lowest key. Edits made on other devices are credited (co-authors). The others write the file
  but do not commit it.
- **Only the device that commits a shared room brings changes from git into it.** The others
  leave the room as it is when a merge comes in, write it back to the file, and get the change
  through the room (or through git, from that device). So a change that reaches several devices
  is made in the room once, never twice.
- **Work done apart, on a document open on both:** shared rooms already hold both sides' edits,
  so the merge of the two devices' commits takes the room's text for that file.

## Not yet

- The DHT's bootstrap nodes are Hyperswarm's public ones unless `--bootstrap host:port` names
  others. They see that a device looks for a topic (a hash), not what the workspace holds.
- ~~Run outputs stay on each device.~~ They reach the other devices since [0058](0058-shared-outputs.md). Branch deletions are not passed on.
- Membership without an upstream is a convention every device follows: a removal reaches a device
  only through devices that know of it, and so does a revoked link. Since 0031 every change is a
  signed record, so who made it is known and any device can pass it on.
- A subscription link has no limit on how many times it is used: the devices that check it do not
  count uses together. Expiry and revocation are what limit it.
- Every device that joins is a full device: there are no read-only roles yet.
