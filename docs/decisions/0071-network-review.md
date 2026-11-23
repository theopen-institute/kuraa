# 0071 · What a review of the network found, and what changed

*Since [0078](0078-restrictive-wins.md):* attestations are no longer records.

> Changes how devices serve git, compare records, pair devices and stay connected
> ([0028](0028-peers.md), [0038](0038-equal-peers.md), [0050](0050-networking-review.md),
> [0053](0053-reaching-each-other.md), [0066](0066-permissions-without-a-centre.md)). `PROTOCOL` is
> now 4: devices running an older kuraa do not sync with these until updated.

The owner's direction: "Do a full review of networking and connectable", then "fix everything".
The review covered three areas: reaching other devices, trust in what comes over a link, and
syncing. This records what it found and what each fix is.

## Who reads what

- **Git is served without what it hides.** `transfer.hideRefs` only hides refs from the list
  upload-pack shows. Under protocol v2, upload-pack sends any object asked for by its id, and
  every member could learn the commits of spaces from the cutoffs on record. Upload-pack serving
  a device now runs without `GIT_PROTOCOL` (the device's or the process's), so it speaks v0, which
  takes wants only for what it showed. Asking by id is also refused, however git is configured
  (`uploadpack.allow*SHA1InWant=false`).
- **Branches go only to paired devices.** A hello to a device not paired carries no branches, and
  no invite link unless this device is joining (then it shows the link it joins by). Anyone on the
  local network can connect to a device, since its key and port are in its LAN announcements.
- **Spaces are taken only as the policy says.** A space's history from another device is brought
  in only if the space is in the policy here and both this device's person and the sender's read
  it. Its first arrival is judged by the write rules too, and is taken whole or not at all.

## Who is let in

- **Pairing a device is an admin's word.** A plain member's pairing record counts once the
  person whose device it is has come in by an admin's grant, as the policy says. A device
  admitted by a member's device by invite link counts as soon as its join reaches the others,
  whoever passes the records on. So no member pairs devices the admins did not let in. Two people
  let in by one link for one person each get a device paired, but only the first gets the role:
  the second's device counts only where an admin's device paired it.
- **Grants sign when their link expires and which device made it**
  (`kuraa-grant/2`, and in a join's operation). No member can sign an expired link's grant into a
  link that never expires. Links made before this are refused, with *ask for a new one*. Joins
  already in a policy still count as they were signed.
- **Admission by link is one at a time on each device**, so two devices can't both pass the check
  of a link for one person before it is used up.
- **Records dated more than ten minutes ahead of this device's clock wait** until they no longer
  are. For some records the latest counts (the secret, which key a device signs with, a person's
  name), so one dated years ahead would win for good. A new secret is dated after the latest on
  record, even when this computer's clock is behind.
- **A revocation's cutoff comes from the revoking person's own devices**, once from each. Every
  device keeps them all and takes their commits together. Before, whichever arrived first was
  kept, so devices could judge the same commits differently, and any member could wrap a
  revocation with commits of their own choosing.

## Records between devices

- **Records are compared by what they say.** A person's event, a policy operation or an
  attestation is the same record whoever passed it on. Before, two devices holding the same
  event from different devices never agreed and asked each other for it without end.
- **A want is answered once** (`reply`). Records one end takes and the other cannot yet (a signer
  it does not know) are asked for again at the next hello, not back and forth.
- **Limits.** At most 5,000 records are taken from one message, and at most 100,000 entries are
  read from a want. The policy is worked out once for each set of records. While records are
  taken, who is an admin is worked out once a round, not after each record.

## Reaching each other

- **Hyperswarm bans whomever the firewall refuses, for good.** The firewall refuses a device
  connected over the local network or TCP, so two devices that met at the office never connected
  over the internet again. A device is now let go of when its link closes.
- **Lookups go on** at the last interval for as long as a member is missing. Members missing are
  dialled by key at each lookup, and tunnels are tried again. So devices that missed a change of
  the secret find the others, and a device that reaches its server only over TCP finds it again
  once it is back.
- **When both ends dial at once** over the local network or TCP, both keep the connection the
  lower key started. Before, each kept its own and closed the other's, so both links died.
- **Devices of two computers in several workspaces** keep the tunnel over the link they share
  (`also`), as a direct link is kept, instead of each workspace connecting anew.
- **One relay for the process**, shared by its workspaces, as the DHT node is.
- **On the local network**, the device with the higher key connects if the lower one has not
  within five seconds (its firewall may refuse incoming connections). The LAN socket is opened
  again if it failed, for example when the computer had no network yet at login.
- **Closing while starting** leaves nothing running.
- **Timeouts.** A link through the DHT that goes quiet closes, as the others do. A link that is
  not let in within a minute closes too.
- **Streams and other limits.** At most 32 streams (git, tunnels) from the other end per link. A
  tunnel passed on counts until both of its ways end. Large run outputs are not piled up for a
  backed-up connection, since finished runs come with the outputs ref. Runs under way from another
  device are capped. A device that switches workspace in a later hello is dropped. Branch names
  are taken only as git allows them. The bridge's token is compared in constant time.

## Syncing

- **Retrying.** A failed fetch, work waiting for the policy, or a branch that could not be
  brought in is tried again, with one timer per device backing off to a minute, and at once when
  records come. Before, each waiting branch started a timer of its own on every pass, without
  end, and a failed fetch ended the sync with nothing tried again.
- **Each branch and space on its own.** One that fails no longer stops the rest.
- **Spaces follow the forward-only rule** branches do: only one of two devices that merge
  differently makes the merges.
- **Waiting for the policy is known first**, from the commits' trailers, before anything is
  judged or a room's edits are committed for it.
- **Changes are noticed sooner.** A device's spaces are known from its first hello, and a later
  hello that changes its branches or spaces syncs them (someone given read access gets the space
  at once). A sync in progress reads the newest link to a device, so one that reconnected is not
  synced from its old heads.
- **Work already held is skipped** before it waits in the queue. Announcements of outputs alone
  sync no branches. The spaces are read once for each announcement.
- **Closing** lets go of the write rules only after syncs under way have stopped, and brings
  nothing more in once closing.
- **A live room's text** is used for the file of that branch and that history (the workspace's
  or a space's) only. Before, it was matched by path alone.
- **The commit checked is the commit brought in**, not its ref read again.
- **Tracking refs** move only from what they were.
- **Run outputs** are dated after the last a device published, whatever its clock says. A commit
  fetched but not taken is fetched again.

## Left as it is

- **Committing room edits when work comes in.** Bringing in another device's work still commits
  this device's open edits first. Two people typing at once therefore make more commits than
  needed. Holding those edits through the merge instead needs rooms reworked, so it waits.
- **A grant seen in the policy.** For a link for anyone, its grant in someone's join is as good
  as the link itself to whoever reads the policy, expired or not: the policy has no clock to
  check expiry against. Links for one person are used up. A link for anyone should be revoked
  when it is no longer wanted.
- **Whoever welcomes a joining device first.** A device removed from the workspace that still
  knows a link's topic can welcome its holder with records that leave out the removal. The joiner
  sets this right once it reaches the link's maker or any member (it dials them by key), and the
  removed device's pairing of it never counts with the others.
- **Policy evaluation** still grows faster than the number of operations. It is now worked out
  once for each set of records rather than at every use.
