# 0112 · Servers, hardened: what a review found, and how each is fixed

**Status: built.** Changes how commits are judged (gate.ts), the policy's rules for joins, admits,
spaces and a server's own key, the network's limits, how servers update themselves, what a server
keeps when it is taken out, and what owners and operators can see. Adds to
[0099](0099-servers.md), [0110](0110-the-owner-reads-everything.md) and
[0111](0111-people-first.md); rides on `PROTOCOL` 12 (0110), still unreleased.

The owner asked, once 0110 and 0111 were merged: *"do another comprehensive review of server security
and design. Make any recommendations for improvements"*, then, of the recommendations: *"Yes, fix
everything and verify"*. Three reviews, each of one part (trust and policy; the network, the process
and updates; design and operation), read the code without each other's conclusions; what they found
was checked in the code before anything was changed. Several findings were not servers' alone: a
member could use them too.

## What was found, and what is done

### Who a commit is by (the gate)

- **A key no one let in could change files.** A key's person was taken from the records, which any
  member (a server too) may add to: an identity of someone's own making, its key vouched for, signed
  commits that counted as a person's, and a person may change anything no rule names. Now **a key is
  someone's only where the policy has them in the workspace, or had them** (their cutoff); anyone
  else's is no one's, its commits the bringing device's (refused from a server, or from a device no
  one in). A device's own person likewise. (`membersOnly`.)
- **A merge could drop a protected change unseen.** Only merges of two parents were made again; one
  of three or more was judged only where it differed from every parent, so it could take a file's
  oldest version. A merge of two naming another version of merging was judged only where it differed
  from both sides. Now **a merge of more than two parents answers for whatever differs from any of
  them** (Kuraa makes none), and **one not made again answers for any change a side made that it does
  not hold**.
- **A merge's word that it kept a change out** is judged by the same attribution as any commit
  (`attribute`), where it had its own, looser one.

### The policy

- **Old invite links for anyone.** Every join carries its link's grant, which names no one, and a
  link's expiry is checked only by the clock of the device letting someone in: anyone in the
  workspace, or a server, could let made-up identities in by any link for anyone ever made. Now **a
  server's admit counts only for a link for one person**; **any admin's device unlinks every expired
  link for anyone it knows of**, not only its own; and **no link for anyone makes admins** (the invite
  dialog offers *as an admin* only for a link for one person). A server also turns away a device that
  brings a link for anyone, at its door.
- **A space made again at the same time.** Two makings of one space at once counted together, and
  lists with no one in common fell back to the admins: an admin could read any space by "making" it
  again with old parents, and anyone could give it to the admins. Now **readers said at once are those
  both name, else no one but the owner** (and servers), and a space made by two at once is the owner's
  alone to change.
- **A server's key made a person's.** A vouch for a server's key (only its holder could make one)
  made its join, and every admit it made, count for nothing, taking out everyone it let in. Now **a
  key that signed a server's join is never a person's**. (A member vouching for their own key in a
  second name still makes it no one's, as it always did: only their own past word is undone, and those
  it let in can be invited again.)
- **Two servers** each made merges, as a server always does; between two, now, **the lower key**, as
  between people. (Merges are made alike everywhere, so the endless merging the review feared did not
  happen in a test of two servers; the rule is now the same as everyone's all the same.)
- **A server may block its own key** (a `drop` of it, by it), in every workspace at once
  (`server new-key`).

### The network

- **Port 5872** could be held by anyone sending a byte every nine seconds: a connection that has not
  said which device it is for now has **five seconds from when it is taken**, IPv6 addresses count by
  their /64, and when all 256 places are taken, **the one waiting longest makes way**.
- **Connections not let in** were not counted after their first line: now **64 at most** for each
  device, the oldest making way; on a server, a stranger has **15 seconds** to be let in. A server's
  swarm keeps **1024** connections (Hyperswarm's 64 stopped it reaching members).
- **Fetching:** a server's 64 GiB limit is for its first copy of a workspace only; each fetch after
  is limited as everyone's (2 GiB), and **nothing is fetched with less than 1 GB free**.
- **Hints** (where to reach others) from a device's second hello were taken from anyone let in; now
  only from someone here, at every hello. **The relay's key** goes only to someone here, and the
  relay takes **128 connections** at most (who connects to it is not known: they come by their DHT
  node's key). **What peers say** is cleaned of control characters and cut short before it is logged,
  and a stranger's goodbye is not logged.

### Updates

- **Downloads** are limited (1 GiB an archive, 4 KiB a signature) and read as they come; sent anywhere
  but where asked, or GitHub's own hosts, refused.
- **A release that changes the protocol** is held, not placed, until a device of the server's
  workspaces runs it (then placed, and restarted at once): taken at night, it would have left every
  member on the old one unsynced. `--auto-update-all` takes it at once; `kuraa-host update` puts it in
  place now and says it changes how devices sync. Each archive says its protocol (`PROTOCOL`).
- **`install --service --no-auto-update`**: a server that does not update itself. Since 0110 a server
  holds every space, and the release key is trusted with them all.
- **The release key** is used in jobs of its own in the release workflow, with no checkout and nothing
  installed: one says its public half, which the build (with no secret) puts in the server; another
  signs the archive. Before, it was in the step that ran the build, after dependencies' code had run.
- **The systemd unit** allows 65536 files and 4096 tasks.

### Design and operation

- **A server taken out deletes its copy** as soon as it hears, removed or blocked: it holds every
  space, and invited back it copies the workspace afresh in any case. `server list` and `status` say
  so meanwhile; the Remove and Block questions say so.
- **Whether a server is doing its job:** each member's device sees whether a server's branch holds its
  latest work, and since when it has not; one that has not for ten minutes is **no longer relied on**
  to pass work on (members fetch from each other directly again), and is marked *behind* in People;
  its view says *Holds your latest work*, or since when it has not. **`server status`** says the
  release, since when it runs, how it updates, and each workspace's state, members online, latest work
  brought in and size.
- **`server new-key`**: run while it runs, the server blocks its own key in every workspace it holds;
  run again once stopped, it puts the old key aside and deletes every copy, to be invited again with
  the new one. Before, there was no way but deleting its key by hand, and every owner blocking it.
- **[Running a server](../running-a-server.md)**, for whoever runs one: what it holds and who can read
  it, what to back up, ports, logs, updates, and what to do when its key or its disk is lost.
- **The docs** said the API answered only `join` and `list`, named *People and computers*, and listed
  naming a server among readers as to come (0110 made that moot): put right.

## Not done

- **Third-party document types on a server.** A server merges with the standard features; a document
  type members have and it lacks would be merged wrongly, its merges refused, and that work held up.
  A server saying which types it merges, members merging the rest, is for when components come from
  third parties.
- **Spaces a server holds without reading** ([0073](0073-encrypted-spaces.md)), for servers on
  computers the owner does not control.
- **Measuring scale** (many workspaces, many members, the reconnecting after a nightly restart).
- **A server's key shut out everywhere without it** (a key lost with its computer): owners block it
  one workspace at a time; `new-key --force` starts the server afresh.
- **The release workflow's new jobs** are proven only by the next release.
