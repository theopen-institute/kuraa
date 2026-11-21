# 0053 · Devices reach each other through each other, over TCP to a server, and over one link per pair of computers; and say how they are connected

A second review of the peer layer, setup by setup: two devices on one network, on different
networks, behind routers that change ports for each connection (phone hotspots, carrier CGNAT,
many offices), on networks that block UDP (many companies and universities), with an always-on
server, and hubs sharing many workspaces with the same people. Two of those did not work at all:
both devices on hard networks with no third device to relay, and UDP blocked. One link could
seem online for many minutes after the other end had gone.

## What changed

- **A local connection that goes quiet closes.** Connections of the peer layer's own (local
  network, TCP, tunnels) send keepalives every 5 s; 15 s without anything, and the link closes
  (`QUIET_MS`). Before, a laptop that slept or left the network stayed "online" until TCP gave up,
  many minutes later, and the DHT could not connect again meanwhile (a device connected locally is
  not connected to again through the DHT).
- **The local network, on every network the computer is on** (`lan.ts`): the multicast group is
  joined, and said on, for each IPv4 interface, not only the one the system routes by (with a VPN
  taking every route, or Ethernet and Wi-Fi both up, that one is not the local network).
- **Through a device both reach: tunnels** (`link.ts`, `node.ts`). A link can carry another
  device's connection, on a channel of its own (`kuraa/tunnel/1`, with the same flow control as
  git's). When a device hears that a member it cannot reach is connected to a device it is
  connected to (`present`), the lower key of the two dials directly for a while
  (`tunnelAfterMs`, 20 s), then asks that device to pass a connection on. The two run Noise inside
  it, end to end: the device between passes on bytes it cannot read, for a member of its workspace
  to a device of it, at most 16 at once for each. Git, rooms and everything else go over it as
  over any link, and a direct connection made later takes its place. This is what lets two devices
  on hard networks work together without a relay, and a device whose network blocks UDP reach the
  others through a server (below).
- **One link per pair of computers** (`also`). When a link opens, each end tells the other which
  of its computer's other workspaces it is in, as a code from each workspace's secret (only a
  device that knows it can tell which), with its device in it hidden by the same. For each
  workspace both computers are in, the lower key connects over this link, as a tunnel that ends
  at the other computer's device of that workspace. A hub sharing many workspaces with the same
  people then connects once, not once a workspace. Devices of one process are known to each other
  (`localNodes`, by computer: tests run several in one).
- **TCP, and a server's address** (`tcp.ts`). One TCP listener for the process, for every
  workspace's device: a device connecting says first which device it is for (`kuraa <key>`), then
  the two run Noise, as Hyperswarm's connections do. The local network uses it (its announcements
  say its port). A server given `--peer-port` and `--public-address` takes connections there from
  anywhere, tells the members (hello, `tcp`), who remember it (`.git/kuraa/hints.json`) and connect
  to it whenever they start, look for a missing device, or cannot reach the DHT. Networks that
  block UDP usually let TCP out, on port 443 at least.
- **Invite links say other ways in** (`hints`, not signed: a link changed to name others gets its
  holder nowhere, as every connection proves the key it reaches): relays named, and servers that
  take TCP (`key@host:port`). A device joining from a network that blocks UDP, or from a hard
  network to a workspace whose devices are on hard networks too, gets in through them, and goes on
  reaching that server the same way.
- **Relays named in the settings are shared** with the members (hello, `relays`), and remembered:
  one person naming one helps the whole workspace. Members' relays on a public address come first
  (`relayPublic`), and the hello is said again once this computer's network is known, so a device
  on a hard network stops offering a relay that would not work.
- **A server as a starting point.** `--dht-port` runs its DHT node on a fixed port; with a public
  address, the members are told (hello, `dht`) and start from it as from the bootstrap servers
  (and keep it, `dht-nodes.json`): the workspace no longer depends on servers run by others.
  `--no-serve-dht` keeps a server from serving the public DHT, which a public address does after a
  while by default.
- **Saying how it is going.** **Devices** says how each device is connected: on this network, by
  its address (TCP), through another device, or simply online (the DHT, directly or by a relay);
  and for one offline, when it was last seen (kept between runs). Above, when this computer's
  network is hard (connecting may take a minute, or go through another device), or the DHT cannot
  be reached at all (UDP blocked, or no network: only the local network and servers by address
  then). The desktop app keeps its log in a file (Help › Show Log File).

## Not done

- **Telling a relayed connection from a direct one** in **Devices**: HyperDHT does not say.
- **Choosing a relay or a device to go through by how fast it is.**
- **Joining through a tunnel**: a device joining reaches a member directly, by a relay, or over
  TCP; not yet through another device.
- **Public relay servers** for everyone: see the review that led here (no fixed authority; a
  server of a workspace's own does the job for it).
