# 0033 · Rules for documents, published, and people

*Superseded by [0038](0038-equal-peers.md): there are no rules for folders or files, no published rules, and documents never open read-only. People (now 0035) remain, for attribution only.*

Builds on 0032 (each device decides whose work it accepts). Still not security: the files on a
device are its owner's, who may edit them directly or fork. The rules say whose changes a device is
interested in, and now the app can say so before anyone edits.

## Rules name branches, folders and files (`peers/accept.ts`)

A rule is a branch, a path in it (`''` the whole branch, `dir/` a folder, else a file) and the
devices or people whose work comes in there on its own. The most specific rule for a file counts.

    kuraa-host accept main --path chapters/ ada        chapters/ only from Ada (a person, or a device)
    kuraa-host accept main --path chapters/ everyone   back to everyone's

- **A whole branch** refused: the other device's work waits as a proposal (0032), its history and
  all, until accepted.
- **A folder or file** refused: the other device's history comes in, but this device keeps its own
  version of what the rule covers (a merge that says "Kept this version of …"; when their work would
  have fast-forwarded, a merge all the same). So one refused edit does not hold back everything after
  it. The menu's Devices section lists the files where another device's version differs, with
  **Take theirs**, which puts their version here as an edit of this device's.
- **What keeping means for others:** keeping a version is this device's change, made after the
  other's. Devices that take this device's work on that file take its version too: if Ada's device
  keeps its own `chapters/one.md` against Bo's, a device that takes `chapters/` from Ada ends up with
  Ada's, Bo's own among them if his rule says so. Following someone on a file means following what
  they keep.

## Live editing follows the rules (`peers/rooms.ts`)

A device applies another's live edits to a document only if it would accept that device's commits
to it; otherwise rooms would be a way round its rules. It sends its own edits to every device with
the room open, and each takes them or not. Devices that accept each other's edits on the document
hold the same room, and the lowest key among them commits it; a device none of the others there
accepts commits only what was edited on it (the host tracks edits made by its own clients), so
nothing is committed twice.

## Rules are published (`records.ts`, kind `rules`)

Each device publishes its rules as a signed record whenever they change, and when it starts
syncing; the latest of each device counts, taken from any member. So every device knows every
other's rules, also while it is offline. (Before this, they went only in the hello.)

## The editor says when others would not take your edits

For a document, the host lists the devices (or their people) whose published rules cover it and do
not name this device or its person. The editor then opens it read-only, with a banner naming them
and **Edit anyway**; edits made anyway stay on this device, and in any fork. The Source view follows.

## People (`peers/person.ts`)

*Since 0035: a person's identity vouches for a signing key on each of their computers (records
`signs`, `vouch`, `revoke-key`), which signs their commits; the `person` record below is gone.*

A person's key is kept outside any workspace (`~/.kuraa/person.json`, or `KURAA_PERSON`), the same
on each of their computers. In the desktop app, **Your key** in the menu's **You** section (beside
the display name) makes it, shows whose it is, copies it (one line, to keep private) and imports it
on the next computer; the workspaces then restart, each saying so to the other devices. A browser
does not show it: the key belongs to whoever runs the host. From the command line:

    kuraa-host person create "Ada Lovelace"
    kuraa-host person export          on the first computer: one line, to keep private
    kuraa-host person import <line>   on the next

A device acting for a person says so in each workspace it syncs (when it starts, or
`kuraa-host person use`), in a record it signs carrying the person's signature: no device can claim
to be someone's without their key, and no one can claim another's device. Rules, and whose
membership changes a device takes, may then name people: their work comes in from whichever of
their devices. Names in `kuraa-host accept` are device names or people's names.

## Not yet

- People who edit through a shared host in a browser all count as that host (0034: every host is
  one person); signing in, each with their own key, is a layer for later.
- Changes to the rules made with `kuraa-host` while a host runs reach other devices when it next
  says hello to them (reconnects), not at once.
- Recovering a person's key that is lost: there is none; make a new one, and the rules that named
  the old one name the new one.
