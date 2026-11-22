# 0067 · A document's permissions, from its ⋯ menu

> Adds to [0066](0066-permissions-without-a-centre.md): where its rules and audiences are set.
> What they are, who may set them and how they are kept are as there.

The owner's direction:

> "In addition to the centrally defined rules framework for permissions, make it possible to
> change permissions from the document's ... menu."

Rules were set only in Workspace settings › Who can change what (a path and who), and who reads a
file from **Who can read…**. A document's own permissions are now in one dialog, **Permissions…**,
in its ⋯ menu and its right-click menu (where the workspace is shared with other devices):

- **Who can read it**: everyone in the workspace, only you, or people and groups (with you), as
  **Who can read…** was (it is gone, folded in here). Whoever may change the file says.
- **Who can change it**: *as its folder or the workspace says* (no rule of its own; what that is
  shown beside it: the most specific rule holding the file, or anyone), only you, or people,
  groups and the workspace's admins. Either of the last two is a rule for exactly this file, which
  counts over its folder's and the workspace's; the first takes the file's own rule away. Only the
  workspace's admins may make rules (0066), so only they can change this part; anyone else sees who
  can change the document and by which rule, and that admins say.
- One **Save** makes what changed: the rule, then the move to another audience.

The rules made here are the same rules as those of Workspace settings, which still lists them all
and is where folders' and the whole workspace's are set. A rule names a path: a file renamed keeps
no rule of its own (its old path's rule stays, naming nothing there).

`GET /api/access` says, besides, the rule's entries as the policy names them (`rule.who`) and
whether this person may make rules (`admin`), for the dialog.
