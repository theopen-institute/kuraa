# 0068 · People, with their computers; one's own removed by oneself

*Since [0078](0078-restrictive-wins.md):* there are no email checks, escrow or email invites: nothing of them is shown.

> Changes Workspace settings' Devices ([0064](0064-four-kinds-of-settings.md)) and who may remove a
> device ([0066](0066-permissions-without-a-centre.md), step 2). What a device is, and what removing
> one does (0050: it stops syncing, for good; a new secret), are as before.

The owner's question:

> "Now that we have users, what's the point of having a button for removing devices from
> workspaces? Aren't devices redundant to people now?"

People are who may do what; devices are what holds a copy and syncs, several to a person. A
device is still what is cut off when a computer is lost or retired, its person staying in. But the
section listed devices as if they were who is in, only admins could remove one (so a member who
lost a laptop had to find an admin), and cutting a lost laptop off took two acts in two places:
removing the device (it stops syncing) and revoking its key (what it signs stops counting).

- **One list: People and computers.** Each person, with their role and actions (admins: Make
  admin/member, Take out…, which takes their computers out too), and under them their computers:
  this one as *this computer*, the others with how they are connected. Computers no identity here
  says whose (none vouched for yet, or with no policy yet: all of them) are listed apart, under
  *Other computers*.
- **Lost or no longer used…**, on each computer: for its own person, admin or not, and for admins.
  It removes the device. One's own: its signing key revoked too, where this computer keeps one's
  identity (with its cutoff, so what it signed before still counts); otherwise the app says to
  revoke it from a computer that has the identity.
- **Devices take a removal** from an admin's device, or from a device of the same person as the
  device removed (as their signing keys' vouches say). The workspace's new secret that goes with a
  removal is any member's to make now (`secret` records are no longer for admins alone): without
  that, a member's removal of their own computer would leave it able to find the others.
- **Email checks wait for a server.** Workspace settings show *Email checked by* only once the
  workspace names a verifier; naming the first is under its *Advanced* (admins). The invite
  dialog's email field, and Settings › You's email and escrow, likewise show only once there is
  one (or an address checked).
