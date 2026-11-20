# 0032 · Each device decides whose work it accepts

*Superseded by [0038](0038-equal-peers.md): every member's work comes in, and every member's changes to the members are taken; there are no rules, proposals or integrators. The sync remote is superseded by the online copy, [0039](0039-online-copy.md).*

*Rules now also name folders and files, and people; they are published as records; and who commits
a shared room follows from them: 0033.*

Permissions here are not about whether someone may change a document: the files on a device are
its owner's to do with as they please. They are about whether *this* device is interested in
someone's changes. That is each device's own decision, and nothing about it is shared or agreed.
A device that ignores everyone drifts apart, and may always fork.

Before this, an **upstream device** was one setting for the whole workspace, learnt from the
other devices, which bundled three things: whose work comes in, whose membership changes count,
and who commits a shared room. That needed devices to agree on it, and so had a first-come race
and a chain of records to keep it straight. It is gone, and the three are apart.

## Whose work comes in on its own (`peers/accept.ts`, `.git/kuraa/accept.json`)

A device fetches every member's work and shows all of it; its rules decide only what merges into
its branches without asking. By default, every member's, on every branch: "everyone in this
workspace I know of". A rule for a branch names the devices whose work comes in there; others'
waits as a **proposal**, with **Accept** in the menu's Devices section. An integrator is a device
whose rule for `main` names only itself; devices that want the integrator's `main` and nothing
else name only it. There is no "while it is away" exception: interest does not depend on who is
online.

    kuraa-host accept main self          on main, only this device's own work comes in on its own
    kuraa-host accept main laptop desk   only those devices'
    kuraa-host accept main everyone      back to every member's

## Whose membership changes count

Signed membership records (0031) are taken from every member, or only from the devices named:

    kuraa-host accept --membership self  (an integrator: only its own)
    kuraa-host accept --membership desk

The same rule decides whose subscription links let someone in here.

## Who commits a shared room

Each device says its branch rules in its hello. Of the devices in a shared room, the one with the
lowest key among those whose work every other there accepts on the room's branch commits it, so its
commit is held as a proposal nowhere. Every device has the same hellos, so they agree without a
setting they share. If none qualifies (two devices that each accept only their own), each commits
the room for itself, and their histories part, as they chose.

## Joining

An invitation or link carries the rules of the device that made it; the device joining starts with
the same, its own to change. It takes them from the invitation or link, which came from a person,
not from whichever device lets it in. An invitation or link without rules is damaged.

## No upstream: a sync remote

There is no upstream, no device or remote whose word counts for the workspace. What remains is a
**sync remote**: an ordinary git remote (GitHub, say) that **Sync** fetches from, merges and pushes
to, as any clone of it would, chosen with `kuraa-host sync-remote <remote|none>`
(`kuraa.syncremote`; origin when none is chosen). It is a convenience for one device, not a claim
about which copy is canonical, and a device is never one. Repositories from before this are not
converted: the app is in rapid development, and old versions are not kept compatible.

## Later

Rules name devices; with person keys they would name people (a person's key vouching for their
devices), and checking a commit's signature (0031) would tie each change to its person.
