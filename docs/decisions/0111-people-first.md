# 0111 · People, each with a view of their own

**Status: built.** Changes Workspace settings' **People and computers**
([0068](0068-people-and-their-computers.md)) and where a server is removed and blocked
([0099](0099-servers.md)). What removing and blocking do is unchanged; where they are, and what
they are called, is not.

The owner's direction, first:

> "Please clean up the workspaces setting pane. it's really messy. For most situations the important
> thing is the users, not the specific devices. […] The "permanently block" option should be hidden
> deeper somehow."

and then, of a first pass (people on one line each, computers in a disclosure, blocking in a section of
its own):

> "This still seems overly complicated, and that's reflected in the settings panel. In the Workspace
> People section, list every user (sorted by user type). Clicking on the user should give a new view
> showing details, including all of their devices. There should also be a button for removing the user.
> Don't have a button for removing the user from the main workspace settings pane. That will be
> misclicked. Each device should also have a button to indiciate that it is lost or stolen. This blocks
> that signing key. Remove the "Computers: x of X devices online" disclosure. That's redundant. Also
> remove the lost or stolen computers and servers section. That inside the specific user/server
> references. Change the name of "Workspace groups" to just "Groups"."

## What it is

- **People**: everyone in the workspace, by kind (the owner, admins, members, then servers; by name
  within each), one line each: their name, their kind, a tag where a computer of theirs runs a Kuraa
  that does not sync with this one, whether they are online (any of their computers online, or reached
  through another; else when one was last seen), and ›. Nothing on the list changes anything. Beneath
  it, **Invite people…** (admins) and **Add a server…** (the owner); recent removals, closed; and,
  rarely, computers known to be no one's.
- **A person's view**, opened by their line, in the section's place, with *‹ Workspace* back: their
  role (a menu for whoever may change it, the owner's role handed over from it, asking first), whether
  they are online, what their role means, and their **Computers**, each with how it is connected and
  **Lost or stolen…** for whoever may say so (the computer's own person; an admin; the owner, for an
  admin's). This computer is there too, with **Rename…**. Beneath, set apart by a line, **Remove from
  workspace…** for whoever may remove them, with what it does: their computers stop syncing here; they
  can be invited back; a lost or stolen computer is said so beside it instead, and they stay in.
- **A server's view**, the same: what a server is, its device here, **Remove from workspace…** (it can
  be invited back), and beneath it **Block this server's access…**, both the owner's. A server is not
  lost or stolen; its key goes astray ("A server isn't normally "stolen", its key just goes rogue", as
  the owner put it), so its blocking is named for what it does, and set beside removing it.
- **Lost or stolen…** blocks that computer's signing key here, for good (a `drop`, 0072), as **Block
  this server's access…** does the server's key: each question says to use it only if someone else may
  have the key, and what follows.
- With no policy yet, there are no people to list: the computers are, with **Rename this computer…**.
- **Groups**, no longer *Workspace groups*.
- **The two ways out**, at the end of Workspace settings, each with what it does beneath it:
  - **Leave this workspace…**: you are taken out (a `revoke` of yourself, which the policy lets
    anyone make), on all your computers, and everyone is told; you keep your copy, and someone can
    invite you back. Not the owner, who gives the role to someone first: the button says so, and is
    shut until then.
  - **Remove this device from this workspace…**, no longer *Remove from this list…* (nor, briefly,
    *Stop using on this computer…*): local, as before. This computer stops syncing the workspace and
    takes it off its workspaces; the folder stays, and can be added again; no one else is told, and you
    stay in the workspace, this computer shown to the others as offline. Where the host lets
    workspaces be taken off its list (the app's own).
  The owner asked for these two names, *Remove workspace* being wrong as the files stay.
- Removing a person said as it is: they can be invited back (a person taken out is a `revoke`, and a
  new link lets them in again, their cutoff no longer counting). It said their devices were removed for
  good.

## What can be removed, and what blocked

Each person has an identity, a signing key on each computer, and a device key for each copy of a
workspace; a server has a signing key, which is the server, and a device key for each workspace
(0035, 0099; servers get no identity for now: a server is one machine, and an identity kept on it
would be taken with it).

| | Remove | Lost or stolen (block) |
| --- | --- | --- |
| A person (their identity) | yes: out, with their computers; invited back by a new link | no: an identity stolen is recovered by its person (its recovery key) |
| A person's computer (its signing key) | no: a computer is in as its person is | yes: its key blocked here; the person stays in |
| A server (its key) | yes: out; invited back by a new link | yes: its key blocked here; a new key is a new server, added again |
| A copy of a workspace (its device key) | no: deleted where it is, if no longer wanted | no: a computer holds one copy of a workspace, so blocking the computer here is blocking it |

Remove answers *who belongs*, and can be undone; blocking answers *is this key still in the right
hands*, and cannot. A computer no longer used, wiped, need not be blocked: it stays offline in its
person's view.

## How

- `peopleView.ts`: the list's and the views' rules (the order, whether someone is online, how a
  computer is connected, who may change a role, remove, or say a computer is lost or stolen).
- `DevicesSection.vue`: the list. `MemberView.vue`: a person's or server's view (`removePerson`,
  `removeServer(key)`, `removeDevice`, `removeServer(key, true)`, `setRole`, `makeOwner`,
  `renameDevice`). `SettingsWorkspace.vue` shows a view in the section's place, the rest kept, hidden.
- Strings: `S.keys` (*Lost or stolen…*, its questions); `S.people.removeFromWorkspace`, `removeAbout`,
  `removeAsk`, `removal` (*removed*, *blocked*); `S.servers.removeFromWorkspace`; `S.rules.groups`;
  `S.menu.removeWorkspace`, `S.app.removeWorkspace`. Gone: *Key lost or stolen…*, *Lost or no longer
  used…*, the Computers disclosure and its count.

## Not yet

- Folding away computers not seen for months, in a person's view.
