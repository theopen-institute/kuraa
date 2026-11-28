# 0106 · The owner, and the workspace's servers, read everything

**Status: built.** Changes who reads a space ([0066](0066-permissions-without-a-centre.md),
[0072](0072-ranks-devices-and-changes-not-kept.md)), who changes a space's readers, and what a server
reads ([0099](0099-servers.md)). [0073](0073-encrypted-spaces.md) (spaces a device holds without
reading them) stays proposed for when servers that do not read are needed.

The owner's direction, asked how servers should treat files in spaces:

> "What about just trusting servers right now, and giving them default access to all spaces. […] I
> know that this gives the server access to people's "private" files, but these servers are intended
> to be self-hosted anyway, and the owner always has control. In the future, we can add encryption if
> private servers are needed."

and then, of a private option:

> "I think, right now, I don't want an "only you" option. If people want files that are completely
> private, they should control those files in a space they own. Ultimately, the owner has control
> over the space. In the future, we may implement server-owned workspaces, federated workspaces, or
> mutli-owner workspaces, but for now I think the idea that owner=control is simple and sensible."

Told that, by the policy, an admin could already add themselves to any space and be sent its whole
history while the app said *Only you*, the owner asked for all of it: the owner reads everything, servers
read everything, no *Only you*, and only a space's maker or the owner changes its readers.

## What it is

- **The owner reads every space**, whatever its audience says. When the owner's role passes to someone
  else (`owner`), so does this: the new owner's devices are sent every space and its history, and the
  one before reads what their audiences give them.
- **The workspace's servers read every space**, with no setting: a server is the owner's computer that
  is always on. A space's history now reaches a server, which holds it, merges it as it merges the
  workspace's branches (0099) and passes it on, so two readers who are never online at once still get
  each other's work. A server taken out reads nothing, as before.
- **Only whoever made a space, or the owner, changes who reads it.** Before, any admin could, and so
  could read any space by adding themselves. A space made by two at once has no maker: only the owner
  changes it. An admin still says who reads a *folder*, but once its space is there, changing who
  reads it is its maker's or the owner's. The Permissions dialog says so where it is someone else's
  (*Who reads it is for whoever chose that, or the workspace's owner, to change*) and leaves it shut.
- **No *Only you*.** Who can read a file is everyone in the workspace, or people and groups chosen,
  always with you and never you alone (*Choose who reads it besides you. What is only yours belongs in
  a workspace of your own*); the host refuses an audience of its sender alone. A file read by one person
  from before is shown as theirs and the owner's. *Only you* stays for who may *change* something:
  that hides nothing.
- **Said where readers are said.** Who reads a file, in the file list, its readers line and the
  dialog, names the owner where its audience does not hold them (*You, Cy and the owner*); the dialog
  says who reads everything (*The workspace's owner reads everything in it*; to the owner, *As the
  workspace's owner, you read everything in it*). The texts that said no one else's device is sent a
  file now name the owner. **Servers are not named there:** a server works for the owner, who is in
  control, so who reads a file is said as the owner's; what a server reads is said where servers are
  (People and computers › Servers: *Like the owner, it reads everything in the workspace*), as the
  owner asked: "I don't think it's necessary to foreground the server so much […] since the server
  really "works for" the owner, who has full control."
- **A group's readers are its admins' to say.** A workspace's admins, and a group's own, put people in
  a group, themselves too; so choosing a group to read something is trusting whoever manages it. That
  is said where groups are offered (*A group's readers are whoever its admins put in it*), rather than
  ruled out: only the owner adding people to a group that reads a space would make groups depend on
  spaces, and harder to explain.

## Why

**Owner = control is already how it works.** An admin could change any space's audience, and whoever is
added is sent its history (0072). The owner, who makes and unmakes admins, could always reach any
space; the app's *Only you* was a promise the policy did not keep. Saying it plainly is more honest
than a privacy that holds until someone with the role looks.

**Reading, rather than may read.** A right the owner can use at any time, on record or not, protects no
one by being asked for first; reading by default means the owner is never locked out, the owner's
computers are a copy of everything, and the rule is one sentence. The cost: every space is on the
owner's computers too, more disk, and more held where a laptop is lost.

**Servers are self-hosted.** Whoever runs the computer a server is on reads what it holds: as a rule
the owner. Where it is someone else (a friend's machine, a hosting company), they are trusted with
everything in the workspace. Servers that hold without reading are 0073's, for later.

**Tightening admins** follows from owner = control: admins manage people and permissions, and with
0106 the owner sees everything anyway; an admin quietly adding themselves to someone's space is power
the model does not give them.

## How

- `Policy.mayRead`: a server reads the workspace's files and every space made; a person in the
  workspace reads a space its audience holds them in, or every space if they are the owner. What
  devices send each other follows from it (`hiddenRefs`, `spaceHeads`, `spaceAccess`), as do live
  rooms and what code run for a document may read (`readers`).
- `allowed` for `space`: changing a space's audience is its maker's or the owner's (`isOwner`), not any
  admin's. `Policy.mayChangeSpace` says the same for the host. Like every rule of the policy, this
  applies to the whole history as each device evaluates it: an admin's change of someone else's space
  made before 0106 no longer counts.
- `Peers.setAudience`, `setPermissions`: an audience of the sender alone refused; changing a space's
  readers that are not this person's to change, refused (`NotAllowed`); `PermissionsInfo.readersLocked`.
- `readersWords` (host): an audience in words, with the owner where it does not hold them (servers
  not named); `Policy.audienceHolds`.
- Every device must evaluate the policy alike, so this is a compatibility break: `PROTOCOL` 11 (a device
  still on 0.11 would count an admin's change of someone else's space, send them the space, and send
  neither the owner nor a server the spaces they now read), and the next release is 0.12.0.

## Not yet

- Later models of who controls a workspace: owned by a server, several owners, federated. With several
  owners, *the owner* here becomes the owners.
- Servers that hold spaces without reading them: 0073.
- The policy still names each space's audience to everyone in the workspace (0073's step 4).
