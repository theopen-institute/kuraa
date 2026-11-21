# 0050 · Devices connect through each other's relays, on the local network, and on one DHT node per computer; links carry no secret, which is made anew on a removal; membership is what the records say

> Changes [0028](0028-peers.md) (how devices find each other, what an invite link carries, how
> membership travels) and [0049](0049-joining-on-slow-networks.md) (its **Not done**: a relay, one
> node per computer).

A review of the peer layer against its aim (efficient, easy, robust peer-to-peer syncing with no
fixed central authority) kept its foundations: Hyperswarm and Noise, git as the way work travels,
merges the same on every device, signed membership records, and every device connected to every
other (right for workspaces of a few to about twenty devices). It found one bug, a gap in
reaching devices, a secret doing too many jobs, and waste. All are dealt with here.

## Membership is what the records say (a bug)

A record was kept (`records.json`) and then applied to git config. If applying failed, it was
never applied: next time the record came, it was known, and passed over. It did fail: every change
to the members rewrote `gpg.ssh.allowedSignersFile`, outside the queue of membership changes, and
git lets one writer hold `.git/config` at a time. A pairing lost so left a device offline here for
good; a removal lost so let the removed device in here.

- The records are what counts, and the config is them applied: `Identity.reconcile` makes the
  config say what the records say (removed, then paired, then links revoked, then the secret),
  when the device starts and before the next change after a record could not be applied.
- `Git.run` waits and tries again (up to about two seconds) when git finds the config locked:
  nothing was written.
- The allowed-signers setting is written once, not on every change.
- A record that a newer one makes redundant (an older signing key, say) is not counted as taken.
  With records exchanged by what is missing (below), counting it made two devices ask each other
  for it for ever.

## A way through when devices cannot connect directly: relays

Two computers behind routers that change their port for each connection ("randomized" NATs: phone
hotspots, many office, campus and carrier networks) cannot connect directly at all, and one behind
one connects slowly. Hyperswarm connects such devices through a blind relay, which passes on their
encrypted streams and reads nothing of them.

- **Every member whose network is not randomized offers a relay** to the others (`relay.ts`): a
  blind relay on this computer's DHT node, with a key made anew at each start and kept nowhere,
  told only to the devices it is paired with (in its hello, `relay`). A device goes through one of
  them when a direct connection fails in a way a relay helps with, or always when its own network
  is randomized (Hyperswarm tries directly too, and keeps whichever works).
- **A relay run by someone,** for a workspace of two devices, which has no third to go through:
  `kuraa-host relay` runs one and prints its key (kept in `~/.kuraa/relay.json`), and Preferences
  (Other computers › Advanced › Relays), or `--relay <key>`, names it. Members' relays come first.
  Joining uses the named ones too.

## One DHT node per computer

Each shared workspace ran its own Hyperswarm, with its own DHT node: its own socket, its own probing
of the router, its own start from the bootstrap servers, its own allowance of one randomized
holepunch every 20 s, and possibly its own place serving the public DHT. Now the process has one
DHT node (`dht.ts`), and every workspace's swarm, and its relay, runs on it, each workspace keeping
its own device key (so no one can link a device across workspaces by its key; the address was the
same anyway). Two swarms on the one node still connect to each other: a fork and its origin on one
hub. The node is destroyed when the last swarm using it is.

## Fewer fixed points: the DHT nodes known are kept, and the local network

- The DHT nodes this computer knows are kept between runs (`~/.kuraa/dht-nodes.json`, every ten
  minutes and on stopping), and the next start begins from them: the public bootstrap servers are
  needed only the first time, or when none of those answer. Not with bootstrap servers given (a
  private network, tests).
- **The local network** (`lan.ts`): two computers in one office, home or plane find each other
  with or without the internet. Each device says by multicast (239.255.77.77:48776, one hop) that a
  device with its key listens on a TCP port, tagged for each of its workspaces with a code from that
  workspace's secret, and for each invite link it announces, with the link's topic: only a device
  that knows one can tell the tag is its workspace's. The device that hears it, if its key is the
  lower, connects over TCP, encrypted and checked with the same keys as the DHT's connections
  (Noise, `@hyperswarm/secret-stream`), and the rest of the peer layer cannot tell the two apart. A
  device connected so is not connected to again through the DHT. Said at start, when the network
  changes, and with each lookup while a device is missing; a device hearing an ask answers, at most
  once a second. On macOS the desktop app may ask once to find devices on the local network.

## The workspace's secret does one job, and can be made anew

The secret was the topic devices found each other by, was in every invite link, and could not be
changed. Anyone who ever held a link (expired, revoked, or a removed member) could find every
device's address for good.

- **An invite link carries no secret.** It carries a topic of its own, random, signed with the rest
  of the link. Making a link puts it on record (`link`: its id, topic and expiry), and every member
  announces its topic while it lets people in (not revoked, used or expired), so its holder finds
  whichever member is online; the joining device also dials the link's maker and the devices it came
  in through. The device that lets it in gives it the secret with the welcome. A revoked or expired
  link then says nothing of where the devices are. Links made before this carry the secret, and
  still work as before.
- **The secret is made anew when a device is removed** (`secret` record, from the app, `Peers.removeDevice`,
  or `kuraa-host remove-device`): the members get it with the records, and the latest counts; a
  removed device is told of its removal but never sent a secret. The devices go on to the new
  topics; one that was away dials the members it knows (as it does at every start, and at each
  lookup while it reaches none), and learns the new secret from the first it reaches.
  `records.json` is readable by this computer's user only, as it holds the secret.
- **The topics change each week** (`topicsFor`): this week's and last week's, so the DHT nodes that
  keep who announces a topic cannot tell from it that the same workspace is there months later, and
  two devices whose clocks are less than a week apart always share one.

## Less traffic

- **Only fetches that bring something.** Devices say where their branches are (`heads`, in the
  hello and in `refs`). A device that has every commit another says it has, as far or further,
  moves its tracking branches (`<device>/<branch>`) and does not fetch. Before, each commit led
  every device to fetch from every other (the devices that brought it in said their branches
  moved, and everyone fetched from them for nothing): for 10 devices, 90 fetches a commit; now 9.
- **Records by what is missing.** A hello says which records a device holds as one hash (`digest`),
  not all of them. A device that holds others asks (`want`, with the start of each signature it
  has) and is sent what it lacks (`records`); records just made or taken go to the devices
  connected at once. Before, every hello carried every record, and every change sent every record
  to every device.
- **Git streams wait for their reader.** Each end of a git stream tells the other how much it has
  taken (`ack`), and a writer waits while a window (1 MiB) is not yet taken; the local helper's
  socket pauses the stream when git reads slowly. Before, a slow reader let a pack pile up in
  memory, up to the 2 GiB fetch limit.

## Smaller fixes found on the way

- A device sends its own hello before anything else on a connection, and handles each connection's
  messages one at a time in the order sent. Before, a room message could arrive, or be handled,
  before the hello it depends on, and be dropped.

## Not done

*Since [0053](0053-reaching-each-other.md): devices also reach each other through a device both
reach, over TCP to a server's address, and over one link per pair of computers.*

- **Fewer connections than every device to every other,** for workspaces of many devices: not
  needed at this size (Hyperswarm allows 64 connections to a node by default).
- **The trust model** (0038): a link holder is a full member, a removed member who still holds a
  link for anyone can join again with a new device, concurrent removals can split the workspace,
  and a copied folder is the same device. These belong to the trust redesign, not to the network.
- A relay offered by a member is only as reachable as that member's network; there is no choice by
  measured speed.
