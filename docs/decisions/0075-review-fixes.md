# 0075 · What a review of security, the network and the data found, and what changed

> Changes how the policy counts geneses, seals and joins ([docs/policy.md](../policy.md),
> [0066](0066-permissions-without-a-centre.md), [0072](0072-ranks-devices-and-changes-not-kept.md)),
> how rooms start again from a changed file ([0027](0027-room-seeds.md), [0057](0057-opening-files-quickly.md)),
> how merges run ([0025](0025-merging.md)), how footnotes are kept ([0008](0008-markdown-cues.md))
> and which requests the host takes ([0037](0037-host-safety.md), [0047](0047-browser-equals-desktop.md)).
> `PROTOCOL` is now 6, `MERGE_VERSION` 5 and the Pandoc type's version 3: devices and clients
> running an older kuraa do not sync or share rooms with these until updated.

The owner asked for a review of security, networking and data coherence, then: "fix all observed
bugs, critical, high, medium, and smaller." What each finding was, and its fix, by area. Each
has a test.

## Security

- **An access code goes only to the server it is for.** A link with `?host=` and no `?token`
  kept the code saved for another server and sent it to the one named: one click gave a stranger
  the code. Codes are now kept by server (the ten most recent), a link's `host` counts only with
  its `token`, and a `?token` alone is this page's server's.
- **The host takes requests only for itself.** Listening on this computer, it refuses a request
  whose `Host` names another (a web page cannot reach it by a name of its own, *DNS rebinding*).
  No `access-control-allow-origin` is sent but to origins named with `--allow-origin`; websockets
  are taken from the server's own origin, a named one, or the desktop app's `file://`. Listening on
  a network, any `Host` is taken, as before.
- **Files under `.kuraa` are read and written without following links** (run-kit's
  `readWorkspaceFile`, `writeWorkspaceFile`: every part checked, opened `O_NOFOLLOW`): a link
  pushed to `/git` could make the workspace's name, its package lists or its LaTeX parts write over
  any file the server's user can. `core.symlinks=false` in every workspace, so git checks a link
  out as a small file; pushes to `/git` run a hook of kuraa's own that refuses commits adding
  links (the repository's own hooks do not run for them); `GET /api/files` reads what it opened,
  not what is at the path a moment later.
- **A hidden path that would break Podman's `--mount`** (a comma, a quote, a control character)
  stops the run, saying why, instead of mounting elsewhere.
- **Images from the web are shown on a click** ("Show image from …"), not as a document opens: a
  collaborator could learn when, and from where, someone read it.
- **A service's files are the operator's alone.** The systemd unit, the launchd plist (both hold
  the access code) and `kuraa.log` are 0600; a server running as a service prints `<token>` in
  place of the code.

## The network and the policy

- **A stranger's genesis never counts.** In a workspace from before 0066 (no pin), every legacy
  genesis counted, whoever signed it, and the seal with the lowest ID won: anyone who could reach
  a device made themselves its only admin and owner. Now a legacy genesis counts only if this
  device holds it as its own (those it held when it first worked the policy out so, made, or was
  welcomed with), or its signer is named by one that counts. Once a seal counts on a device, the
  device keeps to it (`.git/kuraa/legacy.json`). Seals made at the same time: the one naming the
  most geneses that count, then by rank, then by ID.
- **A revoked or expired link lets no one in.** A `join` was judged by its grant alone, so a
  removed person could come back with a new identity and the link they had. Now:
  - `unlink` (an admin of the group's) refuses every join not in its past; revoking a link makes
    one.
  - Links sign `kuraa-grant/3`: a join by one counts only where an `admit` of its signer, made by
    the device that let it in after checking the link's expiry by its own clock, is in its past.
    The policy reads no clock.
  - Links from before (`/2`) still count without one; each device unlinks its own revoked and
    expired ones.
- **Records from a stranger are not kept.** A hello's proof is taken only for records about the
  device that sent it, and kept only if they show it is in; checked once a second for a device,
  60 a minute in all. Records are written once a batch, and whole (a file beside them, put in
  their place), and stay the ones read until they are: a read while they were written found none,
  and a policy with nothing in it (no grant in an invite link made just then).
- **No clock in the policy.** An attestation's expiry counted by each device's clock, so two
  devices could disagree about who may write. Now an attestation lapses once its verifier has
  made another dated after its expiry.
- **Live edits are judged by who made them.** A room update passed on by a device says which
  device made it (`origin`); both must be allowed to change the file, and a device passes on only
  updates it would take itself. Before, the device passing it on was judged, and its commit
  signed the change as its own.
- **Presence and credit are a device's own.** A device sets cursors and names only for its own
  editors; co-authors are named as the records say (a name, and an email only where a verifier
  checked it), not as a message says.
- **Smaller:** a stream's unacknowledged data past twice the window closes the channel; a commit
  naming a policy operation no one holds is judged by the policy held, once the device it came
  from says it holds none; LAN announcements are tagged with the address they came from; commits
  from other devices adding links, or paths that differ only by case or Unicode form from another
  path in them or a rule's path, are refused (a Mac's or Windows's disk would take `Secret/x.md`
  as under a rule on `secret/`).

## The data

- **A room no one is in starts again from a changed file**, as a new room (generation
  `blobId(text)`), and is no longer patched: two devices patching the same commit into rooms of
  one seed doubled it when they met, and a warm room's old text could be written over the merged
  file. A room is held back from a merge only while it is live and shared; one left while a
  device that may write still has it open is not committed here. A cached room is resumed only if
  its file has not changed.
- **Marks on citations, maths, images and raw text survive the room.** y-prosemirror kept marks
  on text only, so `*[inaudible]*` lost its emphasis at the first edit anywhere in the block. It
  is patched (`patches/y-prosemirror@1.3.7.patch`) to keep a node's marks; the format tests now go
  through the room as well.
- **Merges use no settings of this computer's or this repository's** (`Git.forMerging`): a
  `merge=union` in someone's `~/.gitconfig` made their device merge otherwise. A merge's trailer
  carries a hash of how it was made (`mergeSignature`, the git version included); another device
  makes a merge again, to check it, only where its own would say the same.
- **The same merge on both sides of a refusal.** The device whose own change was refused merged
  it in, the other kept it out; each now judges both sides. Where both sides' changes were kept
  out, the file stays as it was where they parted, and the gate takes that.
- **Footnotes are not moved as people edit** (0008): moving a note deleted it and put it back, and
  someone typing in it at that moment lost what they typed.
- **Edits not yet sent survive a room started again**: the client carries what the host had not
  acknowledged into the new room, merged, and forgets the old room's cache.
- **Whether a file changed on disk is told by its blob id** (sha1), not a 32-bit hash.

## Not done

- Per-file write permissions for edits a shared network server takes from its own clients: all of
  them use one access code, so the server cannot tell who made an edit. That waits on the design
  for a server many people sign in to (0066).
- A guessed hidden commit's existence can still be tested by upload-pack's acknowledgements;
  closing it means serving each device from its own objects.
- A room's bulk state, when a device first joins it, cannot be traced to who made each part.
- Two admins sealing a legacy workspace apart, before either device has kept to a seal, stay split.
