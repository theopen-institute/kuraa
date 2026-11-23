# 0038 · Equal peers: every member has the same say

Supersedes the trust model of 0032 (accepting work), 0033 (rules for documents) and the parts of
0035 about rules. The trust model is to be redesigned from scratch; until then, it is as simple as
it can be.

## The model

Every device of a workspace is a member, and every member has total control, the same as every
other. Every member's work comes in, on every branch, and every member's changes to the members
are taken. Nothing is held back, kept out or opened read-only. Signatures stay, for attribution
only: who wrote what.

What remains of the machinery is about convergence, not trust:

- **Merges** are the same on every device (0025): two devices merging the same commits make the
  same commit.
- **Version skew:** between two devices that merge differently (another version of kuraa), only
  the one with the lower key makes the merges, and the other takes them, so their histories never
  part.
- **Shared rooms** are committed by the device with the lowest key among those that have the room
  open. Every device sees the same devices in the room, so they agree without a setting. (Since
  [0077](0077-one-leader-per-room.md) that device leads the room's session: it alone writes it,
  commits it and brings git's changes into it.)

## What any member can do

- Read and change everything, on every branch; their work reaches everyone.
- Invite people: make an invite link (0028, below), for one person or anyone, for a day, a week
  or with no expiry; list and revoke the links it made.
- Remove any other member, for good (a signed `remove` record, passed on by every device). The
  removed device keeps its copy and stops syncing.
- Rename its own device.
- Fork the workspace (`kuraa-host fork`), as before.

On a shared server, people using the app do the first three only where its operator allows
(`--allow-invites`; a hub of many always does). The command line does all of it.

## One kind of invite link

Invitations (one-time, redeemed only at the inviting device) and subscription links are one
thing now: an **invite link** (`kuraa-invite:…`), signed by the member that made it, checked by
any member, which lets the device presenting it in. It says who it is for:

- **One person:** the first device it lets in uses it up. The device that let them in puts a
  `revoke-link` record on file, named `used`, so no device lets anyone else in by it.
- **Anyone with the link:** as often as it is used, until it expires or is revoked.

Either expires after a day, a week, or never. One join path, one list, one revoke
(`kuraa-host invite [--anyone] [--hours N | --forever]`, `invites`, `revoke-invite`; `link`,
`links` and `revoke-link` stay as other names).

## Known weaknesses, left to the redesign

These are deliberate: they follow from every member having the same say, and fixing them is the
redesign's job, not this one's.

- **A link holder has full power.** Whoever has a good link joins as a full member, and so may
  invite others and remove anyone, the first device too. A link for anyone, with no expiry,
  leaked, is a way in until someone revokes it.
- **A link for one person can let in two,** if two devices that have not yet heard of each
  other's use let one each in at once.
- **Concurrent removals can split membership.** If Ada removes Bo while Bo removes Ada, each
  device takes the record it hears first; devices that took one refuse the remover named in the
  other, and the workspace can part in two.
- **The workspace secret cannot be rotated.** It is in every link and every copy; a removed member
  still knows it, and can find the workspace's devices (though not be let in).
- **Copies of a folder share a device key.** Copying a workspace's folder copies
  `.git/kuraa/device.json`: the copy is the same device to the others. Use `kuraa-host fork` or
  join again instead.

## What was removed

Acceptance rules by branch (an integrator; proposals waiting to be accepted), rules by folder or
file (keeping this device's version; declined files; **Take theirs**), published rules records,
documents opening read-only with **Edit anyway**, membership rules (`acceptsFrom`), the `accept`
command, its HTTP endpoints, the menu's parts for them, and their tests. Merges no longer take a
list of files to keep. `kuraa-host signing-key` now prints the key commits are signed with: this
computer's signing key for its person (0035), not the device's connection key.

## You on this computer

A person's identity and this computer's signing key (0035) are made automatically: the identity
from your name, the first time the app knows it (on first run, from git's name, or when you set
it in Settings). The menu says "You on this computer: Ada". The keys, the `kuraa-id:` line to copy
to a second computer (whose own identity it replaces), and revoking a lost computer's key are
under **Advanced**.

## The online copy

The sync remote (0032) and backups (0036) are one thing now: an online copy, in
[0039](0039-online-copy.md).
