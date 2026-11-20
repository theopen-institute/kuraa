# 0035 · Identities vouch for signing keys, one per person per computer

*Superseded in part by [0038](0038-equal-peers.md): keys and identities stay, for attribution only (who wrote what); no rule names them. Your identity is made for you, and the keys are under Advanced.*

Refines 0034 (signatures are people), the way git signing is usually set up: a key on each
computer, tied to one person (as an account lists your SSH keys, or a GPG primary key certifies
subkeys). Copying one secret to every computer is the shortcut this replaces.

## Three kinds of key

- **Connection key** (one per host per workspace, `.git/kuraa/device.json`): connects devices and
  pairs them, and signs what a device says about membership and its own rules. It signs no one's
  work.
- **Signing key** (one per person per computer: per login, `~/.kuraa/signing.json`): made on first
  use, never copied. It signs every commit made on that computer; another person on the same
  computer, under their own login, has their own.
- **Identity** (one per person, `~/.kuraa/person.json`): vouches for their signing keys, and
  revokes them. It signs no commits, and may live on one computer only. Taken to another computer
  (export, import), it vouches there for that computer's key; approving a new computer from one
  that has it, without copying, is for later.

Names stay free text; tying an email to an identity is for later.

## Records (`records.ts`)

- **signs**: this device's commits are signed with this key, with the key's own signature (no
  device claims a key it does not hold). Latest per device.
- **vouch**: this signing key is mine, signed by the identity and by the key itself (no one
  claims another's key, or puts their own key in another's name). Any member may pass it on. A key
  more than one identity vouched for (only whoever holds it could make that so) is no one's.
- **revoke-key**: this key is no longer mine (a lost or retired computer), with the identity's
  signature; kept in `~/.kuraa/revoked.json` and published by each of the person's hosts as it next
  syncs. It counts from when each device takes it, not from a time the record says: what the key
  signs that reaches a device after that is no one's, whatever date it bears (a commit's date is
  whoever made it's word, and a stolen key's holder would date theirs before the revocation). What
  a device already has stays as it is, the person's. A device's live edits, and its work as a
  whole, stop counting at once.

## Who is who

A device is its connection key, the signing key it says it signs with, and the identity that
vouched for that key (unless revoked). A commit is its signer and that signer's identity. Rules
(0032, 0033) may name any of them: an identity, a signing key, or a device. Work comes in if this
device accepts the device it came from, or whoever signed each commit. Merges are no one's: a
device makes each merge it is brought again, and any files the merge has otherwise (a room's text,
a version kept, another version of kuraa's merge, an edit) count as the work of the device it came
from.

## Every host is one person, still

A host signs with the signing key of whoever runs it; people editing through it in a browser are
that person (0034). Several people on one server, each with their own signing key there vouched for
by their identity, fits on this without changing it.

## Where it is managed

The menu's **Identity and access** panel, opened under **You** (the desktop app; a browser where the host allows it,
`--manage-person`, as `pnpm dev` does): this computer's signing key, your identity (make, import,
copy), and your other keys the workspace knows of, to revoke. From the command line:
`kuraa-host person [create | export | import | use | revoke <key>]`.
