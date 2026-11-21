# 0049 · Joining keeps its connection, devices find each other again by events, and joining says how it is going

> Changes [0028](0028-peers.md): a device that joins in the app no longer closes the connection the
> join made and connects anew; it goes on with it.

Two computers on different networks were slow to join, and then showed each other as offline. One
was behind a router that changes its port for each connection (a "randomized" NAT: phone hotspots,
many campus, office and carrier networks). Hyperswarm can connect through one, but only one such
attempt every 20 s or so on each computer; the others are aborted (`HOLEPUNCH_ABORTED`). Three things
made that worse:

- **A join connected twice.** `kuraa-host join` and the app's **Join** made a node, were let in,
  fetched, then closed it; the workspace's host then started another node with the same key and had
  to connect to every device again, through the same slow network, while the other devices were
  still timing out the first connection.
- **Hyperswarm gives up for ten minutes.** After four failed tries at a device it knows, it waits ten
  minutes before the next. A few aborted attempts in a row, common on such a network, meant ten
  minutes of "offline".
- **Nobody could see any of it.** The app said "Looking for a device…" for as long as it took.

## What changed

- **The join's node goes on.** `joinWorkspace` takes `keep`, and then hands back the node that
  joined, still connected. A hub passes it to the new workspace's host (`PeerOptions.node`), whose
  `Peers` goes on with it (`PeerNode.becomeMember`) instead of starting another: the devices already
  connected are told to the host as if they had just been let in (it fetches from them, and tells
  them its rooms), devices that said hello while it was being let in are answered as a member, and
  every device is sent a new hello, which now says how this one merges (the join's did not). If the
  workspace fails to open, the node is closed. `kuraa-host join` still closes it: the host is a
  separate command there.
- **Devices find each other again by what happens, not by polling each one** (`node.ts`). Dialling
  every missing member again and again (Hyperswarm's own way, every ten minutes for each, for ever;
  for a while here, every 30 s) costs every device a lookup per missing member, per workspace, for as
  long as it is gone, and guesses. Instead:
  - **The device that arrives dials.** One that starts, or is just paired, is dialled for a minute
    (`dial`: Hyperswarm's tries, backing off), then let be (`leavePeer`). Nothing is dialled for good.
  - **Devices say whom they are connected to** (`present`, sent whenever that changes). A member that
    a connected device reaches, and this one does not, is online through it: **Devices** in the menu
    says "online, through laptop", and its saved work does reach this device through the other. Of
    the two that hear of each other this way, only the one with the lower key dials, so they do not
    both spend the few tries a hard router allows at once. Live edits go through a device in between
    too, when it has the same document open (rooms.ts passes on what it receives).
  - **One lookup of the workspace, while a member is missing,** finds every device of it that is
    online, however many are missing: 15 s, 1, 2, 4 and 8 minutes after a member goes (or this device
    starts, or the network changes), each with up to a quarter more at random, then Hyperswarm's own
    lookup every ten minutes. None while every member is here. Hyperswarm also looks again by itself
    when the network changes or comes back.
- **Joining says how it is going.** `joinWorkspace` tells `progress` its steps: looking for a device
  of the workspace, connected to one and being let in, copying from it; and whether this computer's
  network is the kind that takes a few tries (`PeerNode.slowNetwork`, from HyperDHT). The app gives
  the join an id; the hub keeps its status while it runs (waiting for another workspace to be added
  first, the join's steps, then opening it) at `GET /hub/api/joins/<id>`, and the **Join** dialog asks
  every second and says it in plain words. After 20 s of looking, it says a computer of the workspace
  needs to have kuraa open; on a slow network, that this can take a minute or two.

## Not done

*Since [0050](0050-networking-review.md): members offer each other relays (and one run by someone
can be named), every workspace shares one DHT node per computer, and devices find each other on
the local network too.*

- **Saying why a device is offline** in **Devices** (the last error, the kind of network), and
  keeping the desktop app's log in a file.
- **Fewer connections than every device to every other,** for workspaces of many devices: git and
  rooms already pass work on through devices in between.
