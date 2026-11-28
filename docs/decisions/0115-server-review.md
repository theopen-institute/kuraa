# 0115 · Servers, reviewed again: links bound to their holders, rules the owner moves to, and running one

**Status: built.** `PROTOCOL` 13, and a version of the policy's rules (13) that each workspace's owner
moves it to. Changes what an invite link is and how a device proves it holds one, who may override what
in the policy, how spaces are named, how the gate waits for what it lacks, the network's and the disk's
limits, how a server updates, what it keeps when taken out, how it gives up its key, and what owners
and operators see of it. Adds to [0099](0099-servers.md), [0110](0110-the-owner-reads-everything.md),
[0111](0111-people-first.md) and [0112](0112-server-hardening.md). For release as 0.13.0.

Once 0112 was merged and 0.12.0 released, the owner asked: *"Please do another comprehensive and
critical review of the server architecture."* The review found two holes in the policy's rules, one
made worse by 0112, and defects in running a server; each critical one was reproduced on the released
rules by a script before anything was changed. The recommendation was in three steps: the holes, with
a version for the rules, as protocol 13; the operational defects; then the larger items. The owner:
*"Do everything, now"*.

## What was found, and what is done

### An invite link worked for whoever saw it

A device joining by a link showed the whole link, its signed grant too, to whatever device answered
it, and every member and server listens for joiners. Any of them could keep the link, and let in a key
of its own choosing by it: a compromised server made the owner's admin link a made-up admin; a member
made the owner's link for a server a server of their own, which reads every space.

