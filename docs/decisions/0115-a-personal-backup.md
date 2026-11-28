# 0115 · The online copy is a personal backup

Changes [0039](0039-online-copy.md) and [0059](0059-online-copy-is-a-component.md). The owner,
on seeing how work from the online copy was judged:

> "I wonder if this is the wrong approach. Perhaps we should think of the "online copy" as just a
> personal backup? Maybe with just one-way sync, or possibly two-way sync but just for the online
> copy's "owner" (which may be different from the workspace's owner)?"

And, given the choice: two-way, for its owner alone; called **Personal backup**; a word on its
privacy on GitHub or GitLab.

## Why

The online copy came before servers. It was where devices met that were never online at once, a
mailbox anyone in the workspace could share. But it is no member of the workspace: no key, no join,
nothing the policy names. What came in from it was judged as from *no device* (gate.ts, `from`
undefined), and that judged it more loosely than work from any device:

- **A commit no one known signed** (unsigned, as plain git makes it, or by a key that is no one's)
  was no one's, and so taken wherever no rule names the file. From a device, it is that device's
  person's, and from a device no one in, refused (0099, 0112). So whoever could push to the
  repository changed every file no rule names.
- **Devices could judge one commit two ways.** The device that fetched it judged it as no one's; a
  device that took it from that one judged it as that device's person's (0099). Where the rules
  differ for the two (a file only that person may change), the two make different merges, which
  every device must make alike (0025).

Since [0099](0099-servers.md), servers do what the mailbox did, as members: known by their key,
judging what they hold by the policy, taken out by the owner, writing nothing. So the online copy
need be no meeting place for people, and becomes what it was mostly used as: one person's backup.

## What it is now

- **Its person's.** A backup is set up on a device, with that device's person's git credentials
  (as before: `kuraa.online` in the repository's config, per device). What is fetched from it is
  brought in **as work from one of their own devices, this one** (`Peers.asOwnDevice`, around
  `Host.bringInFrom`): a commit someone known signed is theirs, as ever; one no one known signed is
  this person's, judged by what they may change. Every device that takes it from here judges it as
  this person's too, so all judge it alike.
- **Two ways, as before.** Each save is pushed to it; it is fetched from and merged on Sync and every
  few minutes; never forced. So one person's computers still meet through it when they cannot reach
  each other directly, each with the same address added.
- **Not for two people.** Each person's devices take what is in it as their own person's: a backup
  two people share lets each act as the other, within what each may change. The app says it is
  yours alone, and that a server is how to meet others. Nothing detects a shared one: a commit by
  someone else, in the backup and not yet here, is ordinary (it reached this person's other computer
  first, which pushed it), so there is no telling sharing from that.
- **Whoever runs the git host, or can push to it, is trusted as its person.** As with their laptop:
  someone who can push there can change whatever they may change. So the help, where an address is
  added, and the README say: make the repository private and share it with no one; whoever can read
  it reads every file but those in spaces, whatever the workspace lets them read; a public one
  publishes the workspace.
- **A server keeps none** (as since 0099): a server has no person, and no credentials of one.
- **A workspace not shared** with other devices judges nothing it brings in, as before: there is no
  policy, and everything is its person's anyway.

## Words

**Personal backup** where people read it: the component's label (`Personal backup`), its
description and help, the workspace's sync lines (*Personal backup: up to date*), **Sync now**
(*3 saves not in your backup yet*), its errors (*Cannot reach the backup…*), the README, and the
command line, where `kuraa-host backup` (already another name for `online`) is now the one its usage
and messages give. The sync's id stays `online`, and with it `/api/syncs/online`, `kuraa.online`
in git config and `kuraa-host online`: installed devices and their configuration keep working.

## Not done here

- **What a backup holds is as before**: the workspace's own branches (`refs/heads/*`). No space goes
  there, and no policy record (they are kept in `.git/kuraa/records.json`, not in git), so a
  backup cannot yet bring a shared workspace back onto a new computer by itself: that computer
  joins by an invite link, and then adds the backup. Carrying a person's records, and the spaces
  they read, would make it a whole backup, and widen what sits on a git host; a decision of its own.
- **One-way only** (pushed to, never fetched from) was weighed and not chosen: it would give up one
  person's computers meeting through it.
- **A branch new to this device** is still taken as it comes, from a backup as from a device
  (`Host.bringBranch`: no history of it here to judge against). Not changed here.
