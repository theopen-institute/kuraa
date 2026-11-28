# 0107 · People first; blocking a key set apart

**Status: built.** Changes Workspace settings' **People and computers**
([0068](0068-people-and-their-computers.md)) and how a server is blocked there
([0099](0099-servers.md)). What removing and blocking do is unchanged; where they are, and what
they are called, is not.

The owner's direction:

> "Please clean up the workspaces setting pane. it's really messy. For most situations the important
> thing is the users, not the specific devices. Isn't that true? Perhaps devices should be hidden in a
> sub-menu or a disclosure triangle? Also, don't show the "key lost or stolen" button by default for
> servers. Instead, just show remove. The "permanently block" option should be hidden deeper somehow.
> […] In either case, the full "block" functionality should be set off to a different location in
> the settings."

## What it is

- **People**, one line each: their name, their role (a menu for whoever may change it, as before),
  whether they are online (any of their computers online, or reached through another; else when one
  was last seen), a tag where a computer of theirs runs a Kuraa that does not sync with this one, and
  **Remove…** for whoever may take them out. **Remove…** is no longer red: the question it asks is.
- **Servers** beneath, each with **Remove…** alone (taken out; invited back with **Add a server…**).
  **Invite people…** and **Add a server…** side by side beneath them.
- **Computers**, a disclosure beneath, closed: *Computers · 2 of 4 other devices online*. In it, *You
  are on …*, each person's computers with how each is connected, computers known to be no one's, and
  **Rename this computer…**. Where the workspace has no policy yet, there are no people to list, and
  it is open.
- **Recent removals**, a disclosure beneath, closed, where there are any.
- **Lost or stolen computers and servers**, a section of its own near the end of Workspace settings
  (after Permissions, before Details), closed, shown only to someone who may block something: the
  computers they may block (their own; anyone's, for an admin; an admin's, for the owner) and, for the
  owner, the servers, each with **Block…**. What blocking does is said above them, and in each
  question, with *Use this only if it is lost or stolen*.
- Removing a person said as it is: *Their computers stop syncing with everyone here; they keep their
  copy of everything up to now. You can invite them back later.* It said their devices were removed
  for good; they are not (a person taken out is a `revoke`, and a new link lets them in again, their
  cutoff no longer counting).
- Smaller: Permissions' *Everything* and *No file or folder has permissions of its own* no longer
  say the same sentence twice; a new group's first-admin menu says what it is for until one is
  chosen.

## Why: removing and blocking are different things

Asked whether blocking a key belongs with removing a person, since people get a new key each time
they join while a server keeps one key for all its workspaces:

- **A person is removed by their identity, not a key.** Removing someone is a `revoke` of the person;
  no key is blocked, and they can be invited back, from the same computers.
- **Each computer has one signing key for all its workspaces, as each server does** (0035, 0099). What
  is new at each join is the workspace's device key, which the computer's key signs for. A thief with
  the computer has its signing key, and could make new device keys with it, so a lost computer is
  shut out by its signing key.
- **Blocking (a `drop`) is for this workspace only**: the computer or server goes on syncing with its
  other workspaces. But it can never sync with this one again with that key, and since the key is
  the same for all its workspaces, coming back here takes a new key, which for a server means joining
  each of its workspaces again with it.

So blocking is for a key someone else may have, not for taking someone out: it is set apart, and
**Remove…**, which can be undone, is the one action beside each person and server. A computer no
longer used need not be blocked: it is offline, in Computers.

## How

- `DevicesSection.vue`: the people's lines (`stateOf`: online, through, last seen, from their
  computers; `kuraaOf`), servers with **Remove…** only, the Computers and Recent removals disclosures.
- `KeysSection.vue`: the blocking section, closed (`removeDevice`, `removeServer(key, true)`), read
  again every few seconds, as People is, since who may block what changes with roles.
- Strings: `S.keys`; `S.devices.computers`, `computersSummary`; `S.people.removeAsk`, `removal`
  (*removed*, *blocked*); `S.rules.anyone`. Gone: *Lost or no longer used…*, *Key lost or stolen…*.

## Not yet

- Removing a computer no longer used, from Computers, without blocking its key (there is no
  operation for that yet: a computer is in as its person is, 0072).
