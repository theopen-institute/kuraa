# 0070 · An owner, above the admins

> Changes who makes admins in [0066](0066-permissions-without-a-centre.md) (step 2: every admin had
> full control) and who removes an admin's computers ([0068](0068-people-and-their-computers.md)).
> Everything else admins do is as before.

The owner's direction:

> "Create an owner role above admin. Only owners can assign admin. Owners can make someone else the
> owner by giving up their role."

- **One owner per workspace**, who is also an admin. A workspace made since 0066 has the admin its
  genesis names (whoever made it) as its owner. One from before (whose legacy geneses made
  everyone an admin) has as its owner the admin whose seal sealed them: the first to make an
  admin's change (0066). Until a workspace from before has an owner, its admins are equal, as they
  were, and 0066's rules for admins taking each other out at once still apply there.
- **Only the owner makes someone an admin, makes an admin a member, or takes an admin out** of the
  workspace, and only the owner's invite links may make admins (a link's grant for the
  workspace as admin counts only from the owner). Admins still invite members, take members out,
  make groups and rules, and say who reads and changes what. An admin may still leave.
- **An admin's computer, or the owner's,** is removed only by the owner, or by its own person
  (devices take such a removal only so: `adminDevices`, `assigners` in a device's standing).
- **The owner stays.** They are never made a member or taken out, and do not leave. They give the
  role to someone in the workspace (an `owner` operation, theirs alone to make), who becomes an
  admin if they were not, and the owner; the former owner stays an admin.
- **Where it shows.** People list the owner as *owner*. Make admin / Make member, and Take out…
  for admins, are the owner's; the owner has **Make owner…** on everyone else, saying they give up
  the role. The invite dialog offers to make admins only to the owner. CLI: `kuraa-host owner
  <person>`; `people` says who the owner is. HTTP: `POST /api/peers/owner/<id>`.

Losing the owner's identity is what recovery and trustees (0066, steps 1 and 6) are for: the
role belongs to the identity, not to a key.
