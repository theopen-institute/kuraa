# 0069 · Permissions on files and folders, one model for reading and changing

*Since [0078](0078-restrictive-wins.md):* no email checks; permissions made at the same time on one path count narrowed (what both name).

> Changes how 0066's write rules and audiences are set and kept ([0066](0066-permissions-without-a-centre.md),
> [0067](0067-permissions-from-the-document.md)). Who may set what, how devices hold to it, spaces as
> how reading is kept: as before.

The owner asked whether permissions are better defined centrally or file by file, and, after a
review, to improve them as it suggested: permissions attached to files and folders, inherited down
the tree, with a central list as an overview. The review found two models (write rules by path,
inherited by folder; read audiences per file only), rules lost on a rename, rules about private
files naming them to every member, new files in a private place made readable by everyone, no
overview, and contradictions unsaid. And a bug: renaming a file of a space committed it, at its
new path, onto the workspace's own branch, where everyone has it.

## One kind of permission

A `perm` operation gives a file or folder its permission: who may change it (`write`), and for a
folder who reads what is in it (`read`, an audience). Either may be absent; with neither, the
permission is gone. For each, the nearest up the tree counts (the file, each folder it is in, the
whole workspace: `pathsAbove`). `rule` operations, as made before, are the same as a perm's
`write`. Only the workspace's admins make perms.

- A **file's** readers are still its space (moving it there); whoever may change it says.
- A **folder's** read audience is who reads what is in it: a file made in it goes straight into
  that audience's space (made for it if none has it), never onto the workspace's own branch (the
  app's New file and New folder); setting it moves the files in it that read as it did (who read
  them was who read the folder) to the new audience; a file moved into another folder, that read
  as its old one did, reads as its new one does.

## Private paths by their hash

A permission about something private (a file in a space; a folder with a read audience; anything
under one) names its path by a hash (`h:<sha256>` of the workspace and the path). Every device
matches a path's own hash when it looks for a permission; those who know the path (who hold the
space, or see the folder) see it as the path, others only that there is a permission and whom it
names. A guessed path can be checked against a hash: hidden, not secret. It is chosen when the
permission is set, and changes (plain to hashed, or back) when what makes it private does.

## Permissions go with what they are on

A rename or move keeps files of spaces in their spaces, at the new path (a commit there, before the
workspace's own: the bug above), and takes the moved path's own permissions, and those of what is
in a moved folder, to the new path, hashed as they were. Only an admin can carry permissions, so a
move by anyone else of something with permissions of its own is refused, saying why, rather than
leaving them on a path where nothing is.

## Where they are shown and set

- **Permissions…** on a file (its ⋯ menu, its right-click menu) and on a folder (its right-click
  menu): who can read it (a file: everyone, only you, people and groups; a folder: as the folder
  above says, only you, people and groups) and who can change it (as the folder above says, only
  you, people, groups, admins), each saying what following the folder above would mean. Groups
  are offered first, then the admins, then people. A choice that lets someone change what they
  could not read is said before saving. `GET`/`POST /api/permissions`.
- **The file list** marks a file or folder fewer read (a lock) and one fewer may change (a pen),
  each saying whom.
- **Workspace settings › Permissions** lists every permission: the whole workspace's (with
  Change…), then each file's and folder's (with Change…, which opens its Permissions…; a private
  one this device cannot see, as such), and a path to set one for. Groups and email checks are
  below it.

## Not yet

Permissions for files made other than from the app (another editor, a render) in a private folder:
they are the workspace's until moved. A folder read by fewer, renamed by its admin, moves its
files' space entries and its permission, but not the spaces themselves (who reads them stays).