Now **each link has a key of its own**, made with it. The grant the inviter signs names that key
(`kuraa-grant/4`, `boundGrantMessage`, with what a server's join reads); the link carries the key's
secret half (`k:`) to the person it is given to, and the hash of the workspace's secret (`h:`), not the
secret. A joining device shows the link **without** the secret half (`withoutSecret`), and the key's
signature of its own signing key (`linkProof`, `linkProofMessage(workspace, link, signer)`); its join
carries the key and that signature, and counts only with both (`grantOf`). A device it showed the link
to holds neither the secret half nor any way to sign for another key. A device lets in only a joiner
whose proof holds (`linkProven`); a server, only by a link of its own key: one from before lets in
whoever saw it.

Links from before stay in the history, as they counted then. Under rules 13 (below), any admin's
device unlinks each one for anyone still open, so a link seen once lets no one else in; a new link is
made as before, and is bound.

### Choosing old parents to beat the owner

Each policy operation names its parents, and its maker chooses them: an operation can claim to have
been made at the same time as one long past. Two made at the same time are settled by *restrictive
wins* (0078), whoever made them. So an admin could, with old parents, demote another admin, undo a
handover of the owner's role, or unlink the owner's link for a server after the fact, taking out the
server and everyone it let in (who were then deleted from it).

Now, under rules 13, **what anyone ever made an admin, or the owner, is, the owner alone undoes**, and
they themselves (`guarded` in `allowed`, `mayOverride` in `settle`):

- *Ever* is over the whole history (`everAdmins`: anyone a grant, a join or an `owner` operation ever
  made an admin or the owner), not the operation's own past, which its maker chooses.
- A grant, revoke or drop by a non-owner naming such a person is not allowed.
- Of two at the same time, one beats the other only where its maker may override: the person it is
  about, or the owner in the operation's own past. A removal's, a drop's, a lesser place's and an
  unlink's edges are each so guarded; others are as before.

The owner and anyone not ever an admin are judged as before.

**A known limit:** a former owner's operations made with parents from before their handover are
judged in that past, where they were the owner. Handing over is so a matter of trust in whoever hands
it over (as it is in fact: they held everything until then). A former owner whose key is lost is dealt
with by dropping that key.

### Spaces "made again" by someone else

0112 had a space made by two at once read by no one but the owner. Any member could then "make"
someone else's space again with old parents, and its readers lost it, its maker could no longer change
it, and only the owner could put it right.

Now **a new space's ID is its maker's**: the hash of the workspace, its maker and a nonce
(`spaceIdFor`, the `space` operation's `nonce`). A making with a nonce counts only where the ID is its
maker's; once a space has been made so, no one makes it again without one (`nonceSpaces`). Spaces
from before keep 0112's rule.

### A version for the rules

Every change to the rules applied to the whole history, at once, everywhere: a flag day, carried by a
server to every owner's workspaces on it. Now the rules have a version, in the policy: a **`rules`
operation**, the owner's alone, says which (13 now; none, 12). The policy is worked out by the rules
before, and again by the version the owner said, over the whole history (`evaluate`, two passes): a
version only some operations were judged by could be avoided by choosing parents from before it. The
owner's device says 13 itself, once it runs this release (`adoptRules`). A version newer than the
build knows is shown as such (`rulesUnknown`): that device is to update.

The protocol, likewise, now says the oldest it still syncs with (`minProtocol` in the hello;
`protocolsMeet`): two devices sync where their protocols overlap, not only where they are the same.
This release's oldest is 13 itself, as 12 cannot prove it holds a link.

### What a server is, asked of one place

About a hundred branches across seven files asked whether a key was a server's. Now the policy says
what a kind of member does (**`Policy.can(id, capability)`**: `change`, `readAll`, `merge`, `relay`,
`exposed`), and the code asks that. A server's join now says what it reads (`reads: 'all'`, the only
value for now), so a server that reads less, when spaces can be held sealed
([0073](0073-encrypted-spaces.md)), needs no new rule for its join.

### The gate, with less of the history than there is

The write gate judged a commit by the policy the device held. A server could hold back someone's join,
and their work was refused for good. Now:

- Work signed by someone whose join has not come **waits** for it, ten minutes at most, rather than
  being refused (`waitForPerson`).
- The operations a device counts as known are only those whose whole past it holds (`rootedOps`). Ones
  asked for are sent with their pasts (up to 2,000).
- A server's word that it lacks some operations is not taken (its `unheld` ignored).

### Port 5872, again

The first line's slot was let go before the encrypted handshake, whose timer reset on every byte.
Anyone who knew one of a server's device keys could open tens of thousands of connections, until it ran
out of files. Now:

- A connection stays counted until it is let in, with a deadline of 5 seconds for its first bytes and
  15 for its hello, which no byte puts off (`settled`).
- One evicted is let go of at once.
- Links not let in are evicted the busiest address first, never one that has said hello: an honest
  joiner is no longer the one made to wait.

### The disk

- **Each fetch is limited to the room left** (less 1 GB), not only checked before it starts.
- With less than 10 GB free, fetches run one at a time, across all of a server's workspaces.
- The 64 GiB limit for a workspace's first copy is dropped to 2 GiB once it is made, not at the next
  restart.

### A server's process and its updates

- **A lock left before a reboot** is not taken as held (it records the boot it was taken in).
- A start refused for a lock is not counted against the version as a failure.
- **A release that changes the protocol** is placed once devices of two of a server's workspaces run
  it (of its one, if it holds one), not on one member's word. A release held is kept on disk through a
  restart, and placed only if its folder is still there: else the rollback that followed marked a good
  release as failed.
- The service unit's `%` and `$` are escaped as systemd reads them.
- **The release's signing job checks the archive before signing it**: its entries are all in its own
  folder; it says this release's version and a protocol; it carries this key's public half.

### Taken out of a workspace, and a new key

- **Removed**, a server now **keeps its copy a week** (`--keep-removed-days`), in case the removal is
  undone, and deletes it only if still out then. A removal could stop counting after the fact. **Blocked**,
  it deletes its copy as soon as it hears. 0112 dropped the grace for a removal; it is back, as this
  review found a removal can be undone by the history.
- A server removed before is **still the owner's to block** (**People › Removed servers**): its key may
  have gone astray since. No longer connected, it does not hear it; its copy goes when the week is out.
- **`server new-key`** could lose its own block: the sweep took the server's drop of its own key for a
  block, and deleted the copy, the drop with it, before any member had it. Now its own drop keeps the
  copy (`retired`). The second step refuses where the drop did not count, or no member was online to
  hear it, in any workspace, and runs only in a server's folder. It deletes the copies first and moves
  the key last, so a step cut short is run again.

### What owners and operators see

- **A server says how it stands** to the members connected to it, now and then: the room left on its
  disk, when it last took in work, whether it has stopped for want of room. Shown in its view under
  **People**.
- **Metrics**: `GET /hub/api/server/metrics`, with the access code, in Prometheus's text format, each
  workspace by its ID, never its name.
- **Handing over the workspace** names its servers, which go with the role, and says who then reads
  what.
- A member relies on a server to pass a member's work on only where the server's branch holds that
  member's latest; one that has not taken it in 30 seconds after the member said it, it fetches from
  the member directly.
- Peers' names are cleaned wherever they are logged, of characters that turn text around too.
- `server status` works out folder sizes two at a time.

## Not done

- **Holding every space, per device.** An owner's devices hold every space (0110); a phone would rather
  not. A choice for each device is for when there are phones.
- **Who a commit is by still depends on the route it came by** where no one known signed it (the
  bringing device's), and the server role is still a flag on the whole hub process. Neither is wrong
  for one server acting for one owner; both are to change for a server shared by many owners.
- **Removal's quarantine is by time**, not "until members hold everything it had": a member cannot
  yet tell that of a server's copy.
- **Scale**: each workspace on a server has its own swarm and a full host. A server waking a workspace
  when a member connects, and one presence for all, are for when servers hold many.
- **One server for many owners**, **third-party document types on a server** (0112), and **spaces held
  sealed** (0073): as before.
- The release workflow's new check is proven only by the next release (it was run here on archives
  made as the build makes them, the right key passing and another refused).
