# 0073 · Spaces a device can hold without reading them (proposed)

**Status: proposed. Nothing here is built.** It adds to [0066](0066-permissions-without-a-centre.md)
(spaces) and [0072](0072-ranks-devices-and-changes-not-kept.md) (folders that hold their space).

The owner asked for a plan for encryption on top of spaces, after a review that said spaces are the
right read boundary and that encrypting files inside one shared repository is not (0066, *Why not
encrypt files inside one repository*: one history leaks what its commits say, a device that cannot
read a file cannot merge it, and a lost key loses data).

## What it is for

A space is sent only to its readers' devices. So a server that is always on, a relay, a backup, or
the online copy ([0039](0039-online-copy.md)) can hold a private space only by being one of its
readers, which means reading it. Teams want their server to hold and pass on everything while people
are away, without it reading what it holds. That is all this is for.

It is not a second read boundary. Readers still read in the clear on their own devices, and merging,
the write gate and live rooms are as they are, among readers.

## Keys

- **A key for each computer, to open what is sealed for it.** Each computer's signing key (one per
  person per computer, 0035) is an Ed25519 key; the matching X25519 key (libsodium's conversion)
  opens what is sealed for that computer. No new key to keep or vouch for: a computer in the
  workspace (0072) has one, and a key dropped or revoked stops being sealed for.
- **A key for each space, by epoch.** Each space has a symmetric key; its first epoch is made with the
  space. Each epoch's key is sealed for every computer of every reader in a **lockbox** record
  (`{space, epoch, for: signing key, sealed}`), signed by the device that made it, passed on to
  every member: what is in it is sealed, and who reads the space is in the policy already.
- **A new epoch when someone stops reading.** When a reader is taken out of the audience, or one of
  their computers is dropped or revoked, the first reader's device to see it makes the next epoch
  and its lockboxes. What was sealed before stays readable to whoever could; nothing after is. Two
  readers making the next epoch at once: both count, as two keys of the same epoch, and what either
  sealed opens.
- **A new reader, or a reader's new computer:** any reader's device seals the current epoch's key,
  and the past epochs' (they are sent the space's history, 0072), for it.

## What a holder holds

A **holder** is a device the policy names as holding a space it does not read (an admin's to name,
as witnesses are, 0072). It never merges a space or judges its commits: it keeps **packs** and
passes them on.

- A **pack** is a git bundle of a space's commits since the pack before, sealed with the space's key
  for its epoch (XChaCha20-Poly1305), signed by the reader's device that made it, named by its hash
  and the packs it follows.
- Readers send their packs to holders as they commit (a channel of their own on the link), and take
  packs from a holder when no reader is reachable: each opened, its bundle fetched into the space's
  history, and judged by the write gate, as anything that comes in is.
- **The online copy** keeps a space's packs as blobs on a ref of its own (`refs/kuraa/packs/<space>`),
  so a git server holds them as it holds anything, unable to read them.

## What it still says

A holder learns that a space exists, how big its packs are, when they come, and which devices send
them. It learns no path, no file, no commit message, no name. The policy still names each space's
audience to every member (0066 step 5); sealing audiences to themselves is a later step, here or
apart.

## Order of work

1. Opening keys from signing keys; space keys, epochs and lockboxes; new epochs on narrowing.
2. Holders named in the policy; packs between readers and holders over the link.
3. Packs in the online copy.
4. Audiences sealed to themselves in the policy.

## Open

- A reader who loses every computer loses nothing a holder keeps for them (other readers seal for
  their new one), but a space whose readers all lose theirs is gone, held sealed: as a space whose
  readers lose their copies is now.
- How long a holder keeps packs that every reader has: for good (a backup), or until told.
- Whether a holder may be a reader of some spaces and a holder of others (yes, by policy, it seems).
